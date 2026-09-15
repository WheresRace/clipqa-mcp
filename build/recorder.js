import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { conciseError } from "./process-runner.js";
import { listWindows } from "./windows.js";
import { capabilities, captureInput, listScreens } from "./backends.js";
import { segmentArgs, pruneSegments, finalizeReplay, segmentFiles } from "./replay.js";
export function buildCaptureArgs(target, outputPath, options) {
    const backend = options.backend === "auto" ? "gdigrab" : options.backend ?? "gdigrab";
    const encoderArgs = {
        libx264: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"],
        h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "24"],
        h264_qsv: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24"],
        h264_amf: ["-c:v", "h264_amf", "-quality", "speed", "-qp_i", "24", "-qp_p", "24"],
    };
    const input = captureInput(backend, target, options.fps, options.drawMouse);
    if (backend === "gfxcapture" && options.maxWidth)
        input[1] = input[1].replace(",pad=", `,scale='min(${options.maxWidth},iw)':-2,pad=`);
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
        ...(backend === "gfxcapture" ? [] : ["-vf", `${options.maxWidth ? `scale='min(${options.maxWidth},iw)':-2,` : ""}pad=ceil(iw/2)*2:ceil(ih/2)*2`]),
        "-an",
        ...(encoderArgs[options.encoder] ?? encoderArgs.libx264),
        "-pix_fmt",
        "yuv420p",
        ...segmentArgs(path.dirname(outputPath), options.fps),
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
    ffprobePath;
    active = new Map();
    errors = new Map();
    finished = new Map();
    starting = false;
    fileQueues = new Map();
    async withFiles(id, action) {
        const task = (this.fileQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
        this.fileQueues.set(id, task);
        try {
            return await task;
        }
        finally {
            if (this.fileQueues.get(id) === task)
                this.fileQueues.delete(id);
        }
    }
    constructor(store, ffmpegPath, runner, ffprobePath = "ffprobe") {
        this.store = store;
        this.ffmpegPath = ffmpegPath;
        this.runner = runner;
        this.ffprobePath = ffprobePath;
    }
    async start(options) {
        if (this.active.size || this.starting)
            throw new Error("One recording at a time is supported to limit resource use.");
        this.starting = true;
        try {
            const caps = await capabilities(this.ffmpegPath, this.runner);
            const backend = !options.backend || options.backend === "auto" ? caps.recommended : options.backend;
            if (!backend || !caps.available.includes(backend))
                throw new Error(`Capture backend unavailable. ${caps.warnings.join(" ")}`);
            let target = { ...options.target };
            if (process.platform === "win32") {
                const matches = (await listWindows(this.runner)).filter(window => target.hwnd ? window.hwnd === target.hwnd : window.title === target.title);
                if (matches.length !== 1)
                    throw new Error("Select one existing window with a unique title or HWND.");
                if (matches[0].minimized)
                    throw new Error("The target is minimized and may not render frames. Restore it before recording; ClipQA will not change window focus.");
                target = { title: matches[0].title, hwnd: matches[0].hwnd };
            }
            if (backend === "x11grab" && !target.display && process.env.DISPLAY)
                target.display = process.env.DISPLAY;
            if (backend === "avfoundation" && !(await listScreens(this.ffmpegPath, this.runner)).some(screen => screen.screenIndex === target.screenIndex))
                throw new Error("screenIndex must identify a display from list_sources, not a camera.");
            captureInput(backend, target, options.fps, options.drawMouse);
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
                backend,
                warnings: caps.warnings,
                ownerPid: process.pid,
                ...(options.bufferSeconds ? { bufferSeconds: options.bufferSeconds } : {}),
            };
            await this.store.create(session);
            const args = buildCaptureArgs(target, videoPath, { ...options, backend, encoder });
            const child = spawn(this.ffmpegPath, args, {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.active.set(id, child);
            child.stdin.on("error", () => undefined);
            let forceStop;
            const wallTimer = setTimeout(() => { child.stdin.write("q\n"); forceStop = setTimeout(() => child.kill(), 5000); }, (options.maxSeconds + 5) * 1000);
            let pruning = Promise.resolve();
            const timer = options.bufferSeconds ? setInterval(() => {
                pruning = pruning.then(() => this.withFiles(id, () => pruneSegments(directory, options.bufferSeconds))).catch(() => { child.kill(); });
            }, 1000) : undefined;
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => {
                this.errors.set(id, `${this.errors.get(id) ?? ""}${chunk}`.slice(-8000));
            });
            child.once("error", (error) => { this.errors.set(id, error.message); });
            const ready = new Promise((resolve, reject) => {
                let progress = "";
                const timeout = setTimeout(() => { child.kill(); reject(new Error("No frames received within 10 seconds. Check target rendering and capture permissions.")); }, 10000);
                const onData = (chunk) => {
                    progress = (progress + chunk.toString()).slice(-4000);
                    if (/frame=\s*[1-9]\d*/.test(progress)) {
                        clearTimeout(timeout);
                        child.stdout.off("data", onData);
                        child.stdout.resume();
                        resolve();
                    }
                };
                child.stdout.on("data", onData);
                child.once("close", () => { clearTimeout(timeout); reject(new Error(`Capture ended before producing frames: ${conciseError(this.errors.get(id) ?? "")}`)); });
            });
            this.finished.set(id, new Promise(resolve => child.once("close", (code) => {
                clearTimeout(wallTimer);
                if (forceStop)
                    clearTimeout(forceStop);
                if (timer)
                    clearInterval(timer);
                void (async () => {
                    await pruning;
                    if (code !== 0)
                        throw new Error(conciseError(this.errors.get(id) ?? `FFmpeg exited with code ${code}.`));
                    const replay = await this.withFiles(id, () => finalizeReplay(directory, videoPath, options.bufferSeconds ?? options.maxSeconds, this.ffmpegPath, this.ffprobePath, this.runner));
                    await this.store.update(id, current => ({ ...current, state: "stopped", stoppedAt: new Date().toISOString(),
                        ...(replay ? { timelineOffsetSeconds: replay.offset, events: current.events.filter(e => e.timestampMs >= replay.offset * 1000 && e.timestampMs <= (replay.offset + replay.duration) * 1000).map(e => ({ ...e, timestampMs: e.timestampMs - replay.offset * 1000 })) } : {}),
                    }));
                })().catch(error => this.markFailed(id, String(error))).finally(() => {
                    this.active.delete(id);
                    this.errors.delete(id);
                    resolve();
                });
            })));
            try {
                await ready;
            }
            catch (error) {
                await this.finished.get(id);
                throw error;
            }
            const started = await this.store.read(id);
            if (started.state === "failed") {
                throw new Error(`Recording failed to start: ${started.error ?? "unknown FFmpeg error"}`);
            }
            return started;
        }
        finally {
            this.starting = false;
        }
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
        if (child.exitCode !== null || child.signalCode !== null) {
            await this.finished.get(id);
            return this.store.read(id);
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
        await this.finished.get(id);
        this.finished.delete(id);
        return this.store.read(id);
    }
    async shutdown() { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
    async preview(id, seconds) {
        const current = await this.store.read(id);
        if (current.state !== "recording")
            return { videoPath: current.videoPath, offset: current.timelineOffsetSeconds ?? 0, duration: 0 };
        if (!this.active.has(id))
            throw new Error("Live previews must be requested from the MCP process that owns this recording.");
        const directory = path.join(this.store.sessionDir(id), "previews", randomUUID());
        const copied = await this.withFiles(id, async () => {
            const session = await this.store.read(id);
            if (session.state !== "recording")
                return false;
            // The newest segment may still be open. Only copy immutable completed segments.
            const files = (await segmentFiles(this.store.sessionDir(id))).slice(0, -1).slice(-Math.ceil(seconds / 2) - 1);
            if (!files.length)
                return false;
            await fs.mkdir(directory, { recursive: true });
            for (const file of files)
                await fs.copyFile(path.join(this.store.sessionDir(id), file), path.join(directory, file));
            return true;
        });
        if (!copied)
            return undefined;
        const videoPath = path.join(directory, "preview.mp4");
        const replay = await finalizeReplay(directory, videoPath, seconds, this.ffmpegPath, this.ffprobePath, this.runner);
        return { videoPath, ...replay };
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