import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildCaptureArgs, Recorder, rebaseEvents, videoZeroFromProgress } from "../src/recorder.js";
import { regionFromCells } from "../src/media.js";
import { analyzeMotion, estimateLag, motionSeries } from "../src/visual.js";
import { blenderOrbitScript, locateViews, orbitViews, robloxOrbitScript } from "../src/orbit.js";
import { CHECKPOINTS, checklistText, scoreFindings } from "../src/qa.js";
import { LogWatcher, parseLogLine } from "../src/logs.js";
import { createServer, eventsNear, lagFromEvents, VERSION, zoomRegion } from "../src/server.js";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { SessionStore } from "../src/session-store.js";
import { segmentArgs } from "../src/replay.js";
import type { QaFinding } from "../src/types.js";

const finding = (checkpoint: string, status: QaFinding["status"], severity?: QaFinding["severity"]): QaFinding => ({ checkpoint, status, note: "n", recordedAt: "", ...(severity ? { severity } : {}) });

describe("timing", () => {
  it("anchors video t=0 at the first frame's wall time, not the spawn time", () => {
    expect(videoZeroFromProgress("frame=3\nout_time_us=100000\nprogress=continue\n", 10_000, 30)).toBe(9_900);
    expect(videoZeroFromProgress("frame=4\nout_time_us=N/A\nprogress=continue\n", 10_000, 30)).toBe(9_900);
  });
  it("keeps and shifts only events inside the saved window", () => {
    expect(rebaseEvents([{ timestampMs: 1000 }, { timestampMs: 6000 }, { timestampMs: 12000 }], 5, 5)).toEqual([{ timestampMs: 1000 }]);
  });
  it("reports the package version", async () => {
    expect(VERSION).toBe(JSON.parse(await fs.readFile("package.json", "utf8")).version);
  });
});

describe("crop and zoom", () => {
  it("crops before scaling for GDI and WGC capture", () => {
    const crop = { x: .25, y: .1, width: .5, height: .8 };
    const gdi = buildCaptureArgs({ hwnd: "1" }, "r.mp4", { fps: 30, maxSeconds: 10, drawMouse: false, encoder: "libx264", crop, maxWidth: 640 });
    expect(gdi[gdi.indexOf("-vf") + 1]).toBe("crop=trunc(iw*0.5/2)*2:trunc(ih*0.8/2)*2:trunc(iw*0.25):trunc(ih*0.1),scale='min(640,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2");
    const wgc = buildCaptureArgs({ hwnd: "1" }, "r.mp4", { fps: 30, maxSeconds: 10, drawMouse: false, encoder: "libx264", crop, backend: "gfxcapture" });
    expect(wgc[wgc.indexOf("-filter_complex") + 1]).toContain("fps=30,crop=trunc(iw*0.5/2)*2");
  });
  it("turns grid cells, ranges and center zooms into regions", () => {
    expect(regionFromCells("B2", 4, 2)).toEqual({ x: .25, y: .5, width: .25, height: .5 });
    expect(regionFromCells("C2:B1", 4, 2)).toEqual({ x: .25, y: 0, width: .5, height: 1 });
    expect(() => regionFromCells("E1", 4, 2)).toThrow("outside");
    expect(zoomRegion({ center: { x: 1, y: 0 }, factor: 4, gridColumns: 6, gridRows: 4 })).toEqual({ x: .75, y: 0, width: .25, height: .25 });
  });
});

describe("motion analysis", () => {
  const series = (means: number[]) => ({ fps: 30, start: 0, means, scores: means.map(m => m * 10) });
  it("calls steady motion smooth", () => {
    const report = analyzeMotion(series([0, ...Array(60).fill(.01)]), 30);
    expect(report.verdict).toBe("smooth"); expect(report.hitches).toEqual([]); expect(report.pops).toEqual([]);
  });
  it("flags repeated frames inside motion as hitches and spikes as pops", () => {
    const means = [0, ...Array(20).fill(.01), 0, 0, 0, ...Array(10).fill(.01), .08, ...Array(20).fill(.01)];
    const report = analyzeMotion(series(means), 60);
    expect(report.hitches[0]).toMatchObject({ frames: 3 });
    expect(report.pops[0]!.timestamp).toBeCloseTo(34 / 30, 2);
    expect(report.fluidityScore).toBeLessThan(90);
  });
  it("warns that low capture FPS hides hitches", () => {
    expect(analyzeMotion(series([0, .01, .01]), 10).warnings.join()).toContain("10 FPS");
  });
  it("finds the lag between two runs from their motion", () => {
    const pulse = (at: number) => Array.from({ length: 100 }, (_, i) => Math.exp(-((i - at) ** 2) / 4) + (i === at + 20 ? 1 : 0));
    expect(estimateLag(pulse(40), pulse(25), 10, 5).lagSeconds).toBeCloseTo(1.5, 5);
  });
  it("aligns on the first shared event label, preferring actions", () => {
    const before = [{ timestampMs: 500, label: "load", kind: "note" as const }, { timestampMs: 3000, label: "click play", kind: "action" as const }];
    const after = [{ timestampMs: 200, label: "load", kind: "note" as const }, { timestampMs: 1000, label: "click play", kind: "action" as const }];
    expect(lagFromEvents(before, after)).toEqual({ lagSeconds: 2, label: "click play" });
    expect(eventsNear(after, 1.1, .25)).toBe("click play");
  });
});

describe("orbit", () => {
  const options = { azimuthSteps: 8, elevations: [-30, 0, 89], zoomLevels: [1, 2.5], holdSeconds: .5, leadSeconds: 1, distanceScale: 1.3 };
  it("covers every azimuth at every elevation and zoom", () => {
    const views = orbitViews(options);
    expect(views).toHaveLength(48);
    expect(new Set(views.map(v => `${v.azimuth}/${v.elevation}/${v.zoom}`)).size).toBe(48);
    expect(views[4]!.label).toContain("back");
  });
  it("emits scripts that run every view and restore the camera", () => {
    const views = orbitViews(options);
    const lua = robloxOrbitScript("workspace.Rig", views, options);
    expect(lua.match(/\{-?\d+(\.\d+)?, -?\d+(\.\d+)?, \d+(\.\d+)?\}/g)).toHaveLength(48);
    expect(lua).toContain("task.spawn"); expect(lua).toContain("Selection:Set({})"); expect(lua).toContain("camera.CameraType = previousType");
    expect(lua).not.toMatch(/^\s*--/m);
    const py = blenderOrbitScript("Armature", views, options);
    expect(py).toContain("bpy.app.timers.register"); expect(py).toContain('TARGET = "Armature"');
  });
  it("locates held views from camera cuts, falling back to the plan when a cut is missing", () => {
    const fps = 30, scores = Array(300).fill(0);
    const cuts = [1, 2.5, 3, 3.5, 4.5];
    for (const t of cuts) scores[Math.round(t * fps)] = .3;
    const located = locateViews(scores, fps, 0, 5, { holdSeconds: .5, leadSeconds: 1 }, 0);
    expect(located.anchor).toBeCloseTo(1, 2);
    expect(located.timestamps.map(t => Number(t.toFixed(2)))).toEqual([2.05, 2.85, 3.35, 3.85, 4.35]);
    expect(located.matchedCuts).toBe(3);
  });
});

describe("QA rubric", () => {
  it("covers the requested failure classes", () => {
    const text = checklistText("wave with the left hand");
    for (const words of ["Body proportions", "candy", "left vs right", "hitches", "every angle"]) expect(text).toContain(words);
  });
  it("scores and gives verdicts", () => {
    const all = CHECKPOINTS.map(c => finding(c.id, "pass"));
    expect(scoreFindings(all)).toMatchObject({ score: 100, verdict: "PASS" });
    expect(scoreFindings(all.slice(1)).verdict).toBe("INCOMPLETE");
    expect(scoreFindings([...all, finding("mesh.twisting", "fail", "blocker")]).verdict).toBe("FAIL");
    const minor = scoreFindings([...all, finding("render.materials", "fail", "minor")]);
    expect(minor.verdict).toBe("NEEDS WORK"); expect(minor.score).toBeLessThan(100);
    expect(scoreFindings([...all, finding("mesh.twisting", "fail"), finding("mesh.twisting", "pass")]).verdict).toBe("PASS");
  });
});

describe("logs", () => {
  it("parses Roblox-style timestamps and levels", () => {
    const line = parseLogLine("2026-10-29T10:00:01.250Z,12.5,1a2b,6 [FLog::Output] Hello world", "log.txt", 0);
    expect(line).toMatchObject({ wallMs: Date.parse("2026-10-29T10:00:01.250Z"), label: "[FLog::Output] Hello world", kind: "note" });
    expect(parseLogLine("Script error: boom", "x.log", 5).kind).toBe("error");
  });
  it("follows only new matching lines, including the newest file in a directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-logs-"));
    try {
      await fs.writeFile(path.join(dir, "a.log"), "old CLIPQA line\n");
      const lines: string[] = [];
      const watcher = new LogWatcher(dir, /CLIPQA/, l => lines.push(l.label));
      await watcher.start();
      await fs.appendFile(path.join(dir, "a.log"), "noise\nCLIPQA_ORBIT 1\nCLIPQA_ORBIT 2 partial");
      await watcher.poll();
      expect(lines).toEqual(["CLIPQA_ORBIT 1"]);
      await new Promise(r => setTimeout(r, 30));
      await fs.writeFile(path.join(dir, "b.log"), "CLIPQA new file\n");
      await watcher.poll();
      await watcher.stop();
      expect(lines).toEqual(["CLIPQA_ORBIT 1", "CLIPQA new file"]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe("real video QA features", () => {
  const config = resolveConfig(), runner = new NodeCommandRunner();
  let dir: string;
  const generate = async (output: string, filter: string) => {
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
    if (r.code) throw new Error(r.stderr);
  };
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-qa-")); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("scores smooth motion above motion with a freeze and a jump", async () => {
    const smooth = path.join(dir, "smooth.mp4"), hitch = path.join(dir, "hitch.mp4");
    await generate(smooth, "color=c=gray:s=320x180:d=3:r=30[bg];color=c=white:s=40x40:r=30[fg];[bg][fg]overlay=x='20+t*60':y=60:shortest=1");
    await generate(hitch, "color=c=gray:s=320x180:d=3:r=30[bg];color=c=white:s=40x40:r=30[fg];[bg][fg]overlay=x='if(between(t,1,1.3),80,20+t*60)':y=60:shortest=1");
    const a = analyzeMotion(await motionSeries(config.ffmpegPath, smooth, 0, 2.9, 30), 30);
    const b = analyzeMotion(await motionSeries(config.ffmpegPath, hitch, 0, 2.9, 30), 30);
    expect(a.verdict).toBe("smooth");
    expect(b.hitches.some(h => h.start >= .9 && h.end <= 1.4)).toBe(true);
    expect(b.fluidityScore).toBeLessThan(a.fluidityScore);
  }, 30000);

  it("builds orbit sheets from a stepped camera recording through MCP", async () => {
    const orbit = path.join(dir, "orbit.mp4");
    await generate(orbit, "color=c=gray:s=320x180:d=5:r=30[bg];color=c=white:s=30x30:r=30[fg];[bg][fg]overlay=x='20+40*floor(t/0.6)':y=60:shortest=1");
    const server = await createServer({ ...config, dataDir: path.join(dir, "mcp") });
    const client = new Client({ name: "orbit-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const imported = await client.callTool({ name: "import_clip", arguments: { filePath: orbit } }) as { content: Array<{ text: string }> };
      const id = JSON.parse(imported.content[0]!.text).id;
      const plan = await client.callTool({ name: "orbit_plan", arguments: { engine: "roblox", target: "workspace.Rig", azimuthSteps: 4, elevations: [0], zoomLevels: [1], holdSeconds: .6, leadSeconds: 0 } }) as { content: Array<{ type: string; text: string }> };
      expect(plan.content[1]!.text).toContain("workspace.Rig");
      const sheet = await client.callTool({ name: "orbit_sheet", arguments: { sessionId: id, azimuthSteps: 4, elevations: [0], zoomLevels: [1], holdSeconds: .6, leadSeconds: 0 } }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      expect(sheet.isError, JSON.stringify(sheet.content)).not.toBe(true);
      const result = JSON.parse(sheet.content[0]!.text!);
      expect(result.anchorSeconds).toBeCloseTo(.6, 1);
      expect(result.views.map((v: { timestamp: number }) => v.timestamp)).toEqual([1.02, 1.62, 2.22, 2.82]);
      expect(sheet.content.filter(c => c.type === "image")).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  }, 30000);

  it("recovers an interrupted recording from its segments", async () => {
    const store = new SessionStore(path.join(dir, "store")); await store.initialize();
    const id = "00000000-0000-4000-8000-000000000001", sessionDir = store.sessionDir(id);
    await store.create({ id, state: "interrupted", target: { title: "x" }, startedAt: new Date().toISOString(), fps: 15, encoder: "libx264", drawMouse: false, maxSeconds: 60, videoPath: path.join(sessionDir, "recording.mp4"), events: [{ timestampMs: 1000, label: "kept", kind: "note" }], error: "killed" });
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=15:d=6", "-c:v", "libx264", "-preset", "ultrafast", ...segmentArgs(sessionDir, 15)]);
    expect(r.code).toBe(0);
    const recovered = await new Recorder(store, config.ffmpegPath, runner, config.ffprobePath).recover(id);
    expect(recovered.state).toBe("stopped"); expect(recovered.error).toBeUndefined();
    expect(recovered.events.map(e => e.label)).toEqual(["kept"]);
    expect((await fs.stat(recovered.videoPath)).size).toBeGreaterThan(0);
  }, 30000);
});
