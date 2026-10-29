import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { CommandRunner } from "./process-runner.js";
import { conciseError } from "./process-runner.js";
import type { Region } from "./types.js";

export function cropFilter(region?: Region): string {
  if (!region) return "";
  const n = (value: number) => Number(value.toFixed(6));
  return `crop=trunc(iw*${n(region.width)}/2)*2:trunc(ih*${n(region.height)}/2)*2:trunc(iw*${n(region.x)}):trunc(ih*${n(region.y)}),`;
}

export function regionFromCells(cells: string, columns: number, rows: number): Region {
  const parse = (cell: string) => {
    const m = /^([A-Z])(\d{1,2})$/i.exec(cell.trim());
    if (!m) throw new Error(`Invalid grid cell "${cell}". Use a column letter and row number such as B3.`);
    const column = m[1]!.toUpperCase().charCodeAt(0) - 65, row = Number(m[2]) - 1;
    if (column >= columns || row < 0 || row >= rows) throw new Error(`Grid cell ${cell} is outside the ${columns}x${rows} grid.`);
    return { column, row };
  };
  const parts = cells.split(":").map(parse);
  if (!parts.length || parts.length > 2) throw new Error("Use one cell such as B3 or a range such as B2:C3.");
  const a = parts[0]!, b = parts[1] ?? a;
  const left = Math.min(a.column, b.column), right = Math.max(a.column, b.column), top = Math.min(a.row, b.row), bottom = Math.max(a.row, b.row);
  return { x: left / columns, y: top / rows, width: (right - left + 1) / columns, height: (bottom - top + 1) / rows };
}

export function gridOverlay(width: number, height: number, columns: number, rows: number): Buffer {
  const lines: string[] = [];
  for (let c = 1; c < columns; c++) lines.push(`<line x1="${c * width / columns}" y1="0" x2="${c * width / columns}" y2="${height}"/>`);
  for (let r = 1; r < rows; r++) lines.push(`<line x1="0" y1="${r * height / rows}" x2="${width}" y2="${r * height / rows}"/>`);
  const size = Math.max(11, Math.round(Math.min(width / columns, height / rows) / 6));
  const labels: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    labels.push(`<text x="${c * width / columns + 4}" y="${r * height / rows + size + 2}">${String.fromCharCode(65 + c)}${r + 1}</text>`);
  }
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g stroke="#00e5ff" stroke-opacity="0.7" stroke-width="1">${lines.join("")}</g><g font-family="Arial" font-size="${size}" font-weight="bold" fill="#00e5ff" stroke="#000" stroke-width="3" paint-order="stroke">${labels.join("")}</g></svg>`);
}

export const escapeXml = (text: string) => text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[c]!);

export class MediaProcessor {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly runner: CommandRunner,
  ) {}

  async frameRate(videoPath: string): Promise<number> {
    const result = await this.runner.run(this.ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
    const [n, d] = result.stdout.trim().split("/").map(Number);
    const rate = n! / (d ?? 1);
    return Number.isFinite(rate) && rate > 0 ? rate : 30;
  }

  async duration(videoPath: string): Promise<number> {
    const result = await this.runner.run(this.ffprobePath, [
      "-v",
      "error",
      "-protocol_whitelist", "file,pipe",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    if (result.code !== 0) throw new Error(`Unable to inspect clip: ${conciseError(result.stderr)}`);
    const duration = Number(result.stdout.trim());
    if (!Number.isFinite(duration)) throw new Error("FFprobe returned an invalid duration.");
    return duration;
  }

  async lastFrameTime(videoPath: string): Promise<number> {
    const duration = await this.duration(videoPath);
    return Math.max(0, Math.floor((duration - 1 / await this.frameRate(videoPath)) * 1000) / 1000);
  }

  async extractFrame(videoPath: string, timestamp: number, outputPath: string, maxWidth = 1280, crop?: Region): Promise<void> {
    await this.extractFrames(videoPath, [{ timestamp, outputPath }], maxWidth, crop);
  }

  // One FFmpeg process per batch, with a fast seek per input instead of one process per frame.
  async extractFrames(videoPath: string, frames: Array<{ timestamp: number; outputPath: string }>, maxWidth = 1280, crop?: Region): Promise<void> {
    for (let start = 0; start < frames.length; start += 12) {
      const batch = frames.slice(start, start + 12);
      const inputs: string[] = [], outputs: string[] = [];
      for (const [index, frame] of batch.entries()) {
        await fs.mkdir(path.dirname(frame.outputPath), { recursive: true });
        await fs.unlink(frame.outputPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        inputs.push("-ss", frame.timestamp.toFixed(3), "-protocol_whitelist", "file,pipe", "-i", videoPath);
        outputs.push("-map", `${index}:v:0`, "-frames:v", "1", "-vf", `${cropFilter(crop)}scale='min(${maxWidth},iw)':-2`, ...(/\.jpe?g$/i.test(frame.outputPath) ? ["-pix_fmt", "yuvj420p"] : []), "-q:v", "2", frame.outputPath);
      }
      const result = await this.runner.run(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, ...outputs]);
      if (result.code !== 0) throw new Error(`Unable to extract frame: ${conciseError(result.stderr)}`);
      for (const frame of batch) {
        if (!(await fs.stat(frame.outputPath).catch(() => undefined))?.size) throw new Error(`No frame at ${frame.timestamp.toFixed(3)}s. Request a time strictly before the clip duration.`);
      }
    }
  }

  async zoomFrame(videoPath: string, timestamp: number, region: Region, outputPath: string, outputWidth: number, sharpen: boolean): Promise<{ sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; magnification: number }> {
    const native = outputPath.replace(/\.[^.]+$/, ".native.png");
    await this.extractFrame(videoPath, timestamp, native, 7680, region);
    const meta = await sharp(native).metadata();
    const sourceWidth = meta.width ?? 1, sourceHeight = meta.height ?? 1;
    let image = sharp(native).resize({ width: outputWidth, kernel: "lanczos3" });
    if (sharpen) image = image.sharpen({ sigma: 1 });
    const info = await image.jpeg({ quality: 92 }).toFile(outputPath);
    return { sourceWidth, sourceHeight, outputWidth: info.width, outputHeight: info.height, magnification: Number((info.width / sourceWidth).toFixed(2)) };
  }

  async gridFrame(videoPath: string, timestamp: number, outputPath: string, columns: number, rows: number, maxWidth = 1280, crop?: Region): Promise<void> {
    const plain = outputPath.replace(/\.[^.]+$/, ".plain.png");
    await this.extractFrame(videoPath, timestamp, plain, maxWidth, crop);
    const meta = await sharp(plain).metadata();
    await sharp(plain).composite([{ input: gridOverlay(meta.width ?? maxWidth, meta.height ?? 720, columns, rows), left: 0, top: 0 }]).jpeg({ quality: 88 }).toFile(outputPath);
  }

  async detectVisualChanges(
    videoPath: string,
    threshold = 0.25,
    maxChanges = 8,
  ): Promise<number[]> {
    if (threshold <= 0 || threshold >= 1) throw new Error("Scene threshold must be between 0 and 1.");
    if (!Number.isInteger(maxChanges) || maxChanges < 1) throw new Error("maxChanges must be at least 1.");
    const result = await this.runner.run(this.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "info",
      "-protocol_whitelist", "file,pipe",
      "-i",
      videoPath,
      "-an",
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ]);
    if (result.code !== 0) {
      throw new Error(`Unable to detect visual changes: ${conciseError(result.stderr)}`);
    }
    const timestamps = [...result.stderr.matchAll(/pts_time:\s*([0-9.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    if (timestamps.length <= maxChanges) return timestamps;
    if (maxChanges === 1) return [timestamps[0]!];
    const step = (timestamps.length - 1) / (maxChanges - 1);
    return Array.from({ length: maxChanges }, (_, index) => timestamps[Math.round(index * step)]!);
  }

  async createContactSheet(
    videoPath: string,
    outputPath: string,
    timestamps: number[],
    options: { labels?: string[]; titles?: string[]; crop?: Region; columns?: number } = {},
  ): Promise<number[]> {
    if (timestamps.length === 0) throw new Error("At least one timestamp is required.");
    const frameDir = path.join(path.dirname(outputPath), "overview-frames");
    const files = timestamps.map((_, index) => path.join(frameDir, `${String(index).padStart(3, "0")}.jpg`));
    await this.extractFrames(videoPath, timestamps.map((timestamp, index) => ({ timestamp, outputPath: files[index]! })), 1280, options.crop);

    const columns = Math.min(options.columns ?? 4, timestamps.length);
    const rows = Math.ceil(timestamps.length / columns);
    const tileWidth = 336;
    const tileHeight = 244;
    const composites: OverlayOptions[] = [];

    for (const [index, file] of files.entries()) {
      const frame = await sharp(file)
        .resize(320, 180, { fit: "contain", background: "#05070d" })
        .jpeg({ quality: 82 })
        .toBuffer();
      const heading = escapeXml(options.titles?.[index] ?? `${timestamps[index]!.toFixed(3)}s`);
      const note = escapeXml((options.labels?.[index] ?? "").slice(0, 46));
      const label = Buffer.from(
        `<svg width="320" height="48"><rect width="320" height="48" fill="#111827"/><text x="8" y="18" font-family="Arial" font-size="14" fill="#f9fafb">${heading}</text><text x="8" y="38" font-family="Arial" font-size="12" fill="#fbbf24">${note}</text></svg>`,
      );
      const left = (index % columns) * tileWidth + 8;
      const top = Math.floor(index / columns) * tileHeight + 8;
      composites.push({ input: frame, left, top });
      composites.push({ input: label, left, top: top + 180 });
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({
      create: {
        width: columns * tileWidth,
        height: rows * tileHeight,
        channels: 3,
        background: "#0b1020",
      },
    })
      .composite(composites)
      .jpeg({ quality: 88 })
      .toFile(outputPath);
    return timestamps;
  }
}
