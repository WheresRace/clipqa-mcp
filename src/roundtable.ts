import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { gradeOf, latestFindings, sessionCheckpoints } from "./qa.js";
import type { RecordingSession, RoundtableRecord } from "./types.js";

// Roundtable: after the main model has reviewed a clip and qa_report has scored it, a panel of small models
// (local Claude / Codex CLIs the user already has) audits that review for anything missed or mis-graded.
// Cost controls: runs only on a COMPLETE review, once per distinct review (cached), with one compact image,
// a short text summary, no tools, a single turn, a structured answer, a token budget and a hard timeout.

export interface RoundtableConfig {
  mode: "auto" | "off";
  reviewers: string[];
  claudeModel: string;
  codexModel?: string;
  maxTokens: number;
  timeoutMs: number;
}

export function roundtableConfig(env: NodeJS.ProcessEnv = process.env): RoundtableConfig {
  const mode = (env.CLIPQA_ROUNDTABLE ?? "auto").toLowerCase() === "off" ? "off" : "auto";
  const reviewers = (env.CLIPQA_ROUNDTABLE_REVIEWERS ?? "claude,codex").split(",").map(s => s.trim().toLowerCase()).filter(s => s === "claude" || s === "codex");
  const number = (value: string | undefined, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback; };
  return {
    mode, reviewers: [...new Set(reviewers)].slice(0, 2),
    claudeModel: env.CLIPQA_ROUNDTABLE_CLAUDE_MODEL ?? "haiku",
    ...(env.CLIPQA_ROUNDTABLE_CODEX_MODEL ? { codexModel: env.CLIPQA_ROUNDTABLE_CODEX_MODEL } : {}),
    maxTokens: number(env.CLIPQA_ROUNDTABLE_MAX_TOKENS, 24000, 4000, 200000),
    timeoutMs: number(env.CLIPQA_ROUNDTABLE_TIMEOUT_SECONDS, 120, 20, 600) * 1000,
  };
}

export const SYSTEM_PROMPT = "You are a strict but careful QA auditor. Another model reviewed a recorded clip against a checklist. Your job is to find what it MISSED or graded WRONG. Use only what is visible in the attached image or contradicted by the measurements. If unsure, leave it out. Do not restate items you agree with. Reply only with the JSON the schema asks for.";

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    agree: { type: "boolean", description: "true if the review's verdict looks right overall" },
    missed: { type: "array", maxItems: 5, items: { type: "object", properties: { checkpoint: { type: "string" }, issue: { type: "string" }, timestampSeconds: { type: ["number", "null"] }, severity: { type: "string", enum: ["blocker", "major", "minor"] } }, required: ["checkpoint", "issue", "timestampSeconds", "severity"], additionalProperties: false } },
    disputed: { type: "array", maxItems: 5, items: { type: "object", properties: { checkpoint: { type: "string" }, suggestedGrade: { type: "integer", minimum: 0, maximum: 4 }, reason: { type: "string" } }, required: ["checkpoint", "suggestedGrade", "reason"], additionalProperties: false } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["agree", "missed", "disputed", "confidence"],
  additionalProperties: false,
} as const;

export interface Answer { agree: boolean; missed: Array<{ checkpoint: string; issue: string; timestampSeconds: number | null; severity: string }>; disputed: Array<{ checkpoint: string; suggestedGrade: number; reason: string }>; confidence: number }

export function parseAnswer(value: unknown): Answer | undefined {
  let v = value;
  if (typeof v === "string") {
    const match = /\{[\s\S]*\}/.exec(v);
    if (!match) return undefined;
    try { v = JSON.parse(match[0]); } catch { return undefined; }
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const text = (x: unknown, n: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const missed = Array.isArray(o.missed) ? o.missed.slice(0, 5).map(m => m as Record<string, unknown>).filter(m => m && m.issue).map(m => ({ checkpoint: text(m.checkpoint, 60), issue: text(m.issue, 240), timestampSeconds: typeof m.timestampSeconds === "number" && Number.isFinite(m.timestampSeconds) ? m.timestampSeconds : null, severity: ["blocker", "major", "minor"].includes(String(m.severity)) ? String(m.severity) : "minor" })) : [];
  const disputed = Array.isArray(o.disputed) ? o.disputed.slice(0, 5).map(d => d as Record<string, unknown>).filter(d => d && d.reason && Number.isInteger(d.suggestedGrade)).map(d => ({ checkpoint: text(d.checkpoint, 60), suggestedGrade: Math.min(4, Math.max(0, Number(d.suggestedGrade))), reason: text(d.reason, 240) })) : [];
  return { agree: o.agree === true, missed, disputed, confidence: typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : .5 };
}

export interface Packet { text: string; imagePath?: string; estimatedTokens: number }

/** One compact image (review contact sheet + up to 3 evidence crops) and a short text summary. */
export async function buildPacket(session: RecordingSession, score: { score: number; bonus: number; verdict: string }, directory: string): Promise<Packet> {
  const checkpoints = sessionCheckpoints(session), latest = latestFindings(session.findings);
  const findings = checkpoints.map(c => {
    const f = latest.get(c.id), g = f ? gradeOf(f) : undefined;
    return `${c.id} | ${c.title} | ${f ? `${f.status}${g !== undefined ? ` ${g}/4` : ""}` : "unchecked"}${f ? ` | ${f.note.replace(/\s+/g, " ").slice(0, 140)}` : ""}${f?.timestampSeconds !== undefined ? ` @${f.timestampSeconds}s` : ""}`;
  });
  const m = session.qualityMetrics;
  const measured = m ? `smoothness ${m.motion.fluidityScore}/100, hitches ${m.motion.hitches}, pops ${m.motion.pops}, real FPS ${m.effectiveFps ?? "n/a"} of ${session.fps}, pacing unevenness ${m.pacing.jitter ?? "n/a"}, easing ${m.easing ?? "n/a"}, still jitter ${m.stillJitter ?? "n/a"}, flicker ${m.flickerPerSecond}/s, black frames ${m.blackFrames}` : "none";
  const text = [
    `Request: ${session.request ?? "(not given)"}`,
    `Profile: ${session.profile ?? "character"}${session.requirements?.length ? `; must-pass: ${session.requirements.join("; ")}` : ""}`,
    `Measured: ${measured}`,
    `Main reviewer's result: ${score.verdict}, ${score.score}/100 +${score.bonus} bonus`,
    "Findings (id | checkpoint | status grade | note):",
    ...findings,
    "",
    "The image shows sampled frames (timestamp under each) and the reviewer's evidence crops.",
    "List checkpoints the reviewer got wrong (disputed, with the grade you would give) and problems it missed (missed). Use checkpoint ids from the list. Max 5 each.",
  ].join("\n");
  const sources = [session.reviewSheet, ...(session.findings ?? []).filter(f => f.status !== "pass" && f.evidencePath).slice(-3).map(f => f.evidencePath)].filter((p): p is string => Boolean(p));
  let imagePath: string | undefined, imageTokens = 0;
  const existing = (await Promise.all(sources.map(async p => (await fs.stat(p).catch(() => undefined)) ? p : undefined))).filter((p): p is string => Boolean(p));
  if (existing.length) {
    const width = 1024, parts: OverlayOptions[] = [];
    let top = 0;
    for (const [i, file] of existing.entries()) {
      const maxH = i === 0 ? 640 : 300;
      const buf = await sharp(file).resize({ width: i === 0 ? width : Math.round(width / 2), height: maxH, fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
      const meta = await sharp(buf).metadata();
      parts.push({ input: buf, left: i === 0 ? 0 : ((i - 1) % 2) * Math.round(width / 2), top });
      if (i === 0 || (i - 1) % 2 === 1 || i === existing.length - 1) top += meta.height ?? maxH;
    }
    imagePath = path.join(directory, "panel.jpg");
    await fs.mkdir(directory, { recursive: true });
    const height = Math.max(1, Math.min(1100, top));
    await sharp({ create: { width, height, channels: 3, background: "#0b1020" } }).composite(parts.filter(p => (p.top ?? 0) < height)).jpeg({ quality: 72 }).toFile(imagePath);
    imageTokens = Math.ceil(width * height / 750);
  }
  return { text, ...(imagePath ? { imagePath } : {}), estimatedTokens: Math.ceil((text.length + SYSTEM_PROMPT.length) / 3.5) + imageTokens + 600 };
}

export interface ReviewerResult { name: string; ok: boolean; answer?: Answer; tokens?: { input: number; output: number }; seconds: number; error?: string }

export interface Reviewer { name: string; overhead: number; available(): Promise<boolean>; run(packet: Packet, workDir: string, signal: AbortSignal): Promise<{ answer?: Answer; tokens?: { input: number; output: number } }> }

/** Spawn with a hard timeout, capped output, and process-tree kill; every child is tracked for shutdown. */
export class Processes {
  private readonly live = new Set<ChildProcess>();
  run(command: string, args: string[], options: { stdin?: string; cwd?: string; timeoutMs: number; shell?: boolean; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const common = { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], env: options.env ?? process.env, detached: process.platform !== "win32" };
      // .cmd shims need cmd.exe: pass one pre-quoted command line rather than letting Node concatenate args.
      const child = options.shell ? spawn([command, ...args].map(quote).join(" "), { ...common, shell: true }) : spawn(command, args, common);
      this.live.add(child);
      let stdout = "", stderr = "", done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); this.live.delete(child);
        if (error) { kill(child); reject(error); } else resolve({ code: child.exitCode ?? -1, stdout, stderr });
      };
      const onAbort = () => finish(new Error("cancelled"));
      const timer = setTimeout(() => finish(new Error(`timed out after ${Math.round(options.timeoutMs / 1000)} s`)), options.timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (c: string) => { stdout = (stdout + c).slice(-1_000_000); });
      child.stderr!.on("data", (c: string) => { stderr = (stderr + c).slice(-20_000); });
      child.on("error", e => finish(e));
      child.on("close", () => finish());
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(options.stdin ?? "");
    });
  }
  killAll(): void { for (const child of this.live) kill(child); this.live.clear(); }
  get size(): number { return this.live.size; }
}

// Only used for .cmd shims run through cmd.exe; arguments sent that way never contain double quotes.
const quote = (arg: string) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "")}"`);

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else process.kill(-child.pid, "SIGKILL");
  } catch { child.kill("SIGKILL"); }
}

async function which(processes: Processes, name: string): Promise<string | undefined> {
  const r = await processes.run(process.platform === "win32" ? "where" : "which", [name], { timeoutMs: 10_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // On Windows prefer a real executable or .cmd shim over an extensionless shell script.
  return process.platform === "win32" ? lines.find(l => /\.exe$/i.test(l)) ?? lines.find(l => /\.cmd$/i.test(l)) : lines[0];
}

class ClaudeReviewer implements Reviewer {
  readonly name: string; readonly overhead = 2500;
  private path: Promise<string | undefined> | undefined;
  constructor(private readonly processes: Processes, private readonly model: string, private readonly timeoutMs: number) { this.name = `claude:${model}`; }
  available() { this.path ??= which(this.processes, "claude"); return this.path.then(Boolean); }
  async run(packet: Packet, workDir: string, signal: AbortSignal) {
    const exe = (await this.path)!;
    const content: unknown[] = [];
    if (packet.imagePath) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(packet.imagePath)).toString("base64") } });
    content.push({ type: "text", text: packet.text });
    const stdin = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
    // No tools, no MCP servers (so ClipQA can never launch itself), no settings, hooks or saved session.
    const args = ["-p", "--model", this.model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt", SYSTEM_PROMPT, "--json-schema", JSON.stringify(ANSWER_SCHEMA), "--max-turns", "2"];
    const r = await this.processes.run(exe, args, { stdin, cwd: workDir, timeoutMs: this.timeoutMs, signal, shell: /\.cmd$/i.test(exe) });
    const result = r.stdout.split("\n").map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).filter(Boolean).reverse().find(l => l!.type === "result");
    if (!result) throw new Error(`no result (exit ${r.code}): ${r.stderr.slice(-300) || r.stdout.slice(-300)}`);
    const usage = (result.usage ?? {}) as Record<string, number>;
    const tokens = { input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), output: usage.output_tokens ?? 0 };
    if (result.is_error) throw Object.assign(new Error(String(result.result ?? "error").slice(0, 300)), { tokens });
    const answer = parseAnswer(result.structured_output ?? result.result);
    if (!answer) throw Object.assign(new Error("answer did not match the schema"), { tokens });
    return { answer, tokens };
  }
}

// Features that add tool definitions to every Codex request; disabled only if this Codex version has them.
const CODEX_DISABLE = ["apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "goals", "hooks", "code_mode_host", "shell_tool", "unified_exec", "multi_agent", "plugins", "tool_suggest", "sleep_tool", "view_image", "skill_search", "in_app_browser", "in_app_chat", "in_app_local_automation", "skill_mcp_dependency_install", "workspace_dependencies", "worktrees", "mentions_v2", "realtime_conversation", "remote_plugin", "plugin_sharing", "shell_snapshot", "memories"];

class CodexReviewer implements Reviewer {
  readonly name: string; readonly overhead = 6500;
  private path: Promise<string | undefined> | undefined;
  private disable: Promise<string[]> | undefined;
  constructor(private readonly processes: Processes, private readonly model: string | undefined, private readonly timeoutMs: number) { this.name = model ? `codex:${model}` : "codex"; }
  available() { this.path ??= which(this.processes, "codex"); return this.path.then(Boolean); }
  private features(exe: string): Promise<string[]> {
    this.disable ??= this.processes.run(exe, ["features", "list"], { timeoutMs: 20_000, shell: /\.cmd$/i.test(exe) }).then(r => {
      const enabled = new Set(r.stdout.split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(p => p.at(-1) === "true").map(p => p[0]!));
      return CODEX_DISABLE.filter(f => enabled.has(f));
    }).catch(() => []);
    return this.disable;
  }
  async run(packet: Packet, workDir: string, signal: AbortSignal) {
    const exe = (await this.path)!;
    const instructions = path.join(workDir, "instructions.md"), schema = path.join(workDir, "schema.json"), last = path.join(workDir, "answer.json");
    await fs.writeFile(instructions, SYSTEM_PROMPT); await fs.writeFile(schema, JSON.stringify(ANSWER_SCHEMA));
    const disable = (await this.features(exe)).flatMap(f => ["--disable", f]);
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-C", workDir,
      ...(packet.imagePath ? ["-i", packet.imagePath] : []), "--output-schema", schema, "-o", last,
      // Unquoted values: Codex falls back to a plain string when a -c value is not TOML, and no inner quotes
      // means the arguments survive cmd.exe when Codex is a .cmd shim.
      "-c", "model_reasoning_effort=low", "-c", `model_instructions_file=${instructions.replace(/\\/g, "/")}`, "-c", "web_search=disabled",
      ...(this.model ? ["-m", this.model] : []), ...disable, "-"];
    const r = await this.processes.run(exe, args, { stdin: packet.text, cwd: workDir, timeoutMs: this.timeoutMs, signal, shell: /\.cmd$/i.test(exe) });
    const usageLine = r.stdout.split("\n").reverse().find(l => l.includes("\"turn.completed\""));
    const usage = usageLine ? (JSON.parse(usageLine).usage ?? {}) as Record<string, number> : {};
    const tokens = { input: usage.input_tokens ?? 0, output: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0) };
    const raw = await fs.readFile(last, "utf8").catch(() => "");
    const answer = parseAnswer(raw);
    if (!answer) throw Object.assign(new Error(`no answer (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`), { tokens });
    return { answer, tokens };
  }
}

export function mergeAnswers(results: ReviewerResult[], validIds: string[]): Pick<RoundtableRecord, "challenges" | "agreement"> {
  const ok = results.filter(r => r.ok && r.answer);
  const map = new Map<string, RoundtableRecord["challenges"][number]>();
  for (const r of ok) {
    for (const m of r.answer!.missed) {
      const checkpoint = validIds.includes(m.checkpoint) ? m.checkpoint : "other";
      const key = `missed:${checkpoint}:${m.issue.toLowerCase().slice(0, 40)}`;
      const sameCheckpoint = [...map.values()].find(c => c.kind === "missed" && c.checkpoint === checkpoint && checkpoint !== "other");
      const existing = map.get(key) ?? sameCheckpoint;
      if (existing) { if (!existing.raisedBy.includes(r.name)) existing.raisedBy.push(r.name); continue; }
      map.set(key, { checkpoint, issue: `[${m.severity}] ${m.issue}`, kind: "missed", ...(m.timestampSeconds !== null ? { timestampSeconds: m.timestampSeconds } : {}), raisedBy: [r.name] });
    }
    for (const d of r.answer!.disputed) {
      if (!validIds.includes(d.checkpoint)) continue;
      const key = `disputed:${d.checkpoint}`, existing = map.get(key);
      if (existing) { if (!existing.raisedBy.includes(r.name)) existing.raisedBy.push(r.name); continue; }
      map.set(key, { checkpoint: d.checkpoint, issue: d.reason, kind: "disputed", suggestedGrade: d.suggestedGrade, raisedBy: [r.name] });
    }
  }
  // Issues raised by more than one reviewer first.
  const challenges = [...map.values()].sort((a, b) => b.raisedBy.length - a.raisedBy.length).slice(0, 8);
  return { challenges, ...(ok.length ? { agreement: Number((ok.filter(r => r.answer!.agree).length / ok.length).toFixed(2)) } : {}) };
}

export class Roundtable {
  private readonly processes = new Processes();
  private readonly running = new Map<string, Promise<RoundtableRecord>>();
  private readonly controller = new AbortController();
  private readonly reviewers: Reviewer[];
  private readonly disabled = new Map<string, string>();

  constructor(readonly config: RoundtableConfig = roundtableConfig(), reviewers?: Reviewer[]) {
    this.reviewers = reviewers ?? config.reviewers.map(name => name === "claude" ? new ClaudeReviewer(this.processes, config.claudeModel, config.timeoutMs) : new CodexReviewer(this.processes, config.codexModel, config.timeoutMs));
  }

  get activeProcesses(): number { return this.processes.size; }

  async status(): Promise<Array<{ name: string; available: boolean; reason?: string }>> {
    return Promise.all(this.reviewers.map(async r => {
      const reason = this.disabled.get(r.name);
      return { name: r.name, available: !reason && await r.available().catch(() => false), ...(reason ? { reason } : {}) };
    }));
  }

  static key(packet: Packet, imageHash: string, reviewers: string[]): string {
    return createHash("sha256").update(packet.text).update(imageHash).update(reviewers.join(",")).digest("hex").slice(0, 24);
  }

  /** Run the panel for this review once; concurrent and repeated calls for the same review share one result. */
  review(session: RecordingSession, packet: Packet, workRoot: string, save: (record: RoundtableRecord) => Promise<void>): Promise<RoundtableRecord> {
    const existing = this.running.get(session.id);
    if (existing) return existing;
    const task = this.execute(session, packet, workRoot, save).finally(() => this.running.delete(session.id));
    this.running.set(session.id, task);
    return task;
  }

  private async execute(session: RecordingSession, packet: Packet, workRoot: string, save: (record: RoundtableRecord) => Promise<void>): Promise<RoundtableRecord> {
    const imageHash = packet.imagePath ? createHash("sha256").update(await fs.readFile(packet.imagePath)).digest("hex") : "";
    const available: Reviewer[] = [];
    for (const r of this.reviewers) if (!this.disabled.has(r.name) && await r.available().catch(() => false)) available.push(r);
    const key = Roundtable.key(packet, imageHash, available.map(r => r.name));
    if (session.roundtable?.key === key && session.roundtable.state === "done") return session.roundtable;
    const startedAt = new Date().toISOString();
    if (!available.length) {
      const record: RoundtableRecord = { key, state: "skipped", startedAt, finishedAt: startedAt, reviewers: [], challenges: [], note: "No reviewer CLI is available (install and sign in to Claude Code or Codex), or every reviewer was disabled after an error." };
      await save(record); return record;
    }
    // Budget: take reviewers in order while the estimate fits.
    const chosen: Reviewer[] = [];
    let budget = this.config.maxTokens;
    for (const r of available) { const cost = packet.estimatedTokens + r.overhead; if (cost <= budget) { chosen.push(r); budget -= cost; } }
    if (!chosen.length) {
      const record: RoundtableRecord = { key, state: "skipped", startedAt, finishedAt: startedAt, reviewers: [], challenges: [], note: `Estimated ${packet.estimatedTokens + available[0]!.overhead} tokens per reviewer exceeds CLIPQA_ROUNDTABLE_MAX_TOKENS=${this.config.maxTokens}.` };
      await save(record); return record;
    }
    await save({ key, state: "running", startedAt, reviewers: chosen.map(r => ({ name: r.name, ok: false })), challenges: [] });
    const results = await Promise.all(chosen.map(async (reviewer): Promise<ReviewerResult> => {
      const workDir = path.join(workRoot, `${reviewer.name.replace(/[^\w-]/g, "_")}-${randomUUID().slice(0, 8)}`);
      const began = Date.now();
      try {
        await fs.mkdir(workDir, { recursive: true });
        const { answer, tokens } = await reviewer.run(packet, workDir, this.controller.signal);
        return { name: reviewer.name, ok: true, ...(answer ? { answer } : {}), ...(tokens ? { tokens } : {}), seconds: Number(((Date.now() - began) / 1000).toFixed(1)) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Sign-in and missing-model errors will not fix themselves: stop paying to retry them this session.
        if (/auth|log ?in|sign ?in|401|403|credential|not found|unknown model|invalid model/i.test(message)) this.disabled.set(reviewer.name, message.slice(0, 160));
        const tokens = (error as { tokens?: { input: number; output: number } }).tokens;
        return { name: reviewer.name, ok: false, error: message.slice(0, 300), ...(tokens ? { tokens } : {}), seconds: Number(((Date.now() - began) / 1000).toFixed(1)) };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }));
    const merged = mergeAnswers(results, sessionCheckpoints(session).map(c => c.id));
    const ok = results.filter(r => r.ok).length;
    const record: RoundtableRecord = {
      key, state: ok ? "done" : "failed", startedAt, finishedAt: new Date().toISOString(),
      reviewers: results.map(r => ({ name: r.name, ok: r.ok, seconds: r.seconds, ...(r.tokens ? { tokens: r.tokens } : {}), ...(r.error ? { error: r.error } : {}) })),
      ...merged,
      note: ok ? "Small models can be wrong. Verify each challenge yourself (zoom_frame, inspect_between) and record_finding again only if it holds." : "Every reviewer failed; the main review stands unaudited.",
    };
    await save(record);
    return record;
  }

  shutdown(): void { this.controller.abort(); this.processes.killAll(); }
}

export function panelHtml(record: RoundtableRecord, escape: (s: string) => string): string {
  const used = record.reviewers.reduce((s, r) => s + (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0), 0);
  const who = record.reviewers.map(r => `${escape(r.name)} ${r.ok ? "✓" : `✗ ${escape(r.error ?? "")}`}`).join(" · ");
  const items = record.challenges.map(c => `<li><b>${escape(c.checkpoint)}</b> (${c.kind}${c.suggestedGrade !== undefined ? `, suggests ${c.suggestedGrade}/4` : ""}${c.timestampSeconds !== undefined ? `, ${c.timestampSeconds}s` : ""}) ${escape(c.issue)} <small>— ${escape(c.raisedBy.join(", "))}</small></li>`).join("");
  return `<h2>Roundtable audit: ${record.state}${record.agreement !== undefined ? ` · ${Math.round(record.agreement * 100)}% agree` : ""}</h2><p><small>${who}${used ? ` · ${used} tokens` : ""}</small></p>${items ? `<ul>${items}</ul>` : `<p>${escape(record.note ?? "No challenges.")}</p>`}`;
}
