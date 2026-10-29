import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { cropFilter, escapeXml, MediaProcessor } from "./media.js";
import type { Region } from "./types.js";

export type { Region };
export interface Difference { meanDifference: number; peakTileDifference: number; ssim: number; changedFraction: number }

// Local SSIM plus RGB error catches both structural and flat-color changes.
export function difference(a: Uint8Array, b: Uint8Array, width: number, height: number, ignore: Region[] = []): Difference {
  if (a.length !== width * height * 3 || b.length !== a.length) throw new Error("Frame dimensions must match.");
  let sum = 0, pixels = 0, changed = 0, peak = 0, ssimSum = 0, tiles = 0;
  for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
    let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, delta = 0;
    for (let j = y; j < Math.min(y + 8, height); j++) for (let i = x; i < Math.min(x + 8, width); i++) {
      if (ignore.length && ignore.some(r => i / width >= r.x && i / width < r.x + r.width && j / height >= r.y && j / height < r.y + r.height)) continue;
      const k = (j * width + i) * 3;
      const u = .2126 * a[k]! + .7152 * a[k + 1]! + .0722 * a[k + 2]!;
      const v = .2126 * b[k]! + .7152 * b[k + 1]! + .0722 * b[k + 2]!;
      const d = (Math.abs(a[k]! - b[k]!) + Math.abs(a[k + 1]! - b[k + 1]!) + Math.abs(a[k + 2]! - b[k + 2]!)) / (3 * 255);
      delta += d; sum += d; pixels++; if (d > .04) changed++;
      n++; sx += u; sy += v; xx += u * u; yy += v * v; xy += u * v;
    }
    if (!n) continue;
    const mx = sx / n, my = sy / n;
    const vx = Math.max(0, xx / n - mx * mx), vy = Math.max(0, yy / n - my * my), cov = xy / n - mx * my;
    ssimSum += ((2 * mx * my + 6.5025) * (2 * cov + 58.5225)) / ((mx * mx + my * my + 6.5025) * (vx + vy + 58.5225));
    tiles++; peak = Math.max(peak, delta / n);
  }
  if (!pixels) throw new Error("Ignore regions cover the entire frame.");
  return { meanDifference: sum / pixels, peakTileDifference: peak, ssim: ssimSum / tiles, changedFraction: changed / pixels };
}

const regionKey = (crop?: Region) => crop ? `-${[crop.x, crop.y, crop.width, crop.height].map(v => v.toFixed(4)).join("_")}` : "";

async function cached<T>(video: string, name: string, version: string, build: () => Promise<T>): Promise<T> {
  const stat = await fs.stat(video);
  const cache = `${video}.${name}.json`;
  const key = `${stat.size}:${stat.mtimeMs}:${version}`;
  const hit = await fs.readFile(cache, "utf8").then(JSON.parse).catch(() => undefined);
  if (hit?.key === key) return hit.value as T;
  const value = await build();
  const temp = `${cache}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ key, value })); await fs.rename(temp, cache);
  return value;
}

function decodeFrames(ffmpeg: string, video: string, start: number, end: number, fps: number, width: number, height: number, crop: Region | undefined, onFrame: (frame: Buffer, index: number) => void): Promise<number> {
  const bytes = width * height * 3;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(start), "-protocol_whitelist", "file,pipe", "-i", video, "-t", String(end - start), "-an", "-vf", `${cropFilter(crop)}fps=${fps},scale=${width}:${height}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0), count = 0, stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Visual analysis timed out; inspect a shorter range.")); }, 120_000);
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= bytes) {
        onFrame(Buffer.from(pending.subarray(0, bytes)), count++);
        pending = pending.subarray(bytes);
      }
    });
    child.on("error", e => { clearTimeout(timeout); reject(e); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code || !count || pending.length) return reject(new Error(`Visual analysis failed: ${stderr || "no complete frames"}`));
      resolve(count);
    });
  });
}

export interface VisualIndex {
  fps: number; decodedFrames: number; width: number; height: number;
  changes: Array<{ timestamp: number; score: number }>; warnings: string[];
}

export async function indexVideo(ffmpeg: string, video: string, start: number, end: number, fps = 15, crop?: Region): Promise<VisualIndex> {
  if (!(end > start) || end - start > 3600 || fps < 1 || fps > 60) throw new Error("Index a valid range up to one hour at 1–60 FPS.");
  return cached(video, `index-${start}-${end}-${fps}${regionKey(crop)}`, "v2", async () => {
    const width = 160, height = 90;
    let previous: Buffer | undefined, staticFrames = 0, darkFrames = 0;
    const bins = new Map<number, { timestamp: number; score: number }>();
    const count = await decodeFrames(ffmpeg, video, start, end, fps, width, height, crop, (frame, index) => {
      let brightness = 0; for (const value of frame) brightness += value;
      if (brightness / frame.length < 3) darkFrames++;
      if (previous) {
        const d = difference(previous, frame, width, height);
        const score = Math.max(d.peakTileDifference, 1 - d.ssim);
        if (d.meanDifference < .0005) staticFrames++;
        if (score >= .035) {
          const timestamp = start + index / fps, bin = Math.floor((timestamp - start) * 2);
          if (!bins.has(bin) || bins.get(bin)!.score < score) bins.set(bin, { timestamp, score });
        }
      }
      previous = frame;
    });
    const warnings: string[] = [];
    if (darkFrames / count > .95) warnings.push("Almost all frames are black; check permissions, protected content, and target rendering.");
    if (staticFrames / Math.max(1, count - 1) > .98) warnings.push("Nearly static recording: may be an idle application, a frozen capture, or a minimized target. This is not a defect diagnosis.");
    const changes = [...bins.values()].sort((a, b) => b.score - a.score).slice(0, 256).sort((a, b) => a.timestamp - b.timestamp);
    return { fps, decodedFrames: count, width, height, changes, warnings };
  });
}

export interface MotionSeries { fps: number; start: number; scores: number[]; means: number[] }

export async function motionSeries(ffmpeg: string, video: string, start: number, end: number, fps: number, crop?: Region): Promise<MotionSeries> {
  if (!(end > start) || end - start > 3600 || fps < 1 || fps > 120) throw new Error("Analyze a valid range up to one hour at 1–120 FPS.");
  return cached(video, `motion-${start}-${end}-${fps}${regionKey(crop)}`, "v1", async () => {
    const width = 160, height = 90, scores: number[] = [], means: number[] = [];
    let previous: Buffer | undefined;
    await decodeFrames(ffmpeg, video, start, end, fps, width, height, crop, frame => {
      if (previous) {
        const d = difference(previous, frame, width, height);
        scores.push(Number(Math.max(d.peakTileDifference, 1 - d.ssim).toFixed(5))); means.push(Number(d.meanDifference.toFixed(6)));
      } else { scores.push(0); means.push(0); }
      previous = frame;
    });
    return { fps, start, scores, means };
  });
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface MotionReport {
  fps: number; framesAnalyzed: number; movingFrames: number; duplicateFrames: number;
  hitches: Array<{ start: number; end: number; frames: number }>;
  pops: Array<{ timestamp: number; ratio: number; score: number }>;
  speedVariation: number; fluidityScore: number; verdict: "smooth" | "minor issues" | "choppy" | "no motion";
  warnings: string[];
}

// Duplicate frames inside motion are hitches; isolated spikes far above local motion are pops/snaps.
export function analyzeMotion(series: MotionSeries, recordedFps?: number): MotionReport {
  const { fps, start, scores, means } = series;
  // Local tile scores, not frame means, so a small subject on a large static background still counts as moving.
  const moving = scores.map(s => s >= .015);
  const frozen = (i: number) => scores[i]! < .004 && means[i]! < .0005;
  const warnings: string[] = [];
  if (recordedFps && recordedFps < 30) warnings.push(`Recorded at ${recordedFps} FPS: hitches shorter than ${(1000 / recordedFps).toFixed(0)} ms cannot be seen. Record at 30-60 FPS to judge fluidity.`);
  const hitches: MotionReport["hitches"] = [];
  let duplicateFrames = 0;
  for (let i = 1; i < means.length - 1; i++) {
    if (!frozen(i)) continue;
    let j = i; while (j < means.length - 1 && frozen(j)) j++;
    const before = moving.slice(Math.max(0, i - 3), i).some(Boolean), after = moving.slice(j, j + 3).some(Boolean);
    if (before && after && j - i <= fps) { duplicateFrames += j - i; hitches.push({ start: Number((start + (i - 1) / fps).toFixed(3)), end: Number((start + j / fps).toFixed(3)), frames: j - i }); }
    i = j;
  }
  const pops: MotionReport["pops"] = [];
  const half = Math.max(2, Math.round(fps / 2));
  for (let i = 1; i < scores.length; i++) {
    if (!moving[i]) continue;
    const neighbours: number[] = [];
    for (let k = Math.max(1, i - half); k <= Math.min(scores.length - 1, i + half); k++) if (k !== i && scores[k]! > 0) neighbours.push(scores[k]!);
    const local = median(neighbours);
    const ratio = local > 0 ? scores[i]! / local : 0;
    if (scores[i]! >= .06 && ratio >= 4) pops.push({ timestamp: Number((start + i / fps).toFixed(3)), ratio: Number(ratio.toFixed(1)), score: scores[i]! });
  }
  const movingMeans = means.filter((_, i) => moving[i]);
  const movingFrames = movingMeans.length;
  const average = movingMeans.reduce((s, v) => s + v, 0) / Math.max(1, movingFrames);
  const speedVariation = movingFrames ? Math.sqrt(movingMeans.reduce((s, v) => s + (v - average) ** 2, 0) / movingFrames) / Math.max(average, 1e-6) : 0;
  if (!movingFrames) return { fps, framesAnalyzed: scores.length, movingFrames, duplicateFrames, hitches, pops, speedVariation: 0, fluidityScore: 100, verdict: "no motion", warnings: [...warnings, "No motion in this range; fluidity cannot be judged."] };
  const duplicateRatio = duplicateFrames / Math.max(1, movingFrames + duplicateFrames);
  if (duplicateRatio > .3) warnings.push("Frequent repeated frames: the app is rendering below the capture FPS, or capture is dropping frames.");
  const penalty = Math.min(40, hitches.length * 6) + Math.min(40, pops.length * 8) + Math.min(20, duplicateRatio * 60) + Math.min(15, Math.max(0, speedVariation - 1) * 10);
  const fluidityScore = Math.max(0, Math.round(100 - penalty));
  return { fps, framesAnalyzed: scores.length, movingFrames, duplicateFrames, hitches: hitches.slice(0, 50), pops: pops.slice(0, 50), speedVariation: Number(speedVariation.toFixed(2)), fluidityScore, verdict: fluidityScore >= 85 ? "smooth" : fluidityScore >= 60 ? "minor issues" : "choppy", warnings };
}

// Returns lag L (seconds) such that before(t + L) matches after(t), via normalized cross-correlation of motion.
export function estimateLag(before: number[], after: number[], fps: number, maxLagSeconds: number): { lagSeconds: number; confidence: number } {
  const normalize = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length)) || 1;
    return values.map(v => (v - mean) / sd);
  };
  const a = normalize(before), b = normalize(after), maxLag = Math.round(maxLagSeconds * fps);
  let best = { lag: 0, value: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, n = 0;
    for (let i = 0; i < b.length; i++) { const j = i + lag; if (j < 0 || j >= a.length) continue; sum += a[j]! * b[i]!; n++; }
    if (n < Math.max(4, b.length / 4)) continue;
    const value = sum / n;
    if (value > best.value) best = { lag, value };
  }
  return { lagSeconds: Number((best.lag / fps).toFixed(3)), confidence: Number(Math.max(0, best.value).toFixed(3)) };
}

export async function compareVideos(media: MediaProcessor, before: string, after: string, directory: string, options: { beforeStart: number; afterStart: number; seconds: number; samples: number; threshold: number; ignore: Region[]; offsets?: number[]; analysisWidth?: number; notes?: string[] }) {
  const offsets = options.offsets ?? Array.from({ length: options.samples }, (_, i) => i * options.seconds / options.samples);
  if (options.seconds <= 0 || offsets.length < 2 || offsets.length > 60) throw new Error("Compare a positive duration with 2–60 samples.");
  const width = options.analysisWidth ?? 320, height = Math.round(width * 9 / 16);
  await fs.mkdir(directory, { recursive: true });
  await media.extractFrames(before, offsets.map((offset, i) => ({ timestamp: options.beforeStart + offset, outputPath: path.join(directory, `before-${i}.png`) })), Math.max(640, width));
  await media.extractFrames(after, offsets.map((offset, i) => ({ timestamp: options.afterStart + offset, outputPath: path.join(directory, `after-${i}.png`) })), Math.max(640, width));
  const rows: Array<Difference & { beforeSeconds: number; afterSeconds: number; score: number; changed: boolean; note?: string }> = [];
  const htmlRows: string[] = [];
  for (const [i, offset] of offsets.entries()) {
    const a = path.join(directory, `before-${i}.png`), b = path.join(directory, `after-${i}.png`);
    const raw = async (file: string) => sharp(file).resize(width, height, { fit: "contain", background: "black" }).removeAlpha().raw().toBuffer();
    const [left, right] = await Promise.all([raw(a), raw(b)]);
    const metrics = difference(left, right, width, height, options.ignore);
    const score = Math.max(metrics.peakTileDifference, 1 - metrics.ssim);
    const note = options.notes?.[i];
    const row = { beforeSeconds: Number((options.beforeStart + offset).toFixed(3)), afterSeconds: Number((options.afterStart + offset).toFixed(3)), ...metrics, score, changed: score >= options.threshold, ...(note ? { note } : {}) };
    rows.push(row);
    const mask = Buffer.alloc(left.length);
    for (let p = 0; p < left.length; p += 3) {
      const x = (p / 3 % width) / width, y = Math.floor(p / 3 / width) / height;
      const ignored = options.ignore.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
      const delta = Math.max(Math.abs(left[p]! - right[p]!), Math.abs(left[p + 1]! - right[p + 1]!), Math.abs(left[p + 2]! - right[p + 2]!));
      mask[p] = ignored ? 0 : Math.min(255, delta * 4); mask[p + 1] = ignored ? 0 : delta;
    }
    const heatmap = await sharp(mask, { raw: { width, height, channels: 3 } }).png().toBuffer();
    await fs.writeFile(path.join(directory, `difference-${i}.png`), heatmap);
    const [aData, bData] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    htmlRows.push(`<section><h2>${row.beforeSeconds.toFixed(3)}s → ${row.afterSeconds.toFixed(3)}s · ${row.changed ? "Changed" : "Within threshold"}</h2><p>SSIM ${metrics.ssim.toFixed(4)} · changed pixels ${(metrics.changedFraction * 100).toFixed(2)}%${note ? ` · <span class="event">${escapeXml(note)}</span>` : ""}</p><div>${[aData, bData, heatmap].map((data, j) => `<figure><img alt="${["Before", "After", "Difference"][j]}" src="data:image/png;base64,${data.toString("base64")}"><figcaption>${["Before", "After", "Difference"][j]}</figcaption></figure>`).join("")}</div></section>`);
  }
  const report = { schemaVersion: 2, options: { ...options, offsets }, changedSamples: rows.filter(row => row.changed).length, rows, note: "Visual differences are candidates for review, not confirmed regressions. Only sampled timestamps are compared; motion between them may be missed." };
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(directory, "report.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ClipQA comparison</title><style>body{font:16px system-ui;background:#0d1117;color:#e6edf3;margin:32px}section{border-top:1px solid #30363d;padding:16px 0}div{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;flex:1;min-width:240px}img{width:100%}figcaption{color:#8b949e}h2{font-size:18px}.event{color:#fbbf24}</style><h1>ClipQA comparison</h1><p>${report.changedSamples}/${rows.length} samples changed. ${report.note}</p>${htmlRows.join("")}</html>`);
  const worst = rows.reduce((best, row, i) => row.score > rows[best]!.score ? i : best, 0);
  const previewPath = path.join(directory, "preview.jpg");
  const previews = await Promise.all(["before", "after", "difference"].map(async (name, i) => ({ input: await sharp(path.join(directory, `${name}-${worst}.png`)).resize(320, 180, { fit: "contain", background: "black" }).png().toBuffer(), left: i * 320, top: 0 })));
  await sharp({ create: { width: 960, height: 180, channels: 3, background: "black" } }).composite(previews).jpeg({ quality: 85 }).toFile(previewPath);
  return { ...report, previewSample: rows[worst], previewPath, reportPath: path.join(directory, "report.html"), jsonPath: path.join(directory, "report.json") };
}
