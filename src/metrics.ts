import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { CommandRunner } from "./process-runner.js";
import { conciseError } from "./process-runner.js";
import { analyzeMotion, cached, decodeFrames, difference, streamRawFrames, type MotionReport, type MotionSeries } from "./visual.js";
import type { QaEvent, Region } from "./types.js";

// Objective clip measurements, all from ONE decode pass at 320x180, and a before/after comparison that says
// which way each one moved (improved / regressed / unchanged) instead of only "changed".

export interface ClipMetrics {
  start: number; end: number; analysisFps: number; frames: number;
  motion: Pick<MotionReport, "fluidityScore" | "verdict" | "duplicateFrames" | "speedVariation"> & { hitches: number; pops: number; movingFrames: number };
  effectiveFps: number | null;
  pacing: { jitter: number | null; longFrameRatio: number | null };
  easing: number | null;
  stillJitter: number | null;
  sharpness: number;
  exposure: { meanLuma: number; crushed: number; blown: number };
  color: { r: number; g: number; b: number };
  flickerPerSecond: number;
  blackFrames: number;
  longestFreezeSeconds: number;
  settle: Array<{ label: string; seconds: number | null }>;
  warnings: string[];
}

const round = (v: number, d = 3) => Number(v.toFixed(d));
const median = (values: number[]) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const MOVING = .015, STILL = .004;

/** Runs of consecutive indexes where predicate holds, as [start, endExclusive). */
function runs(length: number, predicate: (i: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < length; i++) { if (!predicate(i)) continue; let j = i; while (j < length && predicate(j)) j++; out.push([i, j]); i = j; }
  return out;
}

/** Pure computation from per-frame series, so it is unit-testable without video. */
export function summarize(series: { fps: number; start: number; scores: number[]; means: number[]; luma: number[]; sharp: number[]; crushed: number[]; blown: number[]; rgb: Array<[number, number, number]> }, events: QaEvent[] = [], recordedFps?: number): ClipMetrics {
  const { fps, start, scores, means, luma } = series, n = scores.length;
  const report = analyzeMotion({ fps, start, scores, means }, recordedFps);
  const warnings = [...report.warnings];
  const moving = scores.map(s => s >= MOVING);
  // Inside motion, a near-zero delta is a repeated frame. Effective FPS = new frames per second while moving.
  const motionRuns = runs(n, i => moving[i]! || (scores[i]! < STILL && moving.slice(Math.max(0, i - 3), i).some(Boolean) && moving.slice(i + 1, i + 4).some(Boolean)));
  let inMotion = 0, repeats = 0;
  const intervals: number[] = [];
  for (const [a, b] of motionRuns) {
    let last = -1;
    for (let i = a; i < b; i++) {
      inMotion++;
      if (scores[i]! < STILL) { repeats++; continue; }
      if (last >= 0) intervals.push(i - last);
      last = i;
    }
  }
  const effectiveFps = inMotion >= fps / 2 ? round(fps * (1 - repeats / inMotion), 1) : null;
  const med = median(intervals);
  const mean = intervals.reduce((s, v) => s + v, 0) / Math.max(1, intervals.length);
  const sd = Math.sqrt(intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, intervals.length));
  const pacing = intervals.length >= 8 ? { jitter: round(sd / Math.max(mean, 1e-6)), longFrameRatio: round(intervals.filter(v => v > 1.5 * med).length / intervals.length) } : { jitter: null, longFrameRatio: null };
  // Easing: in each sustained movement, the first and last 15% should move slower than the middle.
  let eased = 0, ends = 0;
  for (const [a, b] of runs(n, i => moving[i]!)) {
    if (b - a < Math.max(6, fps * .4)) continue;
    const seg = means.slice(a, b), k = Math.max(1, Math.round(seg.length * .15));
    const mid = median(seg.slice(Math.round(seg.length * .25), Math.round(seg.length * .75)));
    if (mid <= 0) continue;
    ends += 2;
    if (median(seg.slice(0, k)) < .6 * mid) eased++;
    if (median(seg.slice(-k)) < .6 * mid) eased++;
  }
  // Stillness: tiny residual change in long still stretches (vibration, shimmer, noise).
  const stills = runs(n, i => scores[i]! < MOVING).filter(([a, b]) => b - a >= fps / 2);
  const stillValues = stills.flatMap(([a, b]) => means.slice(a + 1, b));
  // Flicker: brightness reversing direction by a visible amount on consecutive frames.
  let flicker = 0;
  for (let i = 2; i < n; i++) { const d1 = luma[i - 1]! - luma[i - 2]!, d2 = luma[i]! - luma[i - 1]!; if (Math.abs(d1) > 3 && Math.abs(d2) > 3 && Math.sign(d1) !== Math.sign(d2)) flicker++; }
  const freezes = runs(n, i => i > 0 && scores[i]! < STILL && means[i]! < .0005);
  const longestFreeze = freezes.reduce((m, [a, b]) => Math.max(m, (b - a) / fps), 0);
  // Settle: seconds from each event until motion stays below MOVING for 0.5 s.
  const hold = Math.max(1, Math.round(fps / 2));
  const settle = events.slice(0, 20).map(e => {
    const from = Math.max(0, Math.round((e.timestampMs / 1000 - start) * fps));
    if (from >= n) return { label: e.label, seconds: null };
    for (let i = from; i + hold <= n; i++) if (scores.slice(i, i + hold).every(s => s < MOVING)) return { label: e.label, seconds: round((i - from) / fps, 2) };
    return { label: e.label, seconds: null };
  });
  const black = luma.filter(l => l < 3).length;
  if (black) warnings.push(`${black} black frame(s).`);
  const avg = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  return {
    start: round(start), end: round(start + n / fps), analysisFps: fps, frames: n,
    motion: { fluidityScore: report.fluidityScore, verdict: report.verdict, duplicateFrames: report.duplicateFrames, speedVariation: report.speedVariation, hitches: report.hitches.length, pops: report.pops.length, movingFrames: report.movingFrames },
    effectiveFps, pacing, easing: ends ? round(eased / ends, 2) : null,
    stillJitter: stillValues.length ? round(avg(stillValues) * 1000, 3) : null,
    sharpness: round(median(series.sharp), 1),
    exposure: { meanLuma: round(avg(luma), 1), crushed: round(avg(series.crushed), 4), blown: round(avg(series.blown), 4) },
    color: { r: round(avg(series.rgb.map(c => c[0])), 1), g: round(avg(series.rgb.map(c => c[1])), 1), b: round(avg(series.rgb.map(c => c[2])), 1) },
    flickerPerSecond: round(flicker / Math.max(1 / fps, n / fps), 2), blackFrames: black, longestFreezeSeconds: round(longestFreeze, 2), settle, warnings,
  };
}

export interface MetricsBundle { metrics: ClipMetrics; series: MotionSeries }

export async function clipMetrics(ffmpeg: string, video: string, start: number, end: number, fps: number, options: { crop?: Region; events?: QaEvent[]; recordedFps?: number } = {}): Promise<MetricsBundle> {
  if (!(end > start) || end - start > 600) throw new Error("Measure a valid range up to 10 minutes.");
  const rate = Math.max(5, Math.min(60, Math.round(fps)));
  const raw = await cached(video, `metrics-${round(start)}-${round(end)}-${rate}${options.crop ? `-${Object.values(options.crop).map(v => v.toFixed(4)).join("_")}` : ""}`, "v1", async () => {
    const width = 320, height = 180, px = width * height;
    const s = { fps: rate, start, scores: [] as number[], means: [] as number[], luma: [] as number[], sharp: [] as number[], crushed: [] as number[], blown: [] as number[], rgb: [] as Array<[number, number, number]> };
    const gray = new Float32Array(px);
    let previous: Buffer | undefined;
    await decodeFrames(ffmpeg, video, start, end, rate, width, height, options.crop, frame => {
      let lsum = 0, rs = 0, gs = 0, bs = 0, crushed = 0, blown = 0;
      for (let p = 0, q = 0; q < px; p += 3, q++) {
        const r = frame[p]!, g = frame[p + 1]!, b = frame[p + 2]!, l = .2126 * r + .7152 * g + .0722 * b;
        gray[q] = l; lsum += l; rs += r; gs += g; bs += b;
        if (l <= 4) crushed++; else if (l >= 251) blown++;
      }
      // Variance of the Laplacian: a standard focus/sharpness measure.
      let lapSum = 0, lapSq = 0, lapN = 0;
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const q = y * width + x, v = 4 * gray[q]! - gray[q - 1]! - gray[q + 1]! - gray[q - width]! - gray[q + width]!;
        lapSum += v; lapSq += v * v; lapN++;
      }
      s.sharp.push(lapSq / lapN - (lapSum / lapN) ** 2);
      s.luma.push(lsum / px); s.crushed.push(crushed / px); s.blown.push(blown / px); s.rgb.push([rs / px, gs / px, bs / px]);
      if (previous) { const d = difference(previous, frame, width, height); s.scores.push(Number(Math.max(d.peakTileDifference, 1 - d.ssim).toFixed(5))); s.means.push(Number(d.meanDifference.toFixed(6))); }
      else { s.scores.push(0); s.means.push(0); }
      previous = frame;
    }, { timeoutMs: 300_000 });
    return s;
  });
  return { metrics: summarize(raw, options.events, options.recordedFps), series: { fps: raw.fps, start: raw.start, scores: raw.scores, means: raw.means } };
}

export type Direction = "higher" | "lower" | "neutral";
export interface MetricRow { metric: string; label: string; before: number | null; after: number | null; delta: number | null; verdict: "improved" | "regressed" | "unchanged" | "changed" | "n/a"; why?: string }

// [path, label, better direction, absolute threshold, relative threshold]
const SPECS: Array<[string, string, Direction, number, number]> = [
  ["motion.fluidityScore", "Smoothness score (0-100)", "higher", 3, 0],
  ["motion.hitches", "Hitches (freezes during motion)", "lower", 1, 0],
  ["motion.pops", "Pops (sudden jumps)", "lower", 1, 0],
  ["motion.duplicateFrames", "Repeated frames during motion", "lower", 2, .2],
  ["effectiveFps", "Real frame rate while moving", "higher", 1.5, .05],
  ["pacing.jitter", "Frame pacing unevenness", "lower", .05, .15],
  ["pacing.longFrameRatio", "Long frames (>1.5× usual)", "lower", .01, .2],
  // Small per-frame steps make this noisy (constant speed reads ~0.3), so only large changes count.
  ["motion.speedVariation", "Speed unevenness", "lower", .35, .5],
  ["easing", "Ease in/out (0-1)", "higher", .15, 0],
  ["stillJitter", "Jitter while still", "lower", .05, .25],
  ["sharpness", "Sharpness", "higher", 0, .1],
  ["exposure.crushed", "Crushed blacks (fraction)", "lower", .005, .25],
  ["exposure.blown", "Blown highlights (fraction)", "lower", .005, .25],
  ["flickerPerSecond", "Flicker per second", "lower", .3, .25],
  ["blackFrames", "Black frames", "lower", 1, 0],
  ["exposure.meanLuma", "Brightness (0-255)", "neutral", 6, 0],
  ["longestFreezeSeconds", "Longest frozen stretch (s)", "neutral", .3, 0],
];

const read = (m: ClipMetrics, key: string): number | null => {
  let v: unknown = m;
  for (const part of key.split(".")) v = (v as Record<string, unknown> | null)?.[part];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export function compareMetrics(before: ClipMetrics, after: ClipMetrics) {
  const rows: MetricRow[] = SPECS.map(([metric, label, direction, abs, rel]) => {
    const a = read(before, metric), b = read(after, metric);
    if (a === null || b === null) return { metric, label, before: a, after: b, delta: null, verdict: "n/a" as const };
    const delta = b - a, significant = Math.abs(delta) > Math.max(abs, rel * Math.abs(a));
    const verdict = !significant ? "unchanged" as const : direction === "neutral" ? "changed" as const : (direction === "higher") === delta > 0 ? "improved" as const : "regressed" as const;
    return { metric, label, before: a, after: b, delta: round(delta, 4), verdict };
  });
  // Colour shift between the two clips' average colour (Euclidean RGB distance).
  const shift = Math.hypot(after.color.r - before.color.r, after.color.g - before.color.g, after.color.b - before.color.b);
  rows.push({ metric: "color.shift", label: "Average colour shift", before: 0, after: round(shift, 1), delta: round(shift, 1), verdict: shift > 8 ? "changed" : "unchanged", ...(shift > 8 ? { why: `RGB ${before.color.r}/${before.color.g}/${before.color.b} → ${after.color.r}/${after.color.g}/${after.color.b}` } : {}) });
  const pick = (v: MetricRow["verdict"]) => rows.filter(r => r.verdict === v).map(r => r.label);
  const improved = pick("improved"), regressed = pick("regressed");
  const overall = regressed.length && !improved.length ? "worse" : improved.length && !regressed.length ? "better" : improved.length || regressed.length ? "mixed" : "same";
  return { overall, improved, regressed, changed: pick("changed"), rows };
}

export interface TimelineResult { chartPath: string; samples: number; fps: number; mean: number; peak: { offset: number; score: number }; divergent: Array<{ start: number; end: number; peak: number }> }

// Compares EVERY aligned frame pair (at `fps`) in a single FFmpeg process, at constant memory.
export async function differenceTimeline(ffmpeg: string, before: string, beforeStart: number, after: string, afterStart: number, seconds: number, chartPath: string, options: { fps?: number; threshold?: number; ignore?: Region[] } = {}): Promise<TimelineResult> {
  const fps = options.fps ?? 10, threshold = options.threshold ?? .08, width = 160, height = 90;
  const both = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=rgb24`;
  const args = ["-hide_banner", "-loglevel", "error", "-ss", String(beforeStart), "-t", String(seconds), "-i", before, "-ss", String(afterStart), "-t", String(seconds), "-i", after,
    "-filter_complex", `[0:v]${both}[a];[1:v]${both}[b];[a][b]hstack=inputs=2`, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"];
  const scores: number[] = [], rowBytes = width * 3;
  const left = Buffer.allocUnsafe(width * height * 3), right = Buffer.allocUnsafe(width * height * 3);
  await streamRawFrames(ffmpeg, args, width * 2 * height * 3, pair => {
    for (let y = 0; y < height; y++) { pair.copy(left, y * rowBytes, y * rowBytes * 2, y * rowBytes * 2 + rowBytes); pair.copy(right, y * rowBytes, y * rowBytes * 2 + rowBytes, (y + 1) * rowBytes * 2); }
    const d = difference(left, right, width, height, options.ignore ?? []);
    scores.push(Number(Math.max(d.peakTileDifference, 1 - d.ssim).toFixed(4)));
  }, 300_000);
  const divergent: TimelineResult["divergent"] = [];
  for (const [a, b] of runs(scores.length, i => scores[i]! >= threshold)) {
    if (b - a < Math.max(1, Math.round(fps * .2))) continue;
    divergent.push({ start: round(a / fps, 2), end: round(b / fps, 2), peak: Math.max(...scores.slice(a, b)) });
  }
  const peakIndex = scores.reduce((best, v, i) => v > scores[best]! ? i : best, 0);
  await fs.mkdir(path.dirname(chartPath), { recursive: true });
  await sharp(Buffer.from(timelineSvg(scores, fps, threshold, divergent))).png().toFile(chartPath);
  return { chartPath, samples: scores.length, fps, mean: round(scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length), 4), peak: { offset: round(peakIndex / fps, 2), score: scores[peakIndex] ?? 0 }, divergent: divergent.slice(0, 20) };
}

function timelineSvg(scores: number[], fps: number, threshold: number, spans: TimelineResult["divergent"]): string {
  const W = 960, H = 170, pad = 30, top = 12, plotH = H - pad - top, max = Math.max(.25, ...scores);
  const x = (i: number) => pad + (i / Math.max(1, scores.length - 1)) * (W - pad - 10);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const pts = scores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const shade = spans.map(s => `<rect x="${x(s.start * fps)}" y="${top}" width="${Math.max(2, x(s.end * fps) - x(s.start * fps))}" height="${plotH}" fill="#f87171" fill-opacity="0.18"/>`).join("");
  const duration = scores.length / fps, ticks = Array.from({ length: 6 }, (_, k) => k * duration / 5).map(t => `<text x="${x(t * fps)}" y="${H - 10}" font-size="11" fill="#8b949e" text-anchor="middle">${t.toFixed(1)}s</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial"><rect width="${W}" height="${H}" fill="#0d1117"/>${shade}<line x1="${pad}" x2="${W - 10}" y1="${y(threshold)}" y2="${y(threshold)}" stroke="#fbbf24" stroke-dasharray="4 4"/><polyline points="${pts}" fill="none" stroke="#38bdf8" stroke-width="1.5"/><text x="${pad}" y="${top + 10}" font-size="11" fill="#8b949e">difference between clips (every frame) · dashed = threshold · red = clips diverge</text>${ticks}</svg>`;
}

// Before | After on top, amplified difference underneath, in one MP4 so the comparison can be watched.
export async function sideBySide(ffmpeg: string, runner: CommandRunner, before: string, beforeStart: number, after: string, afterStart: number, seconds: number, output: string): Promise<{ videoPath: string; seconds: number }> {
  const length = Math.min(seconds, 120);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const labels = path.join(path.dirname(output), "labels.png");
  const tag = (x: number, y: number, text: string) => `<rect x="${x}" y="${y}" width="${text.length * 9 + 16}" height="24" rx="4" fill="#000" fill-opacity="0.65"/><text x="${x + 8}" y="${y + 17}" font-family="Arial" font-size="15" font-weight="bold" fill="#fff">${text}</text>`;
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${tag(8, 8, "BEFORE")}${tag(648, 8, "AFTER")}${tag(328, 368, "DIFFERENCE x4")}</svg>`)).png().toFile(labels);
  const shape = "fps=30,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p";
  const graph = `[0:v]${shape},split[a][a2];[1:v]${shape},split[b][b2];[a2][b2]blend=all_mode=difference,lutyuv=y='min(255,val*4)':u=128:v=128[d];[a][b]hstack[top];[d]pad=1280:360:320:0[bot];[top][bot]vstack[v];[v][2:v]overlay=0:0[out]`;
  const result = await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(beforeStart), "-t", String(length), "-i", before, "-ss", String(afterStart), "-t", String(length), "-i", after, "-i", labels,
    "-filter_complex", graph, "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", output]);
  await fs.unlink(labels).catch(() => undefined);
  if (result.code) throw new Error(`Cannot build side-by-side video: ${conciseError(result.stderr)}`);
  return { videoPath: output, seconds: length };
}
