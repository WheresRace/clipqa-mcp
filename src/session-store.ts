import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingSession } from "./types.js";

export class SessionStore {
  constructor(readonly rootDir: string) {}

  sessionDir(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session id.");
    return path.join(this.rootDir, id);
  }

  manifestPath(id: string): string {
    return path.join(this.sessionDir(id), "session.json");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async create(session: RecordingSession): Promise<void> {
    await fs.mkdir(this.sessionDir(session.id), { recursive: false });
    await this.write(session);
  }

  async read(id: string): Promise<RecordingSession> {
    const raw = await fs.readFile(this.manifestPath(id), "utf8");
    return JSON.parse(raw) as RecordingSession;
  }

  async write(session: RecordingSession): Promise<void> {
    const target = this.manifestPath(session.id);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  }

  async update(
    id: string,
    change: (session: RecordingSession) => RecordingSession,
  ): Promise<RecordingSession> {
    const next = change(await this.read(id));
    await this.write(next);
    return next;
  }

  async list(): Promise<RecordingSession[]> {
    await this.initialize();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.read(entry.name);
          } catch {
            return undefined;
          }
        }),
    );
    return sessions
      .filter((session): session is RecordingSession => Boolean(session))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async recoverInterrupted(): Promise<number> {
    const sessions = await this.list();
    let recovered = 0;
    for (const session of sessions) {
      if (session.state === "recording") {
        await this.write({
          ...session,
          state: "interrupted",
          stoppedAt: new Date().toISOString(),
          error: "The MCP process ended before the recording was stopped.",
        });
        recovered += 1;
      }
    }
    return recovered;
  }
}
