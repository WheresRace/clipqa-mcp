// Memory and handle leak check. Run: npm run leak-check
// Repeats every heavy operation through the real MCP server, forcing GC between rounds, and fails if the heap
// keeps growing or if timers, child processes or pipes are left behind after the server closes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveConfig } from "../src/config.js";
import { NodeCommandRunner } from "../src/process-runner.js";
import { createServer } from "../src/server.js";
import { Roundtable, roundtableConfig, type Answer, type Reviewer } from "../src/roundtable.js";
import { sessionCheckpoints } from "../src/qa.js";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) { console.error("Run with node --expose-gc (npm run leak-check does this)."); process.exit(2); }
const ROUNDS = Number(process.env.ROUNDS ?? 30);
// Resources that exist before ClipQA starts (this script's own stdio pipes, for example) are not leaks.
const baseline = process.getActiveResourcesInfo();
const count = (list: string[]) => list.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map<string, number>());

const config = resolveConfig(), runner = new NodeCommandRunner();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-leak-"));
const clipA = path.join(dir, "a.mp4"), clipB = path.join(dir, "b.mp4");
const graph = (x: string) => `color=c=0x203040:s=640x360:r=30:d=6[bg];color=c=orange:s=60x60:r=30[box];[bg][box]overlay=x='${x}':y=150:shortest=1`;
for (const [file, x] of [[clipA, "t*80"], [clipB, "if(lt(t,2),t*80,160+(t-2)*80)"]] as const) {
  const r = await runner.run(config.ffmpegPath, ["-y", "-loglevel", "error", "-filter_complex", graph(x), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
  if (r.code) throw new Error(r.stderr);
}
// A reviewer that spawns a real child process per review, like the Claude/Codex reviewers do.
const fake: Reviewer = { name: "fake", overhead: 100, available: async () => true, run: async () => {
  const { Processes } = await import("../src/roundtable.js");
  await new Processes().run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdin: "{}", timeoutMs: 10000 });
  return { answer: { agree: true, missed: [], disputed: [], confidence: 1 } as Answer, tokens: { input: 1, output: 1 } };
} };

const server = await createServer({ ...config, dataDir: path.join(dir, "sessions") }, { roundtable: new Roundtable(roundtableConfig({}), [fake]) });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "leak-check", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const texts = (r.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text!);
  if (r.isError) throw new Error(`${name}: ${texts[0]}`);
  return JSON.parse(texts.find(t => t.trimStart().startsWith("{")) ?? "{}");
};
const before = (await call("import_clip", { filePath: clipA })).id, after = (await call("import_clip", { filePath: clipB })).id;

const samples: number[] = [];
const started = Date.now();
for (let round = 0; round < ROUNDS; round++) {
  // Vary ranges so per-video caches do not hide the real work.
  const s = (round % 10) * .1;
  await call("inspect_between", { sessionId: after, startSeconds: s, endSeconds: s + 2, mode: "strip" });
  await call("inspect_between", { sessionId: after, startSeconds: s, endSeconds: s + 1, mode: "onion" });
  await call("inspect_between", { sessionId: after, startSeconds: s, endSeconds: s + 4, mode: "changes" });
  await call("analyze_motion", { sessionId: after, startSeconds: s, endSeconds: 5 });
  await call("compare_clips", { beforeSessionId: before, afterSessionId: after, samples: 4, align: "none", seconds: 3 + (round % 3), sideBySideVideo: round % 5 === 0 });
  if (round % 5 === 0) {
    await call("qa_review", { sessionId: after, profile: "general", samples: 4 });
    const session = JSON.parse(await fs.readFile(path.join(dir, "sessions", after, "session.json"), "utf8"));
    for (const c of sessionCheckpoints(session)) await call("record_finding", { sessionId: after, checkpoint: c.id, grade: 3, note: `round ${round}` });
    await call("qa_report", { sessionId: after, waitSeconds: 20 });
  }
  gc(); gc();
  const heap = process.memoryUsage().heapUsed / 1024 / 1024;
  samples.push(heap);
  if (round % 5 === 4) console.log(`round ${round + 1}/${ROUNDS}: heap ${heap.toFixed(1)} MB, rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
}
await client.close(); await server.close();
await new Promise(r => setTimeout(r, 1500));
const base = count(baseline), now = count(process.getActiveResourcesInfo());
const leftovers = [...now].flatMap(([r, n]) => Array<string>(Math.max(0, n - (base.get(r) ?? 0))).fill(r));
await fs.rm(dir, { recursive: true, force: true });

// Compare the average of the last third with the first third (after warm-up) to ignore GC noise.
const third = Math.max(1, Math.floor(samples.length / 3));
const early = samples.slice(1, 1 + third).reduce((s, v) => s + v, 0) / third;
const late = samples.slice(-third).reduce((s, v) => s + v, 0) / third;
const growth = late - early;
console.log(`\n${ROUNDS} rounds in ${((Date.now() - started) / 1000).toFixed(0)} s. Heap early ${early.toFixed(1)} MB, late ${late.toFixed(1)} MB, growth ${growth.toFixed(1)} MB.`);
console.log(`New resources still open after shutdown: ${JSON.stringify(leftovers)} (baseline ${JSON.stringify(baseline)})`);
const bad = leftovers.filter(r => r === "ProcessWrap" || r === "Timeout" || r === "PipeWrap" || r === "TCPWrap");
if (growth > 8) { console.error("FAIL: heap keeps growing."); process.exit(1); }
if (bad.length) { console.error(`FAIL: resources left after shutdown: ${bad.join(", ")}`); process.exit(1); }
console.log("PASS: no heap growth and nothing left running.");
