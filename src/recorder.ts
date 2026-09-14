import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandRunner } from "./process-runner.js";
import { conciseError } from "./process-runner.js";
import type { CaptureTarget, RecordingSession } from "./types.js";
import { SessionStore } from "./session-store.js";
import { listWindows } from "./windows.js";

export type EncoderChoice = "auto" | "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf";

export interface StartRecordingOptions {
  target: CaptureTarget;
  fps: number;
  maxSeconds: number;
  drawMouse: boolean;
  encoder: EncoderChoice;
}

export function buildCaptureArgs(
  target: CaptureTarget,
  outputPath: string,
  options: Omit<StartRecordingOptions, "target" | "encoder"> & { encoder: string },
): string[] {
  const source = target.title ? `title=${target.title}` : `hwnd=${target.hwnd ?? ""}`;
  const encoderArgs: Record<string, string[]> = {
    libx264: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"],
    h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "24"],
    h264_qsv: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24"],
    h264_amf: ["-c:v", "h264_amf", "-quality", "speed", "-qp_i", "24", "-qp_p", "24"],
  };

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    String(options.fps),
    "-draw_mouse",
    options.drawMouse ? "1" : "0",
    "-thread_queue_size",
    "64",
    "-i",
    source,
    "-t",
    String(options.maxSeconds),
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    ...(encoderArgs[options.encoder] ?? encoderArgs.libx264!),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+frag_keyframe+empty_moov+faststart",
    outputPath,
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
    if (available.includes(candidate)) return candidate;
  }
  return "libx264";
}

export class Recorder {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly store: SessionStore,
    private readonly ffmpegPath: string,
    private readonly runner: CommandRunner,
  ) {}

  async start(options: StartRecordingOptions): Promise<RecordingSession> {
    if (process.platform !== "win32") {
      throw new Error("Recording is currently Windows-only.");
    }
    if (!options.target.title && !options.target.hwnd) {
      throw new Error("Provide a window title or HWND.");
    }

    let target = options.target;
    if (target.hwnd && !target.title) {
      const match = (await listWindows(this.runner)).find((window) => window.hwnd === target.hwnd);
      if (!match) throw new Error(`No visible window has HWND ${target.hwnd}.`);
      target = { title: match.title, hwnd: match.hwnd };
    }

    const id = randomUUID();
    const encoder = await selectEncoder(options.encoder, this.ffmpegPath, this.runner);
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
    };
    await this.store.create(session);

    const args = buildCaptureArgs(target, videoPath, { ...options, encoder });
    const child = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active.set(id, child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.errors.set(id, `${this.errors.get(id) ?? ""}${chunk}`.slice(-8000));
    });
    child.once("error", async (error) => {
      this.active.delete(id);
      await this.markFailed(id, error.message);
    });
    child.once("close", async (code) => {
      this.active.delete(id);
      const current = await this.store.read(id).catch(() => undefined);
      if (current?.state === "recording") {
        if (code === 0) {
          await this.store.write({ ...current, state: "stopped", stoppedAt: new Date().toISOString() });
        } else {
          await this.markFailed(id, conciseError(this.errors.get(id) ?? `FFmpeg exited with code ${code}.`));
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = await this.store.read(id);
    if (started.state === "failed") {
      throw new Error(`Recording failed to start: ${started.error ?? "unknown FFmpeg error"}`);
    }
    return started;
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
    return this.store.update(id, (session) => ({
      ...session,
      state: session.state === "failed" ? "failed" : "stopped",
      stoppedAt: session.stoppedAt ?? new Date().toISOString(),
    }));
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
