import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { changeMap, classifyDeltas, frameStrip, onionSkin } from "../src/between.js";

describe("in-between views", () => {
  const config = resolveConfig(), runner = new NodeCommandRunner();
  let dir: string, motion: string, flash: string;
  async function generate(output: string, filter: string) {
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...(filter.includes(";") ? ["-filter_complex", filter] : ["-f", "lavfi", "-i", filter]), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", output]);
    if (r.code) throw new Error(r.stderr);
  }
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-between-"));
    motion = path.join(dir, "motion.mp4"); flash = path.join(dir, "flash.mp4");
    // Box moves right, freezes for 0.5-0.7 s (repeated frames), then jumps forward at 1.0 s.
    await generate(motion, "color=c=gray:s=320x180:r=30:d=1.4[bg];color=c=white:s=30x30:r=30[box];[bg][box]overlay=x='if(lt(t,0.5),t*100,if(lt(t,0.7),50,if(lt(t,1.0),50+(t-0.7)*100,200+(t-1.0)*100)))':y=70:shortest=1");
    // One white frame-long flash at frame 15 on a static clip.
    await generate(flash, "color=c=gray:s=320x180:r=30:d=2,drawbox=x=200:y=40:w=40:h=40:color=white:t=fill:enable='eq(n,15)'");
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("classifies repeats inside motion and isolated jumps", () => {
    const kinds = classifyDeltas([0, .02, .02, .001, .02, .02, .3, .02, .02]);
    expect(kinds[3]).toBe("repeat"); expect(kinds[6]).toBe("jump"); expect(kinds[1]).toBe("normal");
  });

  it("strip shows every frame and flags the freeze and the jump", async () => {
    const strip = await frameStrip(config.ffmpegPath, motion, 0.3, 1.2, 30, path.join(dir, "strip.jpg"), { maxFrames: 48 });
    expect(strip.step).toBe(1);
    expect(strip.frames.length).toBeGreaterThanOrEqual(26);
    expect(strip.repeats).toBeGreaterThanOrEqual(3);
    expect(strip.frames.some(f => f.kind === "jump" && f.timestamp >= .95 && f.timestamp <= 1.05)).toBe(true);
    expect((await fs.stat(strip.outputPath)).size).toBeGreaterThan(5000);
  }, 30000);

  it("strip samples every Nth frame when the range is long", async () => {
    const strip = await frameStrip(config.ffmpegPath, motion, 0, 1.3, 30, path.join(dir, "strip-n.jpg"), { maxFrames: 10 });
    expect(strip.step).toBeGreaterThan(1); expect(strip.frames.length).toBeLessThanOrEqual(10);
  }, 30000);

  it("onion skin finds the moving subject", async () => {
    const onion = await onionSkin(config.ffmpegPath, motion, 0, .45, 30, path.join(dir, "onion.jpg"), { frames: 8 });
    expect(onion.frames).toBe(8); expect(onion.movingFraction).toBeGreaterThan(.005);
  }, 30000);

  it("change map catches a one-frame flash that sampling would miss", async () => {
    const map = await changeMap(config.ffmpegPath, flash, 0, 1.9, 30, path.join(dir, "changes.jpg"));
    expect(map.framesScanned).toBeGreaterThan(50);
    expect(map.peak.timestamp).toBeGreaterThanOrEqual(.45); expect(map.peak.timestamp).toBeLessThanOrEqual(.55);
    expect(map.hotspots.length).toBeGreaterThan(0);
    expect(map.hotspots[0]!.x).toBeGreaterThan(.5);
  }, 30000);

  it("refuses oversized ranges", async () => {
    await expect(frameStrip(config.ffmpegPath, motion, 0, 20, 30, path.join(dir, "x.jpg"))).rejects.toThrow(/at most/);
  });
});
