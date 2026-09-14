import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { CommandRunner } from "./process-runner.js";
import { conciseError } from "./process-runner.js";

export class MediaProcessor {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly runner: CommandRunner,
  ) {}

  async duration(videoPath: string): Promise<number> {
    const result = await this.runner.run(this.ffprobePath, [
      "-v",
      "error",
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

  async extractFrame(videoPath: string, timestamp: number, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.runner.run(this.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      timestamp.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      "-q:v",
      "2",
      outputPath,
    ]);
    if (result.code !== 0) throw new Error(`Unable to extract frame: ${conciseError(result.stderr)}`);
  }

  async detectVisualChanges(
    videoPath: string,
    threshold = 0.25,
    maxChanges = 8,
  ): Promise<number[]> {
    const result = await this.runner.run(this.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "info",
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
    const step = (timestamps.length - 1) / (maxChanges - 1);
    return Array.from({ length: maxChanges }, (_, index) => timestamps[Math.round(index * step)]!);
  }

  async createContactSheet(
    videoPath: string,
    outputPath: string,
    timestamps: number[],
  ): Promise<number[]> {
    if (timestamps.length === 0) throw new Error("At least one timestamp is required.");
    const frameDir = path.join(path.dirname(outputPath), "overview-frames");
    const files: string[] = [];
    for (const [index, timestamp] of timestamps.entries()) {
      const file = path.join(frameDir, `${String(index).padStart(3, "0")}.jpg`);
      await this.extractFrame(videoPath, timestamp, file);
      files.push(file);
    }

    const columns = Math.min(4, timestamps.length);
    const rows = Math.ceil(timestamps.length / columns);
    const tileWidth = 336;
    const tileHeight = 220;
    const composites: OverlayOptions[] = [];

    for (const [index, file] of files.entries()) {
      const frame = await sharp(file)
        .resize(320, 180, { fit: "contain", background: "#05070d" })
        .jpeg({ quality: 82 })
        .toBuffer();
      const label = Buffer.from(
        `<svg width="320" height="24"><rect width="320" height="24" fill="#111827"/><text x="8" y="17" font-family="Arial" font-size="14" fill="#f9fafb">${timestamps[index]!.toFixed(3)}s</text></svg>`,
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
