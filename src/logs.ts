import fs from "node:fs/promises";
import path from "node:path";
import type { QaEvent } from "./types.js";

export interface LogLine { wallMs: number; label: string; kind: QaEvent["kind"]; data: Record<string, unknown> }

const ISO_PREFIX = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?)[,\s]/;

export function parseLogLine(line: string, source: string, now = Date.now()): LogLine {
  const iso = ISO_PREFIX.exec(line);
  const parsed = iso ? Date.parse(iso[1]!.endsWith("Z") ? iso[1]! : `${iso[1]}Z`) : NaN;
  const message = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?,[^ ]*\s+/, "").trim();
  const level = /\berror\b|exception|\bfailed\b|FLog::Error/i.test(message) ? "error" : /\bwarn(ing)?\b|FLog::Warning/i.test(message) ? "warning" : "info";
  return { wallMs: Number.isFinite(parsed) ? parsed : now, label: message.slice(0, 500), kind: level === "error" ? "error" : "note", data: { source: path.basename(source), level } };
}

async function newestLog(directory: string): Promise<string | undefined> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let best: { file: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(log|txt)$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name), mtime = (await fs.stat(file)).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file;
}

// Tails a file, or the newest .log/.txt in a directory, from its current end. Never reads earlier content.
export class LogWatcher {
  private file: string | undefined;
  private offset = 0;
  private partial = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private windowStart = 0;
  private windowCount = 0;
  dropped = 0;

  constructor(readonly target: string, private readonly pattern: RegExp | undefined, private readonly onLine: (line: LogLine) => void, private readonly maxPerSecond = 50) {}

  async start(): Promise<string> {
    const stat = await fs.stat(this.target);
    this.file = stat.isDirectory() ? await newestLog(this.target) : this.target;
    if (!this.file) throw new Error(`No .log or .txt files found in ${this.target}.`);
    this.offset = (await fs.stat(this.file)).size;
    this.timer = setInterval(() => { void this.poll(); }, 400);
    return this.file;
  }

  async poll(): Promise<void> {
    if (this.busy || !this.file) return;
    this.busy = true;
    try {
      if ((await fs.stat(this.target)).isDirectory()) {
        const newest = await newestLog(this.target);
        if (newest && newest !== this.file) { await this.read(); this.file = newest; this.offset = 0; this.partial = ""; }
      }
      await this.read();
    } catch { } finally { this.busy = false; }
  }

  private async read(): Promise<void> {
    const size = (await fs.stat(this.file!)).size;
    if (size < this.offset) { this.offset = 0; this.partial = ""; }
    if (size === this.offset) return;
    const handle = await fs.open(this.file!, "r");
    try {
      const length = Math.min(size - this.offset, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset += length;
      const lines = (this.partial + buffer.toString("utf8")).split(/\r?\n/);
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim() || (this.pattern && !this.pattern.test(line))) continue;
        const now = Date.now();
        if (now - this.windowStart >= 1000) { this.windowStart = now; this.windowCount = 0; }
        if (++this.windowCount > this.maxPerSecond) { this.dropped++; continue; }
        this.onLine(parseLogLine(line, this.file!, now));
      }
    } finally { await handle.close(); }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.poll();
  }
}
