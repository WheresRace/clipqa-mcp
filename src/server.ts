import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { ClipQaConfig } from "./config.js";
import { MediaProcessor, regionFromCells } from "./media.js";
import { NodeCommandRunner } from "./process-runner.js";
import { Recorder } from "./recorder.js";
import { SessionStore } from "./session-store.js";
import { chooseBoundedInspectionTimestamps } from "./sampling.js";
import { listWindows } from "./windows.js";
import { listScreens } from "./backends.js";
import { analyzeMotion, compareVideos, estimateLag, indexVideo, motionSeries } from "./visual.js";
import { directoryBytes, deleteSession } from "./artifacts.js";
import { blenderOrbitScript, locateViews, orbitViews, robloxOrbitScript, type OrbitOptions } from "./orbit.js";
import { CHECKPOINTS, checklistText, scoreFindings, writeQaReport } from "./qa.js";
import type { QaEvent, Region, RecordingSession } from "./types.js";

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const errorResult = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

const imageContent = async (file: string) => ({ type: "image" as const, mimeType: "image/jpeg", data: (await fs.readFile(file)).toString("base64") });

const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(r => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, "Regions must fit inside the frame.");

const orbitShape = {
  azimuthSteps: z.number().int().min(4).max(36).default(8).describe("Views around the target per ring (8 = every 45°, 12 = every 30°)."),
  elevations: z.array(z.number().min(-89).max(89)).min(1).max(8).default([-30, 0, 30, 60, 89]).describe("Camera heights in degrees: negative looks up from below, 89 is top-down."),
  zoomLevels: z.array(z.number().min(.25).max(8)).min(1).max(3).default([1, 2.5]).describe("Camera distance divisors; 2.5 adds a real close-up pass with full render detail."),
  holdSeconds: z.number().min(.2).max(3).default(.6).describe("Time each view is held."),
  leadSeconds: z.number().min(0).max(5).default(1).describe("Extra hold on the first view so streaming/LOD can settle."),
  distanceScale: z.number().min(.5).max(4).default(1.3).describe("Multiplier on the framing distance; increase if the target is cropped."),
};

export function eventsNear(events: QaEvent[], seconds: number, window: number): string {
  return events.filter(e => Math.abs(e.timestampMs / 1000 - seconds) <= window).map(e => `${e.kind === "error" ? "⚠ " : ""}${e.label}`).join(" | ");
}

export function zoomRegion(input: { region?: Region; cell?: string; center?: { x: number; y: number }; factor?: number; gridColumns: number; gridRows: number }): Region | undefined {
  if (input.region) return input.region;
  if (input.cell) return regionFromCells(input.cell, input.gridColumns, input.gridRows);
  if (input.center) {
    const factor = input.factor ?? 3, size = 1 / factor;
    const clamp = (value: number) => Math.min(1 - size, Math.max(0, value - size / 2));
    return { x: clamp(input.center.x), y: clamp(input.center.y), width: size, height: size };
  }
  return undefined;
}

export function lagFromEvents(before: QaEvent[], after: QaEvent[]): { lagSeconds: number; label: string } | undefined {
  const ordered = [...after].sort((a, b) => (a.kind === "action" ? 0 : 1) - (b.kind === "action" ? 0 : 1) || a.timestampMs - b.timestampMs);
  for (const event of ordered) {
    const match = before.find(e => e.label === event.label);
    if (match) return { lagSeconds: (match.timestampMs - event.timestampMs) / 1000, label: event.label };
  }
  return undefined;
}

export async function createServer(config: ClipQaConfig): Promise<McpServer> {
  const runner = new NodeCommandRunner();
  const store = new SessionStore(config.dataDir);
  await store.initialize();
  await store.recoverInterrupted();
  const recorder = new Recorder(store, config.ffmpegPath, runner, config.ffprobePath);
  const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
  const server = new McpServer({ name: "clipqa-mcp", version: VERSION });
  const close = server.close.bind(server);
  server.close = async () => { await recorder.shutdown(); await close(); };
  server.server.onclose = () => { void recorder.shutdown(); };

  const completed = async (sessionId: string, action: string): Promise<RecordingSession> => {
    const session = await store.read(sessionId);
    if (session.state === "recording") throw new Error(`Stop the recording before ${action}.`);
    if (session.state !== "stopped") throw new Error(`This session is ${session.state}${session.state === "interrupted" ? "; call recover_session first" : ""}.`);
    return session;
  };

  server.registerTool("capture_status", {
    description: "Check installed capture backends and platform requirements before recording.", inputSchema: z.object({}),
  }, async () => { try { return textResult(await recorder.capabilities()); } catch (e) { return errorResult(e); } });

  server.registerTool("list_sources", {
    description: "List recordable windows on Windows/X11 or display sources on macOS. macOS capture includes the selected display, not just one app.", inputSchema: z.object({}),
  }, async () => { try { return textResult(process.platform === "darwin" ? await listScreens(config.ffmpegPath, runner) : await listWindows(runner)); } catch (e) { return errorResult(e); } });

  const videoLink = (file: string) => ({ type: "resource_link" as const, uri: pathToFileURL(file).href, name: path.basename(file), mimeType: ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "application/octet-stream", description: "Local video. Clients that support local media can display this file inline." });
  server.registerTool("recording_progress", {
    description: "Show recording status and a screenshot from the latest completed video segment. Optionally return a playable local preview without stopping recording. Live previews lag by about two seconds; saved previews persist until cleanup.",
    inputSchema: z.object({ sessionId: z.string().uuid(), includeVideo: z.boolean().default(false), lastSeconds: z.number().int().min(1).max(30).default(5) }),
  }, async ({ sessionId, includeVideo, lastSeconds }) => {
    try {
      const session = await store.read(sessionId);
      const preview = await recorder.preview(sessionId, includeVideo ? lastSeconds : 1);
      const elapsedSeconds = Math.max(0, (Date.parse(session.stoppedAt ?? new Date().toISOString()) - Date.parse(session.startedAt)) / 1000);
      const status = { sessionId, state: session.state, elapsedSeconds, ...(session.state === "recording" ? { remainingSeconds: Math.max(0, Math.round(session.maxSeconds - elapsedSeconds)) } : {}), maxSeconds: session.maxSeconds, bufferSeconds: session.bufferSeconds, events: session.events.length, bytesOnDisk: await directoryBytes(store.sessionDir(sessionId)), previewReady: Boolean(preview), note: "Saved recordings, previews and reports remain local until delete_session or cleanup_sessions removes them." };
      if (!preview) return textResult({ ...status, note: "No completed video segment yet. Retry in about two seconds." });
      const duration = await media.duration(preview.videoPath);
      const timestamp = await media.lastFrameTime(preview.videoPath);
      const screenshotPath = path.join(path.dirname(preview.videoPath), `progress-${randomUUID()}.jpg`);
      await media.extractFrame(preview.videoPath, timestamp, screenshotPath);
      return { content: [...textResult({ ...status, screenshotPath, screenshotRecordingSeconds: preview.offset + timestamp, ...(includeVideo ? { videoPath: preview.videoPath, videoDuration: duration, videoStartRecordingSeconds: preview.offset } : {}) }).content, await imageContent(screenshotPath), ...(includeVideo ? [videoLink(preview.videoPath)] : [])] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("wait_until_stable", {
    description: "Wait until an active recording stops changing (camera tween finished, loading done, animation settled), then return a screenshot. Uses completed two-second segments, so it reacts about two seconds late. Optional region limits the check to part of the frame.",
    inputSchema: z.object({ sessionId: z.string().uuid(), stableSeconds: z.number().min(.5).max(10).default(1), timeoutSeconds: z.number().min(2).max(120).default(20), threshold: z.number().positive().max(1).default(.02), region: region.optional() }),
  }, async ({ sessionId, stableSeconds, timeoutSeconds, threshold, region: crop }) => {
    try {
      const session = await store.read(sessionId);
      if (session.state !== "recording" || !recorder.isActive(sessionId)) throw new Error("wait_until_stable needs an active recording owned by this MCP process.");
      const began = Date.now();
      let lastScore = NaN;
      while (Date.now() - began < timeoutSeconds * 1000) {
        const preview = await recorder.preview(sessionId, stableSeconds + 2);
        if (preview) {
          const directory = path.dirname(preview.videoPath);
          try {
            const end = await media.lastFrameTime(preview.videoPath);
            const start = Math.max(0, end - stableSeconds);
            if (end > start) {
              const series = await motionSeries(config.ffmpegPath, preview.videoPath, start, end, 15, crop);
              lastScore = Math.max(...series.scores.slice(1), 0);
              if (end - start >= stableSeconds * .9 && lastScore < threshold) {
                const screenshot = path.join(store.sessionDir(sessionId), "stable", `${randomUUID()}.jpg`);
                await media.extractFrame(preview.videoPath, end, screenshot);
                return { content: [...textResult({ stable: true, waitedSeconds: (Date.now() - began) / 1000, recordingSeconds: Number((preview.offset + end).toFixed(3)), maxChangeScore: lastScore, screenshotPath: screenshot }).content, await imageContent(screenshot)] };
              }
            }
          } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return textResult({ stable: false, waitedSeconds: (Date.now() - began) / 1000, lastChangeScore: Number.isFinite(lastScore) ? lastScore : null, note: "Still changing at the timeout. Raise threshold, use a region that excludes animated UI, or extend timeoutSeconds." });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("get_clip", {
    description: "Return the local path and video resource link for a saved recording. For an active recording, request recording_progress with includeVideo instead. Ask the client to render the absolute path inline when supported.",
    inputSchema: z.object({ sessionId: z.string().uuid() }),
  }, async ({ sessionId }) => {
    try {
      const session = await store.read(sessionId);
      if (session.state !== "stopped") throw new Error("The recording must be stopped successfully before accessing its saved video.");
      return { content: [...textResult({ sessionId, videoPath: session.videoPath, duration: await media.duration(session.videoPath), bytes: (await fs.stat(session.videoPath)).size, retention: "Kept until explicitly deleted." }).content, videoLink(session.videoPath)] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("recover_session", {
    description: "Rebuild the video of an interrupted or failed recording from the segments left on disk (for example after the MCP client was killed mid-recording).",
    inputSchema: z.object({ sessionId: z.string().uuid() }),
  }, async ({ sessionId }) => {
    try {
      const session = await recorder.recover(sessionId);
      return textResult({ ...session, duration: await media.duration(session.videoPath) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("delete_session", {
    description: "Permanently delete one stopped session and its video, screenshots, previews, indexes and reports. Use only when the user is done with the artifacts.",
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { destructiveHint: true },
  }, async ({ sessionId }) => { try { await deleteSession(store, sessionId); return textResult({ deleted: sessionId }); } catch (error) { return errorResult(error); } });

  server.registerTool("cleanup_sessions", {
    description: "Preview or delete completed sessions older than a chosen age. Defaults to dryRun=true so retained videos can be reviewed before deletion. Active recordings are excluded.",
    inputSchema: z.object({ olderThanHours: z.number().min(1).max(87600).default(24), dryRun: z.boolean().default(true) }),
    annotations: { destructiveHint: true },
  }, async ({ olderThanHours, dryRun }) => {
    try {
      const cutoff = Date.now() - olderThanHours * 3600000;
      const sessions = (await store.list()).filter(s => s.state !== "recording" && Date.parse(s.stoppedAt ?? s.startedAt) < cutoff);
      const selected = [];
      for (const session of sessions) {
        const bytes = await directoryBytes(store.sessionDir(session.id));
        if (!dryRun) await deleteSession(store, session.id);
        selected.push({ sessionId: session.id, bytes });
      }
      return textResult({ dryRun, sessions: selected, totalBytes: selected.reduce((sum, s) => sum + s.bytes, 0) });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool(
    "list_windows",
    {
      description: "List Windows or X11 application windows that can be recorded. On macOS use list_sources.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(await listWindows(runner));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "start_recording",
    {
      description:
        "Record a selected Windows/X11 window or explicitly selected macOS display. windowTitleContains matches part of a title (e.g. \"Roblox Studio\"). crop records only part of the window (e.g. the 3D viewport). logs tails log files and turns new lines into timed events. request stores what the user asked for, for qa_review. Optional bufferSeconds keeps only recent video. No input control or audio.",
      inputSchema: z.object({
        windowTitle: z.string().min(1).optional(),
        windowTitleContains: z.string().min(1).max(200).optional(),
        hwnd: z.string().regex(/^\d+$/).optional(),
        windowId: z.string().regex(/^(0x[\da-fA-F]+|[1-9]\d*)$/).optional(),
        display: z.string().max(200).optional(),
        screenIndex: z.number().int().min(0).optional(),
        backend: z.enum(["auto", "gfxcapture", "gdigrab", "x11grab", "avfoundation"]).default("auto"),
        bufferSeconds: z.number().int().min(5).max(600).optional(),
        maxWidth: z.number().int().min(320).max(3840).optional(),
        fps: z.number().int().min(1).max(60).default(30),
        maxSeconds: z.number().int().min(5).max(3600).default(120),
        drawMouse: z.boolean().default(false),
        encoder: z.enum(["auto", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"]).default("auto"),
        crop: region.optional().describe("Normalized region of the window to keep, applied before maxWidth."),
        logs: z.array(z.object({ path: z.string().min(1).describe("Absolute log file, or a directory to follow its newest .log/.txt (e.g. %LOCALAPPDATA%\\Roblox\\logs)."), pattern: z.string().max(500).optional().describe("Regex; only matching lines become events.") })).max(5).optional(),
        request: z.string().max(4000).optional(),
      }).refine((value) => Boolean(value.windowTitle || value.windowTitleContains || value.hwnd || value.windowId || value.screenIndex !== undefined), {
        message: "Provide windowTitle, windowTitleContains, hwnd, windowId, or screenIndex.",
      }),
    },
    async ({ windowTitle, windowTitleContains, hwnd, windowId, display, screenIndex, backend, bufferSeconds, maxWidth, fps, maxSeconds, drawMouse, encoder, crop, logs, request }) => {
      try {
        const target = {
          ...(windowTitle ? { title: windowTitle } : {}),
          ...(hwnd ? { hwnd } : {}),
          ...(windowId ? { windowId } : {}),
          ...(display ? { display } : {}),
          ...(screenIndex !== undefined ? { screenIndex } : {}),
        };
        const session = await recorder.start({ target, fps, maxSeconds, drawMouse, encoder, backend, ...(bufferSeconds ? { bufferSeconds } : {}), ...(maxWidth ? { maxWidth } : {}), ...(crop ? { crop } : {}), ...(windowTitleContains ? { titleContains: windowTitleContains } : {}), ...(logs ? { logs: logs.map(l => ({ path: l.path, ...(l.pattern ? { pattern: l.pattern } : {}) })) } : {}), ...(request ? { request } : {}) });
        return textResult({
          ...session,
          note: "Recording runs in a hidden background process and does not control the mouse or keyboard. Event timestamps are measured from the first captured frame.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool("attach_log", {
    description: "Follow a log file (or the newest .log/.txt in a directory) during an active recording. New lines matching pattern become timed events; lines starting with an ISO-8601 time use that time. Roblox Studio: path %LOCALAPPDATA%\\Roblox\\logs, pattern \"FLog::Output|FLog::Error|FLog::Warning\".",
    inputSchema: z.object({ sessionId: z.string().uuid(), path: z.string().min(1), pattern: z.string().max(500).optional() }),
  }, async ({ sessionId, path: target, pattern }) => {
    try {
      if (!path.isAbsolute(target)) throw new Error("Provide an absolute path.");
      return textResult({ sessionId, following: (await recorder.attachLog(sessionId, target, pattern)).file, note: "Only lines written after now are captured." });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool(
    "mark_event",
    {
      description: "Add an app-agnostic event or log entry. Supply timestampSeconds for recorded/imported clips; omitted timestamps use elapsed recording time.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        label: z.string().min(1).max(500),
        kind: z.enum(["action", "assertion", "error", "note"]).default("note"),
        data: z.record(z.string(), z.unknown()).optional(),
        timestampSeconds: z.number().min(0).optional(),
      }),
    },
    async ({ sessionId, label, kind, data, timestampSeconds }) => {
      try {
        const before = await store.read(sessionId);
        if (before.state === "recording" && before.ownerPid && before.ownerPid !== process.pid) throw new Error("Annotate active recordings through their owning MCP process.");
        if (before.state !== "recording") {
          if (timestampSeconds === undefined) throw new Error("Completed clips require timestampSeconds.");
          if (timestampSeconds >= await media.duration(before.videoPath)) throw new Error("Event timestamp must be inside the clip.");
        }
        const session = await store.update(sessionId, (current) => {
          if (current.state !== before.state) throw new Error("Recording state changed while adding the event. Retry with a timestamp relative to the saved clip.");
          if (current.events.length >= 10000) throw new Error("Session event limit reached (10,000).");
          const timestampMs = timestampSeconds === undefined ? Math.max(0, Date.now() - Date.parse(current.startedAt)) : timestampSeconds * 1000;
          return {
            ...current,
            events: [...current.events, { timestampMs, label, kind, ...(data ? { data } : {}) }],
          };
        });
        return textResult(session.events.at(-1));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "stop_recording",
    {
      description: "Stop recording and finalize the clip. In rolling mode saves only the last bufferSeconds and rebases retained event timestamps.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
    },
    async ({ sessionId }) => {
      try {
        return textResult(await recorder.stop(sessionId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool("import_clip", {
    description: "Copy a local video into a QA session for inspection and comparison on any platform. Does not record the screen.",
    inputSchema: z.object({ filePath: z.string().min(1), label: z.string().max(200).default("Imported clip"), request: z.string().max(4000).optional() }),
  }, async ({ filePath, label, request }) => {
    try {
      if (!path.isAbsolute(filePath)) throw new Error("Provide an absolute local video path.");
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error("Import a regular video file up to 2 GiB.");
      const duration = await media.duration(filePath);
      if (duration <= 0 || duration > 3600) throw new Error("Import a clip up to one hour long.");
      const extension = path.extname(filePath).toLowerCase();
      const id = randomUUID(), videoPath = path.join(store.sessionDir(id), `recording${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin"}`);
      const session = { id, state: "stopped" as const, target: { title: label }, startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), fps: 0, encoder: "imported", drawMouse: false, maxSeconds: duration, videoPath, events: [], ...(request ? { request } : {}) };
      await store.create(session);
      try { await fs.copyFile(filePath, videoPath); }
      catch (error) { await store.update(id, s => ({ ...s, state: "failed", error: String(error) })); throw error; }
      return textResult({ ...session, duration, note: "Imported video may contain audio or other content from its original recorder. ClipQA image tools return visual frames only." });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("compare_clips", {
    description: "Compare completed before/after clips. align=auto lines the runs up by a shared mark_event label, else by cross-correlating motion; pass beforeStart/afterStart to align manually. sampling=changes samples where either clip changes instead of evenly. Writes HTML/JSON reports with paired frames and difference maps. Changes are review candidates, not automatic bug diagnoses.",
    inputSchema: z.object({ beforeSessionId: z.string().uuid(), afterSessionId: z.string().uuid(), beforeStart: z.number().min(0).optional(), afterStart: z.number().min(0).optional(), align: z.enum(["auto", "events", "motion", "none"]).default("auto"), maxLagSeconds: z.number().min(.5).max(120).default(10), sampling: z.enum(["changes", "even"]).default("changes"), seconds: z.number().positive().max(600).optional(), samples: z.number().int().min(2).max(60).default(12), threshold: z.number().positive().max(1).default(.08), analysisWidth: z.number().int().min(160).max(1280).default(320), ignoreRegions: z.array(region).max(20).default([]) }),
  }, async ({ beforeSessionId, afterSessionId, beforeStart, afterStart, align, maxLagSeconds, sampling, seconds, samples, threshold, analysisWidth, ignoreRegions }) => {
    try {
      const [before, after] = await Promise.all([completed(beforeSessionId, "comparing"), completed(afterSessionId, "comparing")]);
      const [a, b] = await Promise.all([media.duration(before.videoPath), media.duration(after.videoPath)]);
      const alignment: Record<string, unknown> = { mode: "manual" };
      let lag = 0;
      const manual = align === "none" || (align === "auto" && (beforeStart !== undefined || afterStart !== undefined));
      if (!manual) {
        const byEvents = align !== "motion" ? lagFromEvents(before.events, after.events) : undefined;
        if (byEvents) { lag = byEvents.lagSeconds; Object.assign(alignment, { mode: "events", label: byEvents.label, lagSeconds: lag }); }
        else if (align === "events") throw new Error("No mark_event label appears in both clips. Use align=motion or manual offsets.");
        else {
          const [sa, sb] = await Promise.all([motionSeries(config.ffmpegPath, before.videoPath, 0, Math.min(a, 600), 10), motionSeries(config.ffmpegPath, after.videoPath, 0, Math.min(b, 600), 10)]);
          const estimate = estimateLag(sa.scores, sb.scores, 10, maxLagSeconds);
          Object.assign(alignment, { mode: "motion", ...estimate });
          if (estimate.confidence >= .3) lag = estimate.lagSeconds;
          else alignment.warning = "Motion alignment was not confident; clips compared from their starts. Add matching mark_event labels to both runs or pass offsets.";
        }
      }
      const startBefore = manual ? beforeStart ?? 0 : Math.max(0, lag), startAfter = manual ? afterStart ?? 0 : Math.max(0, -lag);
      const lastBefore = await media.lastFrameTime(before.videoPath), lastAfter = await media.lastFrameTime(after.videoPath);
      const duration = Math.min(seconds ?? 600, lastBefore - startBefore, lastAfter - startAfter);
      if (duration <= 0) throw new Error("The requested comparison ranges do not contain video.");
      let offsets: number[] | undefined;
      if (sampling === "changes") {
        const [ib, ia] = await Promise.all([indexVideo(config.ffmpegPath, before.videoPath, startBefore, startBefore + duration), indexVideo(config.ffmpegPath, after.videoPath, startAfter, startAfter + duration)]);
        const changeTimes = [...ib.changes.map(c => c.timestamp - startBefore), ...ia.changes.map(c => c.timestamp - startAfter)];
        const eventTimes = after.events.map(e => e.timestampMs / 1000 - startAfter);
        offsets = chooseBoundedInspectionTimestamps({ startSeconds: 0, endSeconds: duration, eventTimesSeconds: eventTimes, visualChangeTimesSeconds: changeTimes }, samples);
        if (offsets.length < 2) offsets = undefined;
      }
      const notes = (offsets ?? Array.from({ length: samples }, (_, i) => i * duration / samples)).map(o => eventsNear(after.events, startAfter + o, .25));
      const directory = path.join(store.sessionDir(afterSessionId), "comparisons", randomUUID());
      const report = await compareVideos(media, before.videoPath, after.videoPath, directory, { beforeStart: startBefore, afterStart: startAfter, seconds: duration, samples, threshold, ignore: ignoreRegions, analysisWidth, notes, ...(offsets ? { offsets } : {}) });
      return { content: [...textResult({ alignment, ...report }).content, { type: "text" as const, text: "Highest-scoring sample: before | after | difference. Timestamps are in previewSample." }, await imageContent(report.previewPath)] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool(
    "list_sessions",
    {
      description: "List recorded QA sessions and their status.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    },
    async ({ limit }) => { try { return textResult((await store.list()).slice(0, limit)); } catch (error) { return errorResult(error); } },
  );

  server.registerTool(
    "inspect_clip",
    {
      description: "Create and return a timestamped contact sheet for a completed recording. Frames are chosen around events and visual changes; event labels are printed under each frame. region limits analysis and frames to part of the video.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        startSeconds: z.number().min(0).default(0),
        endSeconds: z.number().positive().optional(),
        samples: z.number().int().min(2).max(24).default(12),
        indexFps: z.number().int().min(1).max(60).default(15),
        region: region.optional(),
      }),
    },
    async ({ sessionId, startSeconds, endSeconds, samples, indexFps, region: crop }) => {
      try {
        const session = await completed(sessionId, "inspecting it");
        const duration = await media.duration(session.videoPath);
        const lastFrame = await media.lastFrameTime(session.videoPath);
        const end = Math.min(endSeconds ?? lastFrame, lastFrame);
        if (startSeconds >= end) throw new Error("startSeconds must be before the end of the clip.");
        const index = await indexVideo(config.ffmpegPath, session.videoPath, startSeconds, end, indexFps, crop);
        const visualChanges = index.changes.map(change => change.timestamp);
        const eventTimes = session.events.map((event) => event.timestampMs / 1000);
        const timestamps = chooseBoundedInspectionTimestamps({ startSeconds, endSeconds: end, eventTimesSeconds: eventTimes, visualChangeTimesSeconds: visualChanges }, samples);
        const outputPath = path.join(store.sessionDir(sessionId), "inspections", randomUUID(), "overview.jpg");
        await media.createContactSheet(session.videoPath, outputPath, timestamps, { labels: timestamps.map(t => eventsNear(session.events, t, .25)), ...(crop ? { crop } : {}) });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ sessionId, duration, timestamps, visualChanges, eventTimes, outputPath, index, next: "Use zoom_frame to look closer at any frame, analyze_motion for fluidity, and qa_review for the full checklist." }, null, 2) },
            await imageContent(outputPath),
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_frames",
    {
      description: "Return frames from exact timestamps, resized to maxWidth (default 1280). region crops each frame to part of the video at native resolution before resizing.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        timestamps: z.array(z.number().min(0)).min(1).max(16),
        maxWidth: z.number().int().min(320).max(3840).default(1280),
        region: region.optional(),
      }),
    },
    async ({ sessionId, timestamps, maxWidth, region: crop }) => {
      try {
        const session = await completed(sessionId, "extracting frames");
        const duration = await media.duration(session.videoPath);
        const outside = timestamps.filter(t => t >= duration);
        if (outside.length) throw new Error(`Timestamps ${outside.join(", ")}s must be before clip duration ${duration}s.`);
        const requestId = randomUUID();
        const files = timestamps.map(t => path.join(store.sessionDir(sessionId), "frames", requestId, `${Math.round(t * 1000)}ms.jpg`));
        await media.extractFrames(session.videoPath, timestamps.map((timestamp, i) => ({ timestamp, outputPath: files[i]! })), maxWidth, crop);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify({ sessionId, duration, timestamps }, null, 2) }];
        for (const [i, timestamp] of timestamps.entries()) {
          const near = eventsNear(session.events, timestamp, .25);
          content.push({ type: "text", text: `Frame at ${timestamp.toFixed(3)} seconds${near ? ` (events: ${near})` : ""}` });
          content.push(await imageContent(files[i]!));
        }
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool("zoom_frame", {
    description: "Zoom into part of one frame at native resolution, upscaled and sharpened for close inspection (joints, hands, mesh seams, small UI). Call with showGrid=true (or no target) to get the frame with a labelled grid, then zoom with cell (\"C2\" or a range \"B2:C3\"), center+factor, or region. Zoom is digital: magnification above 1 interpolates; for real detail use an orbit close-up or record at a larger maxWidth.",
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      timestamp: z.number().min(0),
      cell: z.string().max(7).optional(),
      gridColumns: z.number().int().min(2).max(12).default(6),
      gridRows: z.number().int().min(2).max(12).default(4),
      center: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
      factor: z.number().min(1.25).max(16).default(3),
      region: region.optional(),
      outputWidth: z.number().int().min(320).max(2560).default(1280),
      sharpen: z.boolean().default(true),
      showGrid: z.boolean().default(false),
    }),
  }, async ({ sessionId, timestamp, cell, gridColumns, gridRows, center, factor, region: explicit, outputWidth, sharpen, showGrid }) => {
    try {
      const session = await completed(sessionId, "zooming");
      const duration = await media.duration(session.videoPath);
      if (timestamp >= duration) throw new Error(`Timestamp must be before clip duration ${duration}s.`);
      const directory = path.join(store.sessionDir(sessionId), "zoom", randomUUID());
      const target = zoomRegion({ ...(explicit ? { region: explicit } : {}), ...(cell ? { cell } : {}), ...(center ? { center } : {}), factor, gridColumns, gridRows });
      if (showGrid || !target) {
        const file = path.join(directory, "grid.jpg");
        await media.gridFrame(session.videoPath, timestamp, file, gridColumns, gridRows);
        return { content: [...textResult({ sessionId, timestamp, gridColumns, gridRows, gridPath: file, next: "Call zoom_frame with cell (e.g. \"C2\" or \"B2:C3\") to zoom into that area." }).content, await imageContent(file)] };
      }
      const file = path.join(directory, "zoom.jpg");
      const info = await media.zoomFrame(session.videoPath, timestamp, target, file, outputWidth, sharpen);
      return { content: [...textResult({ sessionId, timestamp, region: target, ...info, zoomPath: file, ...(info.magnification > 1.5 ? { note: `Upscaled ${info.magnification}x from ${info.sourceWidth}x${info.sourceHeight} source pixels; finer detail is interpolated, not recorded.` } : {}) }).content, await imageContent(file)] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("analyze_motion", {
    description: "Measure motion fluidity in a completed clip: hitches (frozen/repeated frames during movement), pops (sudden jumps far above the surrounding motion), and uneven speed. Returns a 0-100 fluidity score, flagged timestamps, and frames around the worst problem. Record at 30-60 FPS for meaningful results.",
    inputSchema: z.object({ sessionId: z.string().uuid(), startSeconds: z.number().min(0).default(0), endSeconds: z.number().positive().optional(), region: region.optional(), fps: z.number().int().min(5).max(120).optional() }),
  }, async ({ sessionId, startSeconds, endSeconds, region: crop, fps }) => {
    try {
      const session = await completed(sessionId, "analyzing motion");
      const report = await motionReport(session, startSeconds, endSeconds, crop, fps);
      const worst = report.pops[0]?.timestamp ?? report.hitches[0]?.start;
      if (worst === undefined) return textResult(report);
      const step = 1 / report.fps, last = await media.lastFrameTime(session.videoPath);
      const times = [worst - 2 * step, worst - step, worst, worst + step].map(t => Number(Math.min(last, Math.max(0, t)).toFixed(3)));
      const sheet = path.join(store.sessionDir(sessionId), "motion", randomUUID(), "worst.jpg");
      await media.createContactSheet(session.videoPath, sheet, times, { ...(crop ? { crop } : {}), labels: times.map(t => t === Number(worst.toFixed(3)) ? "flagged frame" : "") });
      return { content: [...textResult({ ...report, worstSheetPath: sheet }).content, await imageContent(sheet)] };
    } catch (error) { return errorResult(error); }
  });

  async function motionReport(session: RecordingSession, startSeconds: number, endSeconds: number | undefined, crop: Region | undefined, fps: number | undefined) {
    const last = await media.lastFrameTime(session.videoPath);
    const end = Math.min(endSeconds ?? last, last);
    if (startSeconds >= end) throw new Error("startSeconds must be before the end of the clip.");
    const fileFps = Math.round(await media.frameRate(session.videoPath));
    const rate = Math.min(fps ?? fileFps, 120);
    return analyzeMotion(await motionSeries(config.ffmpegPath, session.videoPath, startSeconds, end, rate, crop), session.fps || fileFps);
  }

  server.registerTool("orbit_plan", {
    description: "Plan a 360° inspection: every azimuth around the target at several heights (below, level, above, top-down) plus close-up passes. Returns a camera script to run in the app while ClipQA records (Roblox Luau for Studio MCP execute_luau, Blender Python, or a generic view list). Then call orbit_sheet with the same settings. ClipQA itself never moves the camera.",
    inputSchema: z.object({ engine: z.enum(["roblox", "blender", "generic"]).default("roblox"), target: z.string().min(1).max(300).default("selection").describe("Roblox: instance path like workspace.Rig, or \"selection\". Blender: object name, or \"selection\" for the active object."), ...orbitShape }),
  }, async ({ engine, target, ...shape }) => {
    try {
      const options: OrbitOptions = shape;
      const views = orbitViews(options);
      const totalSeconds = Number((options.leadSeconds + views.length * options.holdSeconds).toFixed(1));
      const script = engine === "roblox" ? robloxOrbitScript(target, views, options) : engine === "blender" ? blenderOrbitScript(target, views, options) : undefined;
      const steps = [
        "1. start_recording the app window at fps 30 (crop to the viewport if possible). For Roblox, logs: [{path: \"%LOCALAPPDATA%\\\\Roblox\\\\logs\", pattern: \"CLIPQA_ORBIT\"}] marks each view.",
        "2. mark_event label \"orbit:start\".",
        engine === "generic" ? "3. Move the camera through views in order, holding each for holdSeconds (first view for leadSeconds + holdSeconds), cutting directly between views." : `3. Run the script (${engine === "roblox" ? "Studio MCP execute_luau / command bar" : "Blender MCP execute_blender_code"}). It returns immediately and runs in the background, then restores the camera.`,
        `4. Wait about ${Math.ceil(totalSeconds + 1)} seconds (or wait_until_stable after that), then stop_recording.`,
        "5. orbit_sheet with the same azimuthSteps/elevations/zoomLevels/holdSeconds/leadSeconds.",
      ];
      return { content: [...textResult({ engine, views: views.length, totalSeconds, steps, viewList: views }).content, ...(script ? [{ type: "text" as const, text: script }] : [])] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("orbit_sheet", {
    description: "After recording an orbit_plan run, find each held view in the clip and return labelled contact sheets covering every angle and close-up, plus a timestamp per view for zoom_frame. Use the same orbit settings as orbit_plan.",
    inputSchema: z.object({ sessionId: z.string().uuid(), startSeconds: z.number().min(0).optional().describe("Where to start looking for the orbit; defaults to the last orbit event, else 0."), cutThreshold: z.number().min(.01).max(.5).default(.06), region: region.optional(), ...orbitShape }),
  }, async ({ sessionId, startSeconds, cutThreshold, region: crop, ...shape }) => {
    try {
      const session = await completed(sessionId, "building orbit sheets");
      const options: OrbitOptions = shape;
      const views = orbitViews(options);
      const orbitEvent = [...session.events].reverse().find(e => /orbit/i.test(e.label));
      const from = startSeconds ?? (orbitEvent ? Math.max(0, orbitEvent.timestampMs / 1000 - 1) : 0);
      const last = await media.lastFrameTime(session.videoPath);
      const span = options.leadSeconds + views.length * options.holdSeconds + 10;
      const end = Math.min(last, from + span);
      if (end <= from) throw new Error("The clip ends before the orbit search start.");
      const series = await motionSeries(config.ffmpegPath, session.videoPath, from, end, 30, crop);
      const located = locateViews(series.scores, series.fps, from, views.length, options, from, cutThreshold);
      const timestamps = located.timestamps.map(t => Math.min(t, last));
      const truncated = located.timestamps.filter(t => t > last).length;
      const directory = path.join(store.sessionDir(sessionId), "orbits", randomUUID());
      const sheets: string[] = [];
      for (let start = 0; start < views.length; start += 16) {
        const chunk = views.slice(start, start + 16);
        const file = path.join(directory, `sheet-${sheets.length + 1}.jpg`);
        await media.createContactSheet(session.videoPath, file, timestamps.slice(start, start + 16), { titles: chunk.map(v => `#${v.index + 1} ${v.label}`), labels: chunk.map((_, i) => `${timestamps[start + i]!.toFixed(2)}s`), columns: 4, ...(crop ? { crop } : {}) });
        sheets.push(file);
      }
      const table = views.map((v, i) => ({ view: v.index + 1, label: v.label, azimuth: v.azimuth, elevation: v.elevation, zoom: v.zoom, timestamp: timestamps[i] }));
      const warnings = [...located.warnings, ...(truncated ? [`${truncated} views fall after the end of the clip; the recording stopped too early.`] : [])];
      return { content: [...textResult({ sessionId, anchorSeconds: located.anchor, matchedCuts: located.matchedCuts, warnings, sheets, views: table, next: "Check every sheet against the qa_review checklist. zoom_frame on any view's timestamp to look closer; record_finding with view set to the view label." }).content, ...await Promise.all(sheets.map(imageContent))] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("qa_review", {
    description: "Start a structured quality review of a completed clip: returns the checklist (body proportions, twisted meshes, pose vs request, fluidity, every-angle coverage, materials) with what to look for and how to verify each item, an event-aware contact sheet, and an automatic fluidity check. Then record_finding for every checkpoint and qa_report for the score.",
    inputSchema: z.object({ sessionId: z.string().uuid(), request: z.string().max(4000).optional().describe("What the user asked for, e.g. \"character waves with the left hand while standing on one foot\"."), startSeconds: z.number().min(0).default(0), endSeconds: z.number().positive().optional(), samples: z.number().int().min(4).max(24).default(12), region: region.optional() }),
  }, async ({ sessionId, request, startSeconds, endSeconds, samples, region: crop }) => {
    try {
      let session = await completed(sessionId, "reviewing it");
      if (request) session = await store.update(sessionId, s => ({ ...s, request }));
      const last = await media.lastFrameTime(session.videoPath);
      const end = Math.min(endSeconds ?? last, last);
      if (startSeconds >= end) throw new Error("startSeconds must be before the end of the clip.");
      const index = await indexVideo(config.ffmpegPath, session.videoPath, startSeconds, end, 15, crop);
      const timestamps = chooseBoundedInspectionTimestamps({ startSeconds, endSeconds: end, eventTimesSeconds: session.events.map(e => e.timestampMs / 1000), visualChangeTimesSeconds: index.changes.map(c => c.timestamp) }, samples);
      const sheet = path.join(store.sessionDir(sessionId), "qa", randomUUID(), "overview.jpg");
      await media.createContactSheet(session.videoPath, sheet, timestamps, { labels: timestamps.map(t => eventsNear(session.events, t, .25)), ...(crop ? { crop } : {}) });
      const motion = await motionReport(session, startSeconds, end, crop, undefined).catch(() => undefined);
      if (motion && motion.verdict !== "no motion" && !session.findings?.some(f => f.checkpoint === "motion.fluidity")) {
        const status = motion.verdict === "smooth" && !motion.warnings.length ? "pass" : motion.verdict === "choppy" ? "fail" : "unclear";
        const note = `auto: fluidity ${motion.fluidityScore}/100 (${motion.verdict}); ${motion.hitches.length} hitches, ${motion.pops.length} pops${motion.pops[0] ? ` (first pop at ${motion.pops[0].timestamp}s)` : ""}. ${motion.warnings.join(" ")}`.trim();
        session = await store.update(sessionId, s => ({ ...s, findings: [...(s.findings ?? []), { checkpoint: "motion.fluidity", status, ...(status === "fail" ? { severity: "major" as const } : {}), note, recordedAt: new Date().toISOString() }] }));
      }
      const progress = scoreFindings(session.findings);
      return { content: [{ type: "text" as const, text: checklistText(session.request) }, ...textResult({ sessionId, timestamps, motion: motion ?? null, progress, overviewPath: sheet }).content, await imageContent(sheet)] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("record_finding", {
    description: "Record the result of one review checkpoint (pass, fail or unclear) with a specific note. With timestampSeconds (and optionally region), a zoomed evidence image is saved into the report. Recording a checkpoint again replaces the earlier result.",
    inputSchema: z.object({ sessionId: z.string().uuid(), checkpoint: z.enum(CHECKPOINTS.map(c => c.id) as [string, ...string[]]), status: z.enum(["pass", "fail", "unclear"]), severity: z.enum(["blocker", "major", "minor"]).optional(), note: z.string().min(3).max(2000), timestampSeconds: z.number().min(0).optional(), view: z.string().max(120).optional(), region: region.optional() }),
  }, async ({ sessionId, checkpoint, status, severity, note, timestampSeconds, view, region: area }) => {
    try {
      const session = await store.read(sessionId);
      let evidencePath: string | undefined;
      if (timestampSeconds !== undefined && session.state === "stopped") {
        if (timestampSeconds >= await media.duration(session.videoPath)) throw new Error("timestampSeconds must be inside the clip.");
        evidencePath = path.join(store.sessionDir(sessionId), "qa", "evidence", `${checkpoint}-${randomUUID()}.jpg`);
        if (area) await media.zoomFrame(session.videoPath, timestampSeconds, area, evidencePath, 640, true);
        else await media.extractFrame(session.videoPath, timestampSeconds, evidencePath, 640);
      }
      const finding = { checkpoint, status, ...(status === "fail" ? { severity: severity ?? "major" } : severity ? { severity } : {}), note, ...(timestampSeconds !== undefined ? { timestampSeconds } : {}), ...(view ? { view } : {}), ...(area ? { region: area } : {}), ...(evidencePath ? { evidencePath } : {}), recordedAt: new Date().toISOString() };
      const updated = await store.update(sessionId, s => ({ ...s, findings: [...(s.findings ?? []), finding] }));
      const progress = scoreFindings(updated.findings);
      return textResult({ recorded: finding, progress: { score: progress.score, verdict: progress.verdict, checked: `${progress.checked}/${progress.of}`, remaining: progress.unchecked } });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("qa_report", {
    description: "Score the review: points per checkpoint (pass full, unclear half, fail none), verdict PASS / NEEDS WORK / FAIL (any blocker) / INCOMPLETE (unchecked items), and a standalone HTML/JSON report with evidence images.",
    inputSchema: z.object({ sessionId: z.string().uuid() }),
  }, async ({ sessionId }) => {
    try {
      const session = await store.read(sessionId);
      const result = await writeQaReport(session, path.join(store.sessionDir(sessionId), "qa", `report-${randomUUID()}`));
      return textResult(result);
    } catch (error) { return errorResult(error); }
  });

  return server;
}

export async function serve(config: ClipQaConfig): Promise<void> {
  const server = await createServer(config);
  await server.connect(new StdioServerTransport());
}
