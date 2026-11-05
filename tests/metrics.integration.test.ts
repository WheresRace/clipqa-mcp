import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { clipMetrics, compareMetrics, differenceTimeline, sideBySide, summarize } from "../src/metrics.js";
import { MediaProcessor } from "../src/media.js";

describe("clip quality metrics", () => {
  const config = resolveConfig(), runner = new NodeCommandRunner(), media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
  let dir: string, smooth: string, choppy: string, eased: string, dark: string;
  // A box sweeping left to right; `x` is the position expression.
  const sweep = (x: string, extra = "") => `color=c=gray:s=320x180:r=30:d=3[bg];color=c=white:s=30x30:r=30[box];[bg][box]overlay=x='${x}':y=70:shortest=1${extra}`;
  async function generate(output: string, graph: string) {
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", graph, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", "-r", "30", output]);
    if (r.code) throw new Error(r.stderr);
  }
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-metrics-"));
    smooth = path.join(dir, "smooth.mp4"); choppy = path.join(dir, "choppy.mp4"); eased = path.join(dir, "eased.mp4"); dark = path.join(dir, "dark.mp4");
    await generate(smooth, sweep("t*90"));
    await generate(choppy, sweep("t*90", ",fps=10,fps=30")); // same motion, only 10 new frames per second
    await generate(eased, sweep("270*(0.5-0.5*cos(PI*t/3))")); // slow-in, slow-out
    await generate(dark, sweep("t*90", ",eq=brightness=-0.45"));
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("measures real frame rate, pacing and smoothness", async () => {
    const good = (await clipMetrics(config.ffmpegPath, smooth, 0, 2.9, 30)).metrics;
    const bad = (await clipMetrics(config.ffmpegPath, choppy, 0, 2.9, 30)).metrics;
    expect(good.effectiveFps).toBeGreaterThan(27);
    expect(bad.effectiveFps).toBeLessThan(14);
    expect(good.motion.fluidityScore).toBeGreaterThan(bad.motion.fluidityScore);
  }, 60000);

  it("says which way each metric moved", async () => {
    const [a, b] = await Promise.all([clipMetrics(config.ffmpegPath, choppy, 0, 2.9, 30), clipMetrics(config.ffmpegPath, smooth, 0, 2.9, 30)]);
    const result = compareMetrics(a.metrics, b.metrics);
    expect(result.overall).toBe("better");
    expect(result.improved).toContain("Real frame rate while moving");
    const reverse = compareMetrics(b.metrics, a.metrics);
    expect(reverse.regressed).toContain("Real frame rate while moving");
    expect(compareMetrics(a.metrics, a.metrics).overall).toBe("same");
  }, 60000);

  it("rewards ease in/out over linear motion", async () => {
    const linear = (await clipMetrics(config.ffmpegPath, smooth, 0, 2.9, 30)).metrics;
    const easedM = (await clipMetrics(config.ffmpegPath, eased, 0, 2.9, 30)).metrics;
    expect(easedM.easing!).toBeGreaterThan(linear.easing ?? 0);
  }, 60000);

  it("does not mistake sub-pixel creep at the ends of an ease for dropped frames", async () => {
    // Regression: integer-pixel stalls at the slow ends of an ease read as hitches and uneven pacing.
    const m = (await clipMetrics(config.ffmpegPath, eased, 0, 2.9, 30)).metrics;
    expect(m.motion.hitches).toBe(0);
    expect(m.effectiveFps!).toBeGreaterThan(28);
    const choppyM = (await clipMetrics(config.ffmpegPath, choppy, 0, 2.9, 30)).metrics;
    expect(choppyM.motion.hitches).toBeGreaterThan(10);
  }, 60000);

  it("flags a single-frame flash", async () => {
    const flash = path.join(dir, "flash.mp4");
    await generate(flash, `${sweep("t*90")},drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='eq(n,40)'`);
    const m = (await clipMetrics(config.ffmpegPath, flash, 0, 2.9, 30)).metrics;
    expect(m.flashes).toHaveLength(1); expect(m.flashes[0]!.timestamp).toBeCloseTo(40 / 30, 1);
    const clean = (await clipMetrics(config.ffmpegPath, smooth, 0, 2.9, 30)).metrics;
    expect(clean.flashes).toHaveLength(0);
    expect(compareMetrics(m, clean).improved).toContain("Single-frame flashes");
  }, 60000);

  it("tracks exposure", async () => {
    const normal = (await clipMetrics(config.ffmpegPath, smooth, 0, 2.9, 30)).metrics;
    const darker = (await clipMetrics(config.ffmpegPath, dark, 0, 2.9, 30)).metrics;
    expect(darker.exposure.meanLuma).toBeLessThan(normal.exposure.meanLuma - 20);
    expect(compareMetrics(normal, darker).changed).toContain("Brightness (0-255)");
  }, 60000);

  it("compares every aligned frame and builds a watchable side-by-side video", async () => {
    const same = await differenceTimeline(config.ffmpegPath, smooth, 0, smooth, 0, 2.5, path.join(dir, "t1.png"));
    expect(same.divergent).toEqual([]); expect(same.samples).toBeGreaterThanOrEqual(24);
    const shifted = await differenceTimeline(config.ffmpegPath, smooth, 0, dark, 0, 2.5, path.join(dir, "t2.png"));
    expect(shifted.divergent.length).toBeGreaterThan(0);
    const video = await sideBySide(config.ffmpegPath, runner, choppy, 0, smooth, 0, 2.5, path.join(dir, "sbs", "side.mp4"));
    expect(await media.duration(video.videoPath)).toBeGreaterThan(2);
  }, 60000);

  it("reports settle time after an event", () => {
    const n = 60, scores = Array.from({ length: n }, (_, i) => i >= 10 && i < 25 ? .05 : 0);
    const series = { fps: 30, start: 0, scores, means: scores.map(s => s / 10), luma: Array(n).fill(120), sharp: Array(n).fill(50), crushed: Array(n).fill(0), blown: Array(n).fill(0), rgb: Array(n).fill([120, 120, 120]) as Array<[number, number, number]> };
    const m = summarize(series, [{ timestampMs: 333, label: "click", kind: "action" }]);
    expect(m.settle[0]!.seconds).toBeCloseTo(.5, 1);
  });
});
