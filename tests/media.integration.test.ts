import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { MediaProcessor } from "../src/media.js";
import { NodeCommandRunner } from "../src/process-runner.js";

describe("MediaProcessor integration", () => {
  const config = resolveConfig();
  const runner = new NodeCommandRunner();
  const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
  let directory: string;
  let videoPath: string;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-media-"));
    videoPath = path.join(directory, "scene-change.mp4");
    const result = await runner.run(config.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=0.6:r=30",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=0.6:r=30",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ]);
    if (result.code !== 0) throw new Error(result.stderr);
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true });
  });

  it("probes duration and finds the synthetic scene change", async () => {
    expect(await media.duration(videoPath)).toBeCloseTo(1.2, 1);
    const changes = await media.detectVisualChanges(videoPath, 0.1);
    expect(changes.some((time) => time >= 0.5 && time <= 0.7)).toBe(true);
  });

  it("extracts frames and creates a readable contact sheet", async () => {
    const framePath = path.join(directory, "frame.jpg");
    const sheetPath = path.join(directory, "sheet.jpg");
    await media.extractFrame(videoPath, 0.2, framePath);
    await media.createContactSheet(videoPath, sheetPath, [0.2, 0.8]);
    expect((await fs.stat(framePath)).size).toBeGreaterThan(100);
    expect((await fs.stat(sheetPath)).size).toBeGreaterThan(1000);
  });
});
