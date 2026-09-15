import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MediaProcessor } from "./media.js";
import { NodeCommandRunner } from "./process-runner.js";
import { Recorder } from "./recorder.js";
import { SessionStore } from "./session-store.js";
import { chooseBoundedInspectionTimestamps } from "./sampling.js";
import { listWindows } from "./windows.js";
import { capabilities, listScreens } from "./backends.js";
import { compareVideos, indexVideo } from "./visual.js";
import { directoryBytes, deleteSession } from "./artifacts.js";
const textResult = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const errorResult = (error) => ({
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});
export async function createServer(config) {
    const runner = new NodeCommandRunner();
    const store = new SessionStore(config.dataDir);
    await store.initialize();
    await store.recoverInterrupted();
    const recorder = new Recorder(store, config.ffmpegPath, runner, config.ffprobePath);
    const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
    const server = new McpServer({ name: "clipqa-mcp", version: "0.2.1" });
    const close = server.close.bind(server);
    server.close = async () => { await recorder.shutdown(); await close(); };
    server.server.onclose = () => { void recorder.shutdown(); };
    server.registerTool("capture_status", {
        description: "Check installed capture backends and platform requirements before recording.", inputSchema: z.object({}),
    }, async () => { try {
        return textResult(await capabilities(config.ffmpegPath, runner));
    }
    catch (e) {
        return errorResult(e);
    } });
    server.registerTool("list_sources", {
        description: "List recordable windows on Windows/X11 or display sources on macOS. macOS capture includes the selected display, not just one app.", inputSchema: z.object({}),
    }, async () => { try {
        return textResult(process.platform === "darwin" ? await listScreens(config.ffmpegPath, runner) : await listWindows(runner));
    }
    catch (e) {
        return errorResult(e);
    } });
    const videoLink = (file) => ({ type: "resource_link", uri: pathToFileURL(file).href, name: path.basename(file), mimeType: { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" }[path.extname(file).toLowerCase()] ?? "application/octet-stream", description: "Local video. Clients that support local media can display this file inline." });
    server.registerTool("recording_progress", {
        description: "Show recording status and a screenshot from the latest completed video segment. Optionally return a playable local preview without stopping recording. Live previews lag by about two seconds; saved previews persist until cleanup.",
        inputSchema: z.object({ sessionId: z.string().uuid(), includeVideo: z.boolean().default(false), lastSeconds: z.number().int().min(1).max(30).default(5) }),
    }, async ({ sessionId, includeVideo, lastSeconds }) => {
        try {
            const session = await store.read(sessionId);
            const preview = await recorder.preview(sessionId, includeVideo ? lastSeconds : 1);
            const elapsedSeconds = Math.max(0, (Date.parse(session.stoppedAt ?? new Date().toISOString()) - Date.parse(session.startedAt)) / 1000);
            const status = { sessionId, state: session.state, elapsedSeconds, maxSeconds: session.maxSeconds, bufferSeconds: session.bufferSeconds, bytesOnDisk: await directoryBytes(store.sessionDir(sessionId)), previewReady: Boolean(preview), note: "Saved recordings, previews and reports remain local until delete_session or cleanup_sessions removes them." };
            if (!preview)
                return textResult({ ...status, note: "No completed video segment yet. Retry in about two seconds." });
            const duration = await media.duration(preview.videoPath);
            const timestamp = Math.max(0, Math.floor((duration - 1 / await media.frameRate(preview.videoPath)) * 1000) / 1000);
            const screenshotPath = path.join(path.dirname(preview.videoPath), `progress-${randomUUID()}.jpg`);
            await media.extractFrame(preview.videoPath, timestamp, screenshotPath);
            const data = (await fs.readFile(screenshotPath)).toString("base64");
            return { content: [...textResult({ ...status, screenshotPath, screenshotRecordingSeconds: preview.offset + timestamp, ...(includeVideo ? { videoPath: preview.videoPath, videoDuration: duration, videoStartRecordingSeconds: preview.offset } : {}) }).content, { type: "image", mimeType: "image/jpeg", data }, ...(includeVideo ? [videoLink(preview.videoPath)] : [])] };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("get_clip", {
        description: "Return the local path and video resource link for a saved recording. For an active recording, request recording_progress with includeVideo instead. Ask the client to render the absolute path inline when supported.",
        inputSchema: z.object({ sessionId: z.string().uuid() }),
    }, async ({ sessionId }) => {
        try {
            const session = await store.read(sessionId);
            if (session.state !== "stopped")
                throw new Error("The recording must be stopped successfully before accessing its saved video.");
            return { content: [...textResult({ sessionId, videoPath: session.videoPath, duration: await media.duration(session.videoPath), bytes: (await fs.stat(session.videoPath)).size, retention: "Kept until explicitly deleted." }).content, videoLink(session.videoPath)] };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("delete_session", {
        description: "Permanently delete one stopped session and its video, screenshots, previews, indexes and reports. Use only when the user is done with the artifacts.",
        inputSchema: z.object({ sessionId: z.string().uuid() }),
        annotations: { destructiveHint: true },
    }, async ({ sessionId }) => { try {
        await deleteSession(store, sessionId);
        return textResult({ deleted: sessionId });
    }
    catch (error) {
        return errorResult(error);
    } });
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
                if (!dryRun)
                    await deleteSession(store, session.id);
                selected.push({ sessionId: session.id, bytes });
            }
            return textResult({ dryRun, sessions: selected, totalBytes: selected.reduce((sum, s) => sum + s.bytes, 0) });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("list_windows", {
        description: "List Windows or X11 application windows that can be recorded. On macOS use list_sources.",
        inputSchema: z.object({}),
    }, async () => {
        try {
            return textResult(await listWindows(runner));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("start_recording", {
        description: "Record a selected Windows/X11 window or explicitly selected macOS display. Optional bufferSeconds keeps only recent video. No input control or audio.",
        inputSchema: z.object({
            windowTitle: z.string().min(1).optional(),
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
        }).refine((value) => Boolean(value.windowTitle || value.hwnd || value.windowId || value.screenIndex !== undefined), {
            message: "Provide windowTitle, hwnd, windowId, or screenIndex.",
        }),
    }, async ({ windowTitle, hwnd, windowId, display, screenIndex, backend, bufferSeconds, maxWidth, fps, maxSeconds, drawMouse, encoder }) => {
        try {
            const target = {
                ...(windowTitle ? { title: windowTitle } : {}),
                ...(hwnd ? { hwnd } : {}),
                ...(windowId ? { windowId } : {}),
                ...(display ? { display } : {}),
                ...(screenIndex !== undefined ? { screenIndex } : {}),
            };
            const session = await recorder.start({ target, fps, maxSeconds, drawMouse, encoder, backend, ...(bufferSeconds ? { bufferSeconds } : {}), ...(maxWidth ? { maxWidth } : {}) });
            return textResult({
                ...session,
                note: "Recording runs in a hidden background process and does not control the mouse or keyboard.",
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("mark_event", {
        description: "Add an app-agnostic event or log entry. Supply timestampSeconds for recorded/imported clips; omitted timestamps use elapsed recording time.",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            label: z.string().min(1).max(500),
            kind: z.enum(["action", "assertion", "error", "note"]).default("note"),
            data: z.record(z.string(), z.unknown()).optional(),
            timestampSeconds: z.number().min(0).optional(),
        }),
    }, async ({ sessionId, label, kind, data, timestampSeconds }) => {
        try {
            const before = await store.read(sessionId);
            if (before.state === "recording" && before.ownerPid && before.ownerPid !== process.pid)
                throw new Error("Annotate active recordings through their owning MCP process.");
            if (before.state !== "recording") {
                if (timestampSeconds === undefined)
                    throw new Error("Completed clips require timestampSeconds.");
                if (timestampSeconds >= await media.duration(before.videoPath))
                    throw new Error("Event timestamp must be inside the clip.");
            }
            const session = await store.update(sessionId, (current) => {
                if (current.state !== before.state)
                    throw new Error("Recording state changed while adding the event. Retry with a timestamp relative to the saved clip.");
                if (current.events.length >= 10000)
                    throw new Error("Session event limit reached (10,000).");
                const timestampMs = timestampSeconds === undefined ? Math.max(0, Date.now() - Date.parse(current.startedAt)) : timestampSeconds * 1000;
                return {
                    ...current,
                    events: [...current.events, { timestampMs, label, kind, ...(data ? { data } : {}) }],
                };
            });
            return textResult(session.events.at(-1));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("stop_recording", {
        description: "Stop recording and finalize the clip. In rolling mode saves only the last bufferSeconds and rebases retained event timestamps.",
        inputSchema: z.object({ sessionId: z.string().uuid() }),
    }, async ({ sessionId }) => {
        try {
            return textResult(await recorder.stop(sessionId));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("import_clip", {
        description: "Copy a local video into a QA session for inspection and comparison on any platform. Does not record the screen.",
        inputSchema: z.object({ filePath: z.string().min(1), label: z.string().max(200).default("Imported clip") }),
    }, async ({ filePath, label }) => {
        try {
            if (!path.isAbsolute(filePath))
                throw new Error("Provide an absolute local video path.");
            const stat = await fs.stat(filePath);
            if (!stat.isFile() || stat.size > 2 * 1024 ** 3)
                throw new Error("Import a regular video file up to 2 GiB.");
            const duration = await media.duration(filePath);
            if (duration <= 0 || duration > 3600)
                throw new Error("Import a clip up to one hour long.");
            const extension = path.extname(filePath).toLowerCase();
            const id = randomUUID(), videoPath = path.join(store.sessionDir(id), `recording${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin"}`);
            const session = { id, state: "stopped", target: { title: label }, startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), fps: 0, encoder: "imported", drawMouse: false, maxSeconds: duration, videoPath, events: [] };
            await store.create(session);
            try {
                await fs.copyFile(filePath, videoPath);
            }
            catch (error) {
                await store.update(id, s => ({ ...s, state: "failed", error: String(error) }));
                throw error;
            }
            return textResult({ ...session, duration, note: "Imported video may contain audio or other content from its original recorder. ClipQA image tools return visual frames only." });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "Regions must fit inside the frame.");
    server.registerTool("compare_clips", {
        description: "Compare completed before/after clips at aligned timestamps. Writes local HTML/JSON reports with paired frames and difference maps. Changes are review candidates, not automatic bug diagnoses.",
        inputSchema: z.object({ beforeSessionId: z.string().uuid(), afterSessionId: z.string().uuid(), beforeStart: z.number().min(0).default(0), afterStart: z.number().min(0).default(0), seconds: z.number().positive().max(600).optional(), samples: z.number().int().min(2).max(60).default(12), threshold: z.number().positive().max(1).default(.08), ignoreRegions: z.array(region).max(20).default([]) }),
    }, async ({ beforeSessionId, afterSessionId, beforeStart, afterStart, seconds, samples, threshold, ignoreRegions }) => {
        try {
            const [before, after] = await Promise.all([store.read(beforeSessionId), store.read(afterSessionId)]);
            if (before.state !== "stopped" || after.state !== "stopped")
                throw new Error("Both comparison sessions must be completed.");
            const [a, b] = await Promise.all([media.duration(before.videoPath), media.duration(after.videoPath)]);
            const duration = Math.min(seconds ?? 600, a - beforeStart, b - afterStart);
            if (duration <= 0)
                throw new Error("The requested comparison ranges do not contain video.");
            const directory = path.join(store.sessionDir(afterSessionId), "comparisons", randomUUID());
            const report = await compareVideos(media, before.videoPath, after.videoPath, directory, { beforeStart, afterStart, seconds: duration, samples, threshold, ignore: ignoreRegions });
            return { content: [...textResult(report).content, { type: "text", text: "Highest-scoring sample: before | after | difference. Timestamps are in previewSample." }, { type: "image", mimeType: "image/jpeg", data: (await fs.readFile(report.previewPath)).toString("base64") }] };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("list_sessions", {
        description: "List recorded QA sessions and their status.",
        inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    }, async ({ limit }) => textResult((await store.list()).slice(0, limit)));
    server.registerTool("inspect_clip", {
        description: "Create and return a timestamped contact sheet for a completed recording.",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            startSeconds: z.number().min(0).default(0),
            endSeconds: z.number().positive().optional(),
            samples: z.number().int().min(2).max(24).default(12),
            indexFps: z.number().int().min(1).max(60).default(15),
        }),
    }, async ({ sessionId, startSeconds, endSeconds, samples, indexFps }) => {
        try {
            const session = await store.read(sessionId);
            if (session.state === "recording")
                throw new Error("Stop the recording before inspecting it.");
            const duration = await media.duration(session.videoPath);
            const lastFrame = Math.max(0, Math.floor((duration - 1 / await media.frameRate(session.videoPath)) * 1000) / 1000);
            const end = Math.min(endSeconds ?? lastFrame, lastFrame);
            if (startSeconds >= end)
                throw new Error("startSeconds must be before the end of the clip.");
            const index = await indexVideo(config.ffmpegPath, session.videoPath, startSeconds, end, indexFps);
            const visualChanges = index.changes.map(change => change.timestamp);
            const eventTimes = session.events.map((event) => event.timestampMs / 1000);
            const timestamps = chooseBoundedInspectionTimestamps({
                startSeconds,
                endSeconds: end,
                eventTimesSeconds: eventTimes,
                visualChangeTimesSeconds: visualChanges,
            }, samples);
            const outputPath = path.join(store.sessionDir(sessionId), "inspections", randomUUID(), "overview.jpg");
            await media.createContactSheet(session.videoPath, outputPath, timestamps);
            const data = await fs.readFile(outputPath);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            sessionId,
                            duration,
                            timestamps,
                            visualChanges,
                            eventTimes,
                            outputPath,
                            index,
                        }, null, 2),
                    },
                    { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" },
                ],
            };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("get_frames", {
        description: "Return frames from exact timestamps, resized to maxWidth (default 1280).",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            timestamps: z.array(z.number().min(0)).min(1).max(16),
            maxWidth: z.number().int().min(320).max(3840).default(1280),
        }),
    }, async ({ sessionId, timestamps, maxWidth }) => {
        try {
            const session = await store.read(sessionId);
            if (session.state === "recording")
                throw new Error("Stop the recording before extracting frames.");
            const duration = await media.duration(session.videoPath);
            const content = [{ type: "text", text: JSON.stringify({ sessionId, duration, timestamps }, null, 2) }];
            const requestId = randomUUID();
            for (const timestamp of timestamps) {
                if (timestamp >= duration)
                    throw new Error(`Timestamp ${timestamp}s must be before clip duration ${duration}s.`);
                const file = path.join(store.sessionDir(sessionId), "frames", requestId, `${Math.round(timestamp * 1000)}ms.jpg`);
                await media.extractFrame(session.videoPath, timestamp, file, maxWidth);
                const data = await fs.readFile(file);
                content.push({ type: "text", text: `Frame at ${timestamp.toFixed(3)} seconds` });
                content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
            }
            return { content };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    return server;
}
export async function serve(config) {
    const server = await createServer(config);
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=server.js.map