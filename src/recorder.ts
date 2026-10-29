import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { CommandRunner } from "./process-runner.js";
import { conciseError } from "./process-runner.js";
import type { CaptureTarget, RecordingSession, Region } from "./types.js";
import { SessionStore } from "./session-store.js";
import { listWindows } from "./windows.js";
import { capabilities, captureInput, listScreens, type Backend, type Capabilities } from "./backends.js";
import { segmentArgs, pruneSegments, finalizeReplay, segmentFiles } from "./replay.js";
import { cropFilter } from "./media.js";
import { LogWatcher } from "./logs.js";

export type EncoderChoice = "auto" | "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf";

export interface StartRecordingOptions {
  target: CaptureTarget;
  fps: number;
  maxSeconds: number;
  drawMouse: boolean;
  encoder: EncoderChoice;
  backend?: Backend | "auto";
  bufferSeconds?: number;
  maxWidth?: number;
  crop?: Region;
  titleContains?: string;
  logs?: Array<{ path: string; pattern?: string }>;
  request?: string;
}

export function buildCaptureArgs(
  target: CaptureTarget,
  outputPath: string,
  options: Omit<StartRecordingOptions, "target" | "encoder"> & { encoder: string },
): string[] {
  const backend = options.backend === "auto" ? "gdigrab" : options.backend ?? "gdigrab";
  const encoderArgs: Record<string, string[]> = {
    libx264: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"],
    h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "24"],
    h264_qsv: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24"],
    h264_amf: ["-c:v", "h264_amf", "-quality", "speed", "-qp_i", "24", "-qp_p", "24"],
  };

  const shape = `${cropFilter(options.crop)}${options.maxWidth ? `scale='min(${options.maxWidth},iw)':-2,` : ""}`;
  const input = captureInput(backend, target, options.fps, options.drawMouse);
  if (backend === "gfxcapture" && shape) input[1] = input[1]!.replace(",pad=", `,${shape}pad=`);
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-progress", "pipe:1", "-stats_period", "0.2",
    "-y",
    ...input,
    "-t",
    String(options.maxSeconds),
    ...(backend === "gfxcapture" ? [] : ["-vf", `${shape}pad=ceil(iw/2)*2:ceil(ih/2)*2`]),
    "-an",
    ...(encoderArgs[options.encoder] ?? encoderArgs.libx264!),
    "-pix_fmt",
    "yuv420p",
    ...segmentArgs(path.dirname(outputPath), options.fps),
  ];
}

export async function selectEncoder(
  requested: EncoderChoice,
  ffmpegPath: string,
  runner: CommandRunner,
): Promise<string> {
  if (requested !== "auto") return requested;
  const result = await runner.run(ffmpegPath, ["-hide_banner", "-encoders"]);
  const available = result.stdout + result.stderr;
  for (const candidate of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
    if (!available.includes(candidate)) continue;
    const probe = await runner.run(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=0.1",
      "-frames:v",
      "1",
      "-c:v",
      candidate,
      "-f",
      "null",
      "-",
    ]);
    if (probe.code === 0) return candidate;
  }
  return "libx264";
}

// Wall-clock time of video t=0, from FFmpeg's progress report at the first encoded frame.
export function videoZeroFromProgress(progress: string, now: number, fps: number): number {
  const times = [...progress.matchAll(/out_time_us=(\d+)/g)];
  const frames = [...progress.matchAll(/frame=\s*(\d+)/g)];
  const outUs = times.length ? Number(times.at(-1)![1]) : NaN;
  if (Number.isFinite(outUs) && outUs > 0) return now - outUs / 1000;
  const frame = frames.length ? Number(frames.at(-1)![1]) : 1;
  return now - Math.max(0, frame - 1) * 1000 / fps;
}

export function rebaseEvents<T extends { timestampMs: number }>(events: T[], offsetSeconds: number, durationSeconds: number): T[] {
  return events.filter(e => e.timestampMs >= offsetSeconds * 1000 && e.timestampMs <= (offsetSeconds + durationSeconds) * 1000).map(e => ({ ...e, timestampMs: e.timestampMs - offsetSeconds * 1000 }));
}

export class Recorder {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly errors = new Map<string, string>();
  private readonly finished = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, LogWatcher[]>();
  private starting = false;
  private readonly fileQueues = new Map<string, Promise<unknown>>();
  private caps: Promise<Capabilities> | undefined;
  private readonly encoders = new Map<EncoderChoice, Promise<string>>();

  private async withFiles<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.fileQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.fileQueues.set(id, task);
    try { return await task; } finally { if (this.fileQueues.get(id) === task) this.fileQueues.delete(id); }
  }

  constructor(
    private readonly store: SessionStore,
    private readonly ffmpegPath: string,
    private readonly runner: CommandRunner,
    private readonly ffprobePath = "ffprobe",
  ) {}

  capabilities(): Promise<Capabilities> {
    this.caps ??= capabilities(this.ffmpegPath, this.runner).catch(error => { this.caps = undefined; throw error; });
    return this.caps;
  }

  private encoder(requested: EncoderChoice): Promise<string> {
    if (!this.encoders.has(requested)) this.encoders.set(requested, selectEncoder(requested, this.ffmpegPath, this.runner).catch(error => { this.encoders.delete(requested); throw error; }));
    return this.encoders.get(requested)!;
  }

  isActive(id: string): boolean { return this.active.has(id); }

  async start(options: StartRecordingOptions): Promise<RecordingSession> {
    if (this.active.size || this.starting) throw new Error("One recording at a time is supported to limit resource use.");
    this.starting = true;
    try {
    const caps = await this.capabilities();
    const backend = !options.backend || options.backend === "auto" ? caps.recommended : options.backend;
    if (!backend || !caps.available.includes(backend)) throw new Error(`Capture backend unavailable. ${caps.warnings.join(" ")}`);
    let target = { ...options.target };
    if (process.platform === "win32") {
      const needle = options.titleContains?.toLowerCase();
      const windows = await listWindows(this.runner);
      const matches = windows.filter(window => target.hwnd ? window.hwnd === target.hwnd : target.title ? window.title === target.title : needle ? window.title.toLowerCase().includes(needle) : false);
      if (matches.length !== 1) {
        const hint = matches.length > 1 ? ` Candidates: ${matches.slice(0, 8).map(w => `"${w.title}" (hwnd ${w.hwnd})`).join(", ")}.` : "";
        throw new Error(`Select one existing window with a unique title, title fragment, or HWND.${hint}`);
      }
      if (matches[0]!.minimized) throw new Error("The target is minimized and may not render frames. Restore it before recording; ClipQA will not change window focus.");
      target = { title: matches[0]!.title, hwnd: matches[0]!.hwnd };
    } else if (!target.title && !target.windowId && options.titleContains) {
      const match = (await listWindows(this.runner)).filter(w => w.title.toLowerCase().includes(options.titleContains!.toLowerCase()));
      if (match.length !== 1) throw new Error("Select one existing window with a unique title fragment.");
      target = { ...target, title: match[0]!.title, ...(match[0]!.windowId ? { windowId: match[0]!.windowId } : {}) };
    }
    if (backend === "x11grab" && !target.display && process.env.DISPLAY) target.display = process.env.DISPLAY;
    if (backend === "avfoundation" && !(await listScreens(this.ffmpegPath, this.runner)).some(screen => screen.screenIndex === target.screenIndex)) throw new Error("screenIndex must identify a display from list_sources, not a camera.");
    captureInput(backend, target, options.fps, options.drawMouse);
    for (const log of options.logs ?? []) {
      if (!path.isAbsolute(log.path)) throw new Error("Log paths must be absolute.");
      await fs.stat(log.path).catch(() => { throw new Error(`Log path not found: ${log.path}`); });
      if (log.pattern) new RegExp(log.pattern);
    }

    const id = randomUUID();
    const encoder = await this.encoder(options.encoder);
    const directory = this.store.sessionDir(id);
    const videoPath = path.join(directory, "recording.mp4");
    const session: RecordingSession = {
      id,
      state: "recording",
      target,
      startedAt: new Date().toISOString(),
      fps: options.fps,
      encoder,
      drawMouse: options.drawMouse,
      maxSeconds: options.maxSeconds,
      videoPath,
      events: [],
      backend,
      warnings: caps.warnings,
      ownerPid: process.pid,
      ...(options.bufferSeconds ? { bufferSeconds: options.bufferSeconds } : {}),
      ...(options.crop ? { crop: options.crop } : {}),
      ...(options.request ? { request: options.request } : {}),
    };
    await this.store.create(session);

    const args = buildCaptureArgs(target, videoPath, { ...options, backend, encoder });
    const child = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active.set(id, child);
    child.stdin.on("error", () => undefined);
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const wallTimer = setTimeout(() => { child.stdin.write("q\n"); forceStop = setTimeout(() => child.kill(), 5000); }, (options.maxSeconds + 5) * 1000);
    let pruning = Promise.resolve();
    const timer = options.bufferSeconds ? setInterval(() => {
      pruning = pruning.then(() => this.withFiles(id, () => pruneSegments(directory, options.bufferSeconds!))).catch(() => { child.kill(); });
    }, 1000) : undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.errors.set(id, `${this.errors.get(id) ?? ""}${chunk}`.slice(-8000));
    });
    child.once("error", (error) => { this.errors.set(id, error.message); });
    const ready = new Promise<number>((resolve, reject) => {
      let progress = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("No frames received within 10 seconds. Check target rendering and capture permissions.")); }, 10000);
      const onData = (chunk: Buffer) => {
        progress = (progress + chunk.toString()).slice(-4000);
        if (/frame=\s*[1-9]\d*/.test(progress) && /progress=/.test(progress)) { clearTimeout(timeout); child.stdout.off("data", onData); child.stdout.resume(); resolve(videoZeroFromProgress(progress, Date.now(), options.fps)); }
      };
      child.stdout.on("data", onData);
      child.once("close", () => { clearTimeout(timeout); reject(new Error(`Capture ended before producing frames: ${conciseError(this.errors.get(id) ?? "")}`)); });
    });
    this.finished.set(id, new Promise<void>(resolve => child.once("close", (code) => {
      clearTimeout(wallTimer); if (forceStop) clearTimeout(forceStop);
      if (timer) clearInterval(timer);
      void (async () => {
        await this.stopWatchers(id);
        await pruning;
        if (code !== 0) throw new Error(conciseError(this.errors.get(id) ?? `FFmpeg exited with code ${code}.`));
        const replay = await this.withFiles(id, () => finalizeReplay(directory, videoPath, options.bufferSeconds ?? options.maxSeconds, this.ffmpegPath, this.ffprobePath, this.runner));
        await this.store.update(id, current => ({ ...current, state: "stopped", stoppedAt: new Date().toISOString(),
          timelineOffsetSeconds: replay.offset, events: rebaseEvents(current.events, replay.offset, replay.duration),
        }));
      })().catch(error => this.markFailed(id, String(error))).finally(() => {
        this.active.delete(id); this.errors.delete(id); resolve();
      });
    })));
    let videoZero: number;
    try { videoZero = await ready; }
    catch (error) { await this.finished.get(id); throw error; }
    const started = await this.store.update(id, current => ({ ...current, startedAt: new Date(videoZero).toISOString() }));
    if (started.state === "failed") {
      throw new Error(`Recording failed to start: ${started.error ?? "unknown FFmpeg error"}`);
    }
    for (const log of options.logs ?? []) await this.attachLog(id, log.path, log.pattern);
    return this.store.read(id);
    } finally { this.starting = false; }
  }

  async attachLog(id: string, target: string, pattern?: string): Promise<{ file: string }> {
    if (!this.active.has(id)) throw new Error("Logs can only be attached to an active recording owned by this MCP process.");
    const watcher = new LogWatcher(target, pattern ? new RegExp(pattern) : undefined, line => {
      void this.store.update(id, current => {
        if (current.state !== "recording" || current.events.length >= 10000) return current;
        const timestampMs = line.wallMs - Date.parse(current.startedAt);
        if (timestampMs < 0) return current;
        return { ...current, events: [...current.events, { timestampMs, label: line.label, kind: line.kind, data: line.data }] };
      }).catch(() => undefined);
    });
    const file = await watcher.start();
    this.watchers.set(id, [...(this.watchers.get(id) ?? []), watcher]);
    return { file };
  }

  private async stopWatchers(id: string): Promise<void> {
    const watchers = this.watchers.get(id) ?? [];
    this.watchers.delete(id);
    await Promise.all(watchers.map(w => w.stop().catch(() => undefined)));
  }

  async stop(id: string): Promise<RecordingSession> {
    const child = this.active.get(id);
    if (!child) {
      const session = await this.store.read(id);
      if (session.state === "recording") {
        throw new Error("This recording is not owned by the current MCP process.");
      }
      return session;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      await this.finished.get(id);
      return this.store.read(id);
    }
    child.stdin.write("q\n");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await this.finished.get(id);
    this.finished.delete(id);
    return this.store.read(id);
  }

  async shutdown(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }

  async recover(id: string): Promise<RecordingSession> {
    const session = await this.store.read(id);
    if (session.state !== "interrupted" && session.state !== "failed") throw new Error(`Only interrupted or failed sessions can be recovered; this one is ${session.state}.`);
    const directory = this.store.sessionDir(id);
    if (!(await segmentFiles(directory)).length) throw new Error("No recorded segments remain for this session.");
    const replay = await this.withFiles(id, () => finalizeReplay(directory, session.videoPath, session.bufferSeconds ?? session.maxSeconds, this.ffmpegPath, this.ffprobePath, this.runner));
    return this.store.update(id, current => {
      const { error: _error, ...rest } = current;
      return { ...rest, state: "stopped", timelineOffsetSeconds: replay.offset, events: rebaseEvents(current.events, replay.offset, replay.duration), warnings: [...(current.warnings ?? []), `Recovered from ${current.state} state; the final seconds before interruption may be missing.`] };
    });
  }

  async preview(id: string, seconds: number): Promise<{ videoPath: string; offset: number; duration: number } | undefined> {
    const current = await this.store.read(id);
    if (current.state !== "recording") return { videoPath: current.videoPath, offset: current.timelineOffsetSeconds ?? 0, duration: 0 };
    if (!this.active.has(id)) throw new Error("Live previews must be requested from the MCP process that owns this recording.");
    const directory = path.join(this.store.sessionDir(id), "previews", randomUUID());
    const copied = await this.withFiles(id, async () => {
      const session = await this.store.read(id);
      if (session.state !== "recording") return false;
      // The newest segment may still be open. Only copy immutable completed segments.
      const files = (await segmentFiles(this.store.sessionDir(id))).slice(0, -1).slice(-Math.ceil(seconds / 2) - 1);
      if (!files.length) return false;
      await fs.mkdir(directory, { recursive: true });
      for (const file of files) await fs.copyFile(path.join(this.store.sessionDir(id), file), path.join(directory, file));
      return true;
    });
    if (!copied) return undefined;
    const videoPath = path.join(directory, "preview.mp4");
    const replay = await finalizeReplay(directory, videoPath, seconds, this.ffmpegPath, this.ffprobePath, this.runner);
    return { videoPath, ...replay };
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.store.update(id, (session) => ({
      ...session,
      state: "failed",
      stoppedAt: new Date().toISOString(),
      error,
    })).catch(() => undefined);
  }
}
