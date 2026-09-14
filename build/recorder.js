import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { conciseError } from "./process-runner.js";
import { listWindows } from "./windows.js";
export function buildCaptureArgs(target, outputPath, options) {
    const source = target.title ? `title=${target.title}` : `hwnd=${target.hwnd ?? ""}`;
    const encoderArgs = {
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
        ...(encoderArgs[options.encoder] ?? encoderArgs.libx264),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+frag_keyframe+empty_moov+faststart",
        outputPath,
    ];
}
export async function selectEncoder(requested, ffmpegPath, runner) {
    if (requested !== "auto")
        return requested;
    const result = await runner.run(ffmpegPath, ["-hide_banner", "-encoders"]);
    const available = result.stdout + result.stderr;
    for (const candidate of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
        if (!available.includes(candidate))
            continue;
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
        if (probe.code === 0)
            return candidate;
    }
    return "libx264";
}
export class Recorder {
    store;
    ffmpegPath;
    runner;
    active = new Map();
    errors = new Map();
    constructor(store, ffmpegPath, runner) {
        this.store = store;
        this.ffmpegPath = ffmpegPath;
        this.runner = runner;
    }
    async start(options) {
        if (process.platform !== "win32") {
            throw new Error("Recording is currently Windows-only.");
        }
        if (!options.target.title && !options.target.hwnd) {
            throw new Error("Provide a window title or HWND.");
        }
        let target = options.target;
        if (target.hwnd && !target.title) {
            const match = (await listWindows(this.runner)).find((window) => window.hwnd === target.hwnd);
            if (!match)
                throw new Error(`No visible window has HWND ${target.hwnd}.`);
            target = { title: match.title, hwnd: match.hwnd };
        }
        const id = randomUUID();
        const encoder = await selectEncoder(options.encoder, this.ffmpegPath, this.runner);
        const directory = this.store.sessionDir(id);
        const videoPath = path.join(directory, "recording.mp4");
        const session = {
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
        child.stderr.on("data", (chunk) => {
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
                }
                else {
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
    async stop(id) {
        const child = this.active.get(id);
        if (!child) {
            const session = await this.store.read(id);
            if (session.state === "recording") {
                throw new Error("This recording is not owned by the current MCP process.");
            }
            return session;
        }
        child.stdin.write("q\n");
        await new Promise((resolve) => {
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
    async markFailed(id, error) {
        await this.store.update(id, (session) => ({
            ...session,
            state: "failed",
            stoppedAt: new Date().toISOString(),
            error,
        })).catch(() => undefined);
    }
}
//# sourceMappingURL=recorder.js.map