import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { createServer } from "../src/server.js";
import { mergeAnswers, parseAnswer, Processes, Roundtable, roundtableConfig, type Answer, type Packet, type Reviewer } from "../src/roundtable.js";
import { sessionCheckpoints } from "../src/qa.js";
import type { RecordingSession, RoundtableRecord } from "../src/types.js";

const answer = (over: Partial<Answer> = {}): Answer => ({ agree: false, missed: [], disputed: [], confidence: .7, ...over });
class FakeReviewer implements Reviewer {
  calls = 0; overhead = 500;
  constructor(readonly name: string, private readonly reply: () => Promise<{ answer?: Answer; tokens?: { input: number; output: number } }>, private readonly up = true) {}
  async available() { return this.up; }
  async run(_p: Packet, _d: string, _s: AbortSignal) { this.calls++; return this.reply(); }
}
const session = (over: Partial<RecordingSession> = {}) => ({ id: "s1", state: "stopped", target: {}, startedAt: "", fps: 30, encoder: "", drawMouse: false, maxSeconds: 10, videoPath: "", events: [], profile: "general", ...over }) as RecordingSession;
const packet: Packet = { text: "review", estimatedTokens: 1000 };

describe("roundtable answers", () => {
  it("parses structured answers, JSON inside text, and rejects junk", () => {
    expect(parseAnswer({ agree: true, missed: [], disputed: [], confidence: .9 })?.agree).toBe(true);
    expect(parseAnswer('Sure: {"agree": false, "missed": [{"checkpoint": "x", "issue": "foot slides", "timestampSeconds": 1.2, "severity": "major"}], "disputed": [], "confidence": 0.6}')?.missed[0]?.issue).toBe("foot slides");
    expect(parseAnswer("no json here")).toBeUndefined();
    expect(parseAnswer({ agree: true, missed: [{ checkpoint: "a", issue: "x".repeat(900), timestampSeconds: "bad", severity: "weird" }], disputed: [{ checkpoint: "b", suggestedGrade: 9, reason: "r" }] })).toMatchObject({ missed: [{ timestampSeconds: null, severity: "minor" }], disputed: [{ suggestedGrade: 4 }] });
  });
  it("merges reviewers, ranking issues raised by both first", () => {
    const ids = ["perf.framerate", "general.glitches"];
    const merged = mergeAnswers([
      { name: "a", ok: true, seconds: 1, answer: answer({ agree: true, disputed: [{ checkpoint: "perf.framerate", suggestedGrade: 1, reason: "stutters at 2s" }], missed: [{ checkpoint: "general.glitches", issue: "texture pops in", timestampSeconds: 3, severity: "minor" }] }) },
      { name: "b", ok: true, seconds: 1, answer: answer({ disputed: [{ checkpoint: "perf.framerate", suggestedGrade: 2, reason: "drops" }], missed: [{ checkpoint: "made.up", issue: "ghost", timestampSeconds: null, severity: "major" }] }) },
      { name: "c", ok: false, seconds: 1, error: "auth" },
    ], ids);
    expect(merged.agreement).toBe(.5);
    expect(merged.challenges[0]).toMatchObject({ checkpoint: "perf.framerate", kind: "disputed", raisedBy: ["a", "b"] });
    expect(merged.challenges.find(c => c.issue.includes("ghost"))?.checkpoint).toBe("other");
  });
  it("reads its configuration from the environment with safe bounds", () => {
    expect(roundtableConfig({})).toMatchObject({ mode: "auto", reviewers: ["claude", "codex"], claudeModel: "haiku", maxTokens: 24000 });
    expect(roundtableConfig({ CLIPQA_ROUNDTABLE: "OFF", CLIPQA_ROUNDTABLE_REVIEWERS: "codex,evil", CLIPQA_ROUNDTABLE_MAX_TOKENS: "1" })).toMatchObject({ mode: "off", reviewers: ["codex"], maxTokens: 4000 });
  });
});

describe("roundtable runs", () => {
  let dir: string;
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-rt-")); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const cfg = roundtableConfig({});

  it("caches a finished audit so asking again spends nothing", async () => {
    const fake = new FakeReviewer("fake", async () => ({ answer: answer({ agree: true }), tokens: { input: 900, output: 40 } }));
    const rt = new Roundtable(cfg, [fake]);
    let saved: RoundtableRecord | undefined;
    const s = session();
    const first = await rt.review(s, packet, dir, async r => { saved = r; });
    expect(first.state).toBe("done"); expect(first.reviewers[0]!.tokens).toEqual({ input: 900, output: 40 });
    const again = await rt.review({ ...s, roundtable: saved! }, packet, dir, async () => undefined);
    expect(again.key).toBe(first.key); expect(fake.calls).toBe(1);
    await rt.review({ ...s, roundtable: saved! }, { ...packet, text: "changed review" }, dir, async () => undefined);
    expect(fake.calls).toBe(2);
  });
  it("shares one run between concurrent callers", async () => {
    const fake = new FakeReviewer("slow", () => new Promise(r => setTimeout(() => r({ answer: answer() }), 100)));
    const rt = new Roundtable(cfg, [fake]);
    await Promise.all([rt.review(session(), packet, dir, async () => undefined), rt.review(session(), packet, dir, async () => undefined)]);
    expect(fake.calls).toBe(1);
  });
  it("respects the token budget and skips when nothing is installed", async () => {
    const big = new FakeReviewer("big", async () => ({ answer: answer() }));
    const tight = new Roundtable({ ...cfg, maxTokens: 4000 }, [big]);
    expect((await tight.review(session(), { ...packet, estimatedTokens: 9000 }, dir, async () => undefined)).state).toBe("skipped");
    expect(big.calls).toBe(0);
    const none = new Roundtable(cfg, [new FakeReviewer("missing", async () => ({}), false)]);
    expect((await none.review(session(), packet, dir, async () => undefined)).note).toContain("No reviewer");
  });
  it("stops retrying a reviewer whose sign-in failed", async () => {
    const broken = new FakeReviewer("broken", async () => { throw new Error("Failed to authenticate: OAuth session expired"); });
    const rt = new Roundtable(cfg, [broken]);
    expect((await rt.review(session(), packet, dir, async () => undefined)).state).toBe("failed");
    expect((await rt.review(session(), { ...packet, text: "new" }, dir, async () => undefined)).state).toBe("skipped");
    expect(broken.calls).toBe(1);
    expect((await rt.status())[0]).toMatchObject({ available: false });
  });
});

describe("reviewer processes", () => {
  it("kills timed-out and outstanding children", async () => {
    const p = new Processes();
    const sleeper = ["-e", "setTimeout(() => {}, 60000)"];
    await expect(p.run(process.execPath, sleeper, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    const pending = p.run(process.execPath, sleeper, { timeoutMs: 60000 });
    await new Promise(r => setTimeout(r, 200));
    expect(p.size).toBe(1);
    p.killAll();
    expect(p.size).toBe(0);
    await pending.catch(() => undefined);
    const echo = await p.run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdin: "hello", timeoutMs: 10000 });
    expect(echo.stdout).toBe("hello");
  }, 20000);
});

describe("roundtable through MCP", () => {
  const config = resolveConfig(), runner = new NodeCommandRunner();
  let dir: string, clip: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-rt-mcp-")); clip = path.join(dir, "clip.mp4");
    const r = await runner.run(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
    if (r.code) throw new Error(r.stderr);
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("audits a complete review once and reports challenges with token use", async () => {
    const fake = new FakeReviewer("fake-haiku", async () => ({ answer: answer({ missed: [{ checkpoint: "general.glitches", issue: "colour bars flash at 1.2s", timestampSeconds: 1.2, severity: "minor" }] }), tokens: { input: 3100, output: 120 } }));
    const server = await createServer({ ...config, dataDir: path.join(dir, "sessions") }, { roundtable: new Roundtable(roundtableConfig({}), [fake]) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const texts = (r.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text!);
      if (r.isError) throw new Error(texts[0]);
      return JSON.parse(texts.find(t => t.trimStart().startsWith("{"))!);
    };
    try {
      const imported = await call("import_clip", { filePath: clip });
      const id = imported.id ?? imported.sessionId;
      await call("qa_review", { sessionId: id, profile: "general", request: "test pattern plays", samples: 4 });
      const partial = await call("qa_report", { sessionId: id });
      expect(partial.verdict).toBe("INCOMPLETE"); expect(partial.roundtable.note).toContain("once every checkpoint");
      expect(fake.calls).toBe(0);
      const s = JSON.parse(await fs.readFile(path.join(dir, "sessions", id, "session.json"), "utf8")) as RecordingSession;
      const graded = new Set((s.findings ?? []).map(f => f.checkpoint));
      for (const c of sessionCheckpoints(s)) if (!graded.has(c.id)) await call("record_finding", { sessionId: id, checkpoint: c.id, grade: 3, note: "looked at it" });
      const report = await call("qa_report", { sessionId: id, waitSeconds: 10 });
      expect(report.roundtable.state).toBe("done");
      expect(report.roundtable.challenges[0]).toMatchObject({ checkpoint: "general.glitches", kind: "missed" });
      expect(report.roundtable.reviewers[0].tokens).toBe(3220);
      expect(await fs.readFile(report.reportPath, "utf8")).toContain("Roundtable audit");
      const again = await call("roundtable_review", { sessionId: id });
      expect(again.roundtable.state).toBe("done"); expect(fake.calls).toBe(1);
    } finally { await client.close(); await server.close(); }
  }, 60000);
});
