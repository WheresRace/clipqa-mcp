import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { MediaProcessor } from "../src/media.js";
import { indexVideo, compareVideos } from "../src/visual.js";
import { segmentArgs, pruneSegments, segmentFiles, finalizeReplay } from "../src/replay.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";

describe("real video feature integration", () => {
  const config = resolveConfig(), runner = new NodeCommandRunner(), media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
  let dir: string, clean: string, defect: string;
  async function generate(output: string, filter: string) {
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
    if (r.code) throw new Error(r.stderr);
  }
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-features-")); clean = path.join(dir, "clean.mp4"); defect = path.join(dir, "defect.mp4");
    await generate(clean, "color=c=gray:s=320x180:d=2:r=30");
    await generate(defect, "color=c=gray:s=320x180:d=2:r=30,drawbox=x=20:y=20:w=16:h=16:color=white:t=fill:enable='between(t,0.8,1.0)'");
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  it("indexes a subtle short defect missed by scene-cut detection", async () => {
    expect(await media.detectVisualChanges(defect)).toEqual([]);
    const index = await indexVideo(config.ffmpegPath, defect, 0, 1.9, 30);
    expect(index.changes.some(c => c.timestamp >= .79 && c.timestamp <= 1.05)).toBe(true);
    expect(index.decodedFrames).toBeGreaterThan(50);
    expect(await indexVideo(config.ffmpegPath, defect, 0, 1.9, 30)).toEqual(index);
  });
  it("reports static footage without inventing a defect", async () => {
    const index = await indexVideo(config.ffmpegPath, clean, 0, 1.9);
    expect(index.changes).toEqual([]); expect(index.warnings.join()).toContain("static");
  });
  it("compares real clips, produces standalone reports, and respects ignore masks", async () => {
    const options = { beforeStart: 0, afterStart: 0, seconds: 1.8, samples: 6, threshold: .08, ignore: [] };
    const same = await compareVideos(media, clean, clean, path.join(dir, "same"), options);
    expect(same.changedSamples).toBe(0);
    const changed = await compareVideos(media, clean, defect, path.join(dir, "changed"), options);
    expect(changed.changedSamples).toBe(1);
    expect(await fs.readFile(changed.reportPath, "utf8")).toContain("data:image/png;base64");
    expect(JSON.parse(await fs.readFile(changed.jsonPath, "utf8")).rows).toHaveLength(6);
    const masked = await compareVideos(media, clean, defect, path.join(dir, "masked"), { ...options, ignore: [{ x: .025, y: .04, width: .15, height: .25 }] });
    expect(masked.changedSamples).toBe(0);
  }, 30000);
  it("bounds disk segments and saves only the final N seconds", async () => {
    const ring = path.join(dir, "ring"); await fs.mkdir(ring);
    const result = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=15:d=14", "-c:v", "libx264", "-preset", "ultrafast", ...segmentArgs(ring, 15)]);
    expect(result.code).toBe(0); expect((await segmentFiles(ring)).length).toBeGreaterThan(5);
    await pruneSegments(ring, 5); expect((await segmentFiles(ring)).length).toBe(5);
    const output = path.join(ring, "recording.mp4");
    const replay = await finalizeReplay(ring, output, 5, config.ffmpegPath, config.ffprobePath, runner);
    expect(await media.duration(output)).toBeCloseTo(5, 1); expect(replay.offset).toBeCloseTo(9, 1);
    expect(await segmentFiles(ring)).toEqual([]);
  }, 15000);
  it("fails clearly on a nonexistent frame instead of returning a stale image", async () => {
    await expect(media.extractFrame(clean, 20, path.join(dir, "missing.jpg"))).rejects.toThrow("No frame");
  });
  it("runs import, event annotation, inspection, frame retrieval and comparison through MCP", async () => {
    const server = await createServer({ ...config, dataDir: path.join(dir, "mcp") });
    const client = new Client({ name: "feature-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result as { content: Array<{ type: string; text?: string; data?: string }> };
    };
    try {
      const first = JSON.parse((await call("import_clip", { filePath: clean })).content[0]!.text!);
      const second = JSON.parse((await call("import_clip", { filePath: defect })).content[0]!.text!);
      await call("mark_event", { sessionId: second.id, label: "assertion", timestampSeconds: .9 });
      const overview = await call("inspect_clip", { sessionId: second.id, samples: 4, indexFps: 30 });
      expect(overview.content.some(c => c.type === "image")).toBe(true);
      expect(JSON.parse(overview.content[0]!.text!).timestamps).toHaveLength(4);
      expect((await call("get_frames", { sessionId: second.id, timestamps: [.9] })).content.some(c => c.type === "image")).toBe(true);
      const comparison = await call("compare_clips", { beforeSessionId: first.id, afterSessionId: second.id, seconds: 1.8, samples: 6 });
      expect(JSON.parse(comparison.content[0]!.text!).changedSamples).toBe(1);
      const invalid = await client.callTool({ name: "mark_event", arguments: { sessionId: second.id, label: "invalid", timestampSeconds: 100 } });
      expect(invalid.isError).toBe(true);
      expect((await call("recording_progress", { sessionId: second.id, includeVideo: true })).content.map(c => c.type)).toEqual(["text", "image", "resource_link"]);
      expect((await call("get_clip", { sessionId: second.id })).content.some(c => c.type === "resource_link")).toBe(true);
      expect(JSON.parse((await call("cleanup_sessions", {})).content[0]!.text!).dryRun).toBe(true);
      await call("delete_session", { sessionId: first.id });
      await expect(fs.stat(first.videoPath)).rejects.toThrow();
    } finally { await client.close(); await server.close(); }
  }, 30000);
});
