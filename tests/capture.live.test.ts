import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { Recorder } from "../src/recorder.js";
import { SessionStore } from "../src/session-store.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { resolveConfig } from "../src/config.js";
import { MediaProcessor } from "../src/media.js";
import { indexVideo } from "../src/visual.js";

it.skipIf(process.platform !== "win32" || process.env.CLIPQA_LIVE_CAPTURE_TEST !== "1")("records an animated nonactivating WGC window and saves a bounded replay", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-live-"));
  const config = resolveConfig(), runner = new NodeCommandRunner(), store = new SessionStore(directory);
  await store.initialize();
  const recorder = new Recorder(store, config.ffmpegPath, runner, config.ffprobePath);
  const fixture = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("tests/fixtures/capture-window.ps1")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const hwnd = await new Promise<string>((resolve, reject) => {
      let output = "", error = "";
      const timeout = setTimeout(() => reject(new Error(`Fixture timeout: ${error}`)), 15000);
      fixture.stderr.on("data", c => { error += c; });
      fixture.stdout.on("data", c => { output += c; const m = /READY:(\d+):(\d+)/.exec(output); if (m) { clearTimeout(timeout); expect(m[1]).not.toBe(m[2]); resolve(m[1]!); } });
      fixture.on("error", e => { clearTimeout(timeout); reject(e); });
    });
    const recording = await recorder.start({ target: { hwnd }, backend: "gfxcapture", fps: 15, maxSeconds: 12, bufferSeconds: 5, maxWidth: 640, encoder: "libx264", drawMouse: false });
    await store.update(recording.id, s => ({ ...s, events: [{ timestampMs: 0, label: "old", kind: "note" }, { timestampMs: 7000, label: "recent", kind: "assertion" }] }));
    await new Promise(r => setTimeout(r, 5000));
    const preview = await recorder.preview(recording.id, 3);
    expect(preview).toBeDefined(); expect(preview!.duration).toBeLessThanOrEqual(3);
    if (process.env.CLIPQA_TEST_OUTPUT_DIR) {
      const output = path.resolve(process.env.CLIPQA_TEST_OUTPUT_DIR); await fs.mkdir(output, { recursive: true });
      await fs.copyFile(preview!.videoPath, path.join(output, "live-preview.mp4"));
      const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
      await media.extractFrame(preview!.videoPath, 1, path.join(output, "live-preview.jpg"));
    }
    await new Promise(r => setTimeout(r, 4000));
    const saved = await recorder.stop(recording.id);
    expect(saved.state, saved.error).toBe("stopped"); expect(saved.backend).toBe("gfxcapture");
    expect(saved.events.map(e => e.label)).toEqual(["recent"]);
    expect(saved.events[0]!.timestampMs).toBeGreaterThan(0); expect(saved.events[0]!.timestampMs).toBeLessThan(5000);
    const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
    const duration = await media.duration(saved.videoPath); expect(duration).toBeCloseTo(5, 1);
    const index = await indexVideo(config.ffmpegPath, saved.videoPath, 0, 4.8, 15);
    expect(index.changes.length).toBeGreaterThan(1); expect(index.warnings).toEqual([]);
    console.log(JSON.stringify({ backend: saved.backend, duration, changes: index.changes.length, events: saved.events.length, bytes: (await fs.stat(saved.videoPath)).size }));
    if (process.env.CLIPQA_TEST_OUTPUT_DIR) await fs.writeFile(path.join(path.resolve(process.env.CLIPQA_TEST_OUTPUT_DIR), "live-result.json"), JSON.stringify({ backend: saved.backend, duration, indexedChanges: index.changes.length, retainedEvents: saved.events.length, bytes: (await fs.stat(saved.videoPath)).size, previewDuration: preview!.duration }, null, 2));
    const full = await recorder.start({ target: { hwnd }, backend: "gdigrab", fps: 15, maxSeconds: 10, encoder: "libx264", drawMouse: false });
    await new Promise(r => setTimeout(r, 2500));
    const complete = await recorder.stop(full.id);
    expect(complete.state, complete.error).toBe("stopped"); expect(await media.duration(complete.videoPath)).toBeGreaterThan(2);
    expect(complete.timelineOffsetSeconds).toBe(0);
  } finally {
    await recorder.shutdown(); fixture.kill();
    await new Promise<void>(resolve => { if (fixture.exitCode !== null || fixture.signalCode !== null) resolve(); else fixture.once("close", () => resolve()); });
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);
