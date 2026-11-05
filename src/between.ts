import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { escapeXml } from "./media.js";
import { decodeFrames, difference } from "./visual.js";
import type { Region } from "./types.js";

// Views of what happens BETWEEN sampled frames: every frame in a short range (strip), the path of moving
// parts in one image (onion skin), and a map of everything that changed in any frame of a range (change map).

export const MAX_STRIP_SECONDS = 10;
export const MAX_CHANGE_SECONDS = 60;

export interface StripFrame { index: number; timestamp: number; delta: number; kind: "repeat" | "jump" | "normal" }
export interface StripResult { outputPath: string; frames: StripFrame[]; step: number; sourceFps: number; repeats: number; jumps: number }

function plan(start: number, end: number, sourceFps: number, maxFrames: number) {
  if (!(end > start)) throw new Error("endSeconds must be after startSeconds.");
  const total = Math.max(1, Math.round((end - start) * sourceFps));
  const step = Math.max(1, Math.ceil(total / maxFrames));
  return { step, fps: sourceFps / step };
}

/**
 * Classify consecutive frames. `scores` (peak local change) say whether anything moved; `areas` (fraction of
 * pixels changed) say how far: a solid object moving 3 px and 150 px saturate the local score alike, but the
 * changed area grows with the distance travelled, so jumps are judged on area relative to nearby frames.
 */
export function classifyDeltas(scores: number[], areas: number[] = scores): StripFrame["kind"][] {
  const near = (values: number[], i: number) => values.slice(Math.max(1, i - 3), i).concat(values.slice(i + 1, i + 4));
  return scores.map((d, i) => {
    if (i === 0) return "normal";
    const moving = near(scores, i).some(v => v >= .015);
    if (d < .004 && moving) return "repeat";
    const around = near(areas, i).filter(v => v > 0).sort((a, b) => a - b);
    const local = around.length ? around[around.length >> 1]! : 0;
    if (d >= .06 && local > 0 && areas[i]! / local >= 4) return "jump";
    return "normal";
  });
}

export async function frameStrip(ffmpeg: string, video: string, start: number, end: number, sourceFps: number, outputPath: string, options: { maxFrames?: number; crop?: Region; columns?: number } = {}): Promise<StripResult> {
  if (end - start > MAX_STRIP_SECONDS) throw new Error(`Frame strips cover at most ${MAX_STRIP_SECONDS} seconds; narrow the range.`);
  const maxFrames = Math.min(48, Math.max(2, options.maxFrames ?? 24));
  const { step, fps } = plan(start, end, sourceFps, maxFrames);
  const width = 320, height = 180, tiles: Buffer[] = [], deltas: number[] = [], areas: number[] = [];
  let previous: Buffer | undefined;
  await decodeFrames(ffmpeg, video, start, end, fps, width, height, options.crop, frame => {
    if (tiles.length >= maxFrames) return;
    const d = previous ? difference(previous, frame, width, height) : undefined;
    deltas.push(d ? Number(Math.max(d.peakTileDifference, 1 - d.ssim).toFixed(4)) : 0);
    areas.push(d ? d.changedFraction : 0);
    tiles.push(frame); previous = frame;
  });
  const kinds = classifyDeltas(deltas, areas);
  const frames: StripFrame[] = tiles.map((_, i) => ({ index: i, timestamp: Number((start + i / fps).toFixed(3)), delta: deltas[i]!, kind: kinds[i]! }));
  const columns = Math.min(options.columns ?? 6, tiles.length), rows = Math.ceil(tiles.length / columns);
  const tileW = width + 8, tileH = height + 30;
  const composites: OverlayOptions[] = [];
  for (const [i, raw] of tiles.entries()) {
    const f = frames[i]!, left = (i % columns) * tileW + 4, top = Math.floor(i / columns) * tileH + 4;
    const color = f.kind === "repeat" ? "#fbbf24" : f.kind === "jump" ? "#f87171" : "#334155";
    composites.push({ input: await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer(), left, top });
    const tag = f.kind === "normal" ? "" : f.kind === "repeat" ? " REPEAT" : " JUMP";
    composites.push({ input: Buffer.from(`<svg width="${width}" height="26"><rect width="${width}" height="26" fill="${f.kind === "normal" ? "#111827" : color}"/><text x="6" y="18" font-family="Arial" font-size="13" fill="${f.kind === "normal" ? "#f9fafb" : "#111827"}">#${i + 1} · ${f.timestamp.toFixed(3)}s · Δ${f.delta.toFixed(3)}${escapeXml(tag)}</text></svg>`), left, top: top + height });
    if (f.kind !== "normal") composites.push({ input: Buffer.from(`<svg width="${width}" height="${height}"><rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" fill="none" stroke="${color}" stroke-width="3"/></svg>`), left, top });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({ create: { width: columns * tileW, height: rows * tileH, channels: 3, background: "#0b1020" } }).composite(composites).jpeg({ quality: 85 }).toFile(outputPath);
  return { outputPath, frames, step, sourceFps, repeats: frames.filter(f => f.kind === "repeat").length, jumps: frames.filter(f => f.kind === "jump").length };
}

/** Per-channel median of a few frames: a cheap estimate of the static background. */
function medianFrame(frames: Buffer[]): Buffer {
  const out = Buffer.allocUnsafe(frames[0]!.length), values = new Array<number>(frames.length);
  for (let p = 0; p < out.length; p++) {
    for (let i = 0; i < frames.length; i++) values[i] = frames[i]![p]!;
    values.sort((a, b) => a - b);
    out[p] = values[values.length >> 1]!;
  }
  return out;
}

export interface OnionResult { outputPath: string; frames: number; timestamps: number[]; movingFraction: number }

// Moving pixels from each frame are tinted from blue (earliest) to red (latest) over the static background,
// so arcs, pops and sliding contacts are visible in one picture.
export async function onionSkin(ffmpeg: string, video: string, start: number, end: number, sourceFps: number, outputPath: string, options: { frames?: number; crop?: Region } = {}): Promise<OnionResult> {
  if (end - start > MAX_STRIP_SECONDS) throw new Error(`Onion skins cover at most ${MAX_STRIP_SECONDS} seconds; narrow the range.`);
  const count = Math.min(16, Math.max(3, options.frames ?? 10));
  if (!(end > start)) throw new Error("endSeconds must be after startSeconds.");
  const fps = Math.min(sourceFps, count / (end - start));
  const width = 640, height = 360, frames: Buffer[] = [];
  await decodeFrames(ffmpeg, video, start, end, fps, width, height, options.crop, frame => { if (frames.length < count) frames.push(frame); });
  if (frames.length < 2) throw new Error("The range contains fewer than two frames.");
  const background = medianFrame(frames.length > 9 ? frames.filter((_, i) => i % 2 === 0) : frames);
  const out = Buffer.alloc(background.length);
  for (let p = 0; p < out.length; p++) out[p] = background[p]! * .45;
  let moving = 0;
  const n = frames.length;
  for (const [i, frame] of frames.entries()) {
    const t = n === 1 ? 1 : i / (n - 1), alpha = .35 + .65 * t;
    const tint = [Math.round(255 * t), 90, Math.round(255 * (1 - t))];
    for (let p = 0; p < frame.length; p += 3) {
      const d = Math.abs(frame[p]! - background[p]!) + Math.abs(frame[p + 1]! - background[p + 1]!) + Math.abs(frame[p + 2]! - background[p + 2]!);
      if (d < 45) continue;
      if (i === n - 1) moving++;
      for (let c = 0; c < 3; c++) {
        const lit = frame[p + c]! * .55 + tint[c]! * .45;
        out[p + c] = Math.round(out[p + c]! * (1 - alpha) + lit * alpha);
      }
    }
  }
  const legend = Buffer.from(`<svg width="${width}" height="24"><defs><linearGradient id="g"><stop offset="0" stop-color="#0050ff"/><stop offset="1" stop-color="#ff5000"/></linearGradient></defs><rect width="${width}" height="24" fill="#111827"/><rect x="8" y="7" width="160" height="10" fill="url(#g)"/><text x="178" y="17" font-family="Arial" font-size="13" fill="#f9fafb">earliest → latest · ${n} frames · ${start.toFixed(2)}–${end.toFixed(2)}s</text></svg>`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({ create: { width, height: height + 24, channels: 3, background: "#111827" } })
    .composite([{ input: await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer(), left: 0, top: 0 }, { input: legend, left: 0, top: height }])
    .jpeg({ quality: 88 }).toFile(outputPath);
  return { outputPath, frames: n, timestamps: frames.map((_, i) => Number((start + i / fps).toFixed(3))), movingFraction: Number((moving / (width * height)).toFixed(4)) };
}

export interface ChangeMapResult { outputPath: string; framesScanned: number; peak: { timestamp: number; score: number }; changedArea: number; hotspots: Region[] }

// Scans EVERY frame in the range (at the source rate, capped at 60 FPS) and keeps the largest per-pixel change
// between consecutive frames, so a flash or glitch that happens between two samples still shows up.
export async function changeMap(ffmpeg: string, video: string, start: number, end: number, sourceFps: number, outputPath: string, options: { crop?: Region } = {}): Promise<ChangeMapResult> {
  if (end - start > MAX_CHANGE_SECONDS) throw new Error(`Change maps cover at most ${MAX_CHANGE_SECONDS} seconds; narrow the range.`);
  if (!(end > start)) throw new Error("endSeconds must be after startSeconds.");
  const width = 320, height = 180, fps = Math.min(60, sourceFps);
  const maxDelta = new Uint8Array(width * height);
  let previous: Buffer | undefined, first: Buffer | undefined, framesScanned = 0, peak = { timestamp: start, score: 0 };
  await decodeFrames(ffmpeg, video, start, end, fps, width, height, options.crop, (frame, index) => {
    framesScanned++;
    if (!first) first = frame;
    if (previous) {
      for (let p = 0, q = 0; q < maxDelta.length; p += 3, q++) {
        const d = Math.max(Math.abs(frame[p]! - previous[p]!), Math.abs(frame[p + 1]! - previous[p + 1]!), Math.abs(frame[p + 2]! - previous[p + 2]!));
        if (d > maxDelta[q]!) maxDelta[q] = d;
      }
      const s = difference(previous, frame, width, height), score = Math.max(s.peakTileDifference, 1 - s.ssim);
      if (score > peak.score) peak = { timestamp: Number((start + index / fps).toFixed(3)), score: Number(score.toFixed(4)) };
    }
    previous = frame;
  }, { timeoutMs: 240_000 });
  if (!first) throw new Error("No frames in range.");
  let changed = 0;
  const overlay = Buffer.allocUnsafe(width * height * 3);
  for (let q = 0, p = 0; q < maxDelta.length; q++, p += 3) {
    const d = maxDelta[q]!, heat = Math.min(1, d / 96);
    if (d > 24) changed++;
    const base = (first[p]! * .2126 + first[p + 1]! * .7152 + first[p + 2]! * .0722) * .35;
    overlay[p] = Math.min(255, base + heat * 255); overlay[p + 1] = Math.min(255, base + heat * heat * 140); overlay[p + 2] = base * (1 - heat);
  }
  // Hotspots: grid cells (8x6) where more than 15% of pixels changed noticeably.
  const hotspots: Region[] = [];
  const cols = 8, rows = 6, cw = width / cols, ch = height / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let n = 0, hot = 0;
    for (let y = Math.floor(r * ch); y < Math.floor((r + 1) * ch); y++) for (let x = Math.floor(c * cw); x < Math.floor((c + 1) * cw); x++) { n++; if (maxDelta[y * width + x]! > 24) hot++; }
    if (hot / n > .15) hotspots.push({ x: c / cols, y: r / rows, width: 1 / cols, height: 1 / rows });
  }
  const scale = 2, legend = Buffer.from(`<svg width="${width * scale}" height="24"><rect width="${width * scale}" height="24" fill="#111827"/><text x="8" y="17" font-family="Arial" font-size="13" fill="#f9fafb">${framesScanned} frames scanned · bright = changed at some point · peak ${peak.score.toFixed(3)} at ${peak.timestamp.toFixed(3)}s</text></svg>`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({ create: { width: width * scale, height: height * scale + 24, channels: 3, background: "#111827" } })
    .composite([{ input: await sharp(overlay, { raw: { width, height, channels: 3 } }).resize(width * scale, height * scale).png().toBuffer(), left: 0, top: 0 }, { input: legend, left: 0, top: height * scale }])
    .jpeg({ quality: 86 }).toFile(outputPath);
  return { outputPath, framesScanned, peak, changedArea: Number((changed / maxDelta.length).toFixed(4)), hotspots: mergeHotspots(hotspots) };
}

/** Merge adjacent hotspot cells in the same row so the result stays short. */
function mergeHotspots(cells: Region[]): Region[] {
  const out: Region[] = [];
  for (const cell of cells) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - cell.y) < 1e-6 && Math.abs(last.x + last.width - cell.x) < 1e-6) last.width += cell.width;
    else out.push({ ...cell });
  }
  return out.slice(0, 12).map(r => ({ x: Number(r.x.toFixed(3)), y: Number(r.y.toFixed(3)), width: Number(r.width.toFixed(3)), height: Number(r.height.toFixed(3)) }));
}
