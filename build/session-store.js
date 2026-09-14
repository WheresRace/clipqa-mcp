import fs from "node:fs/promises";
import path from "node:path";
export class SessionStore {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    sessionDir(id) {
        if (!/^[a-zA-Z0-9-]+$/.test(id))
            throw new Error("Invalid session id.");
        return path.join(this.rootDir, id);
    }
    manifestPath(id) {
        return path.join(this.sessionDir(id), "session.json");
    }
    async initialize() {
        await fs.mkdir(this.rootDir, { recursive: true });
    }
    async create(session) {
        await fs.mkdir(this.sessionDir(session.id), { recursive: false });
        await this.write(session);
    }
    async read(id) {
        const raw = await fs.readFile(this.manifestPath(id), "utf8");
        return JSON.parse(raw);
    }
    async write(session) {
        const target = this.manifestPath(session.id);
        const temporary = `${target}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
        await fs.rename(temporary, target);
    }
    async update(id, change) {
        const next = change(await this.read(id));
        await this.write(next);
        return next;
    }
    async list() {
        await this.initialize();
        const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
        const sessions = await Promise.all(entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
            try {
                return await this.read(entry.name);
            }
            catch {
                return undefined;
            }
        }));
        return sessions
            .filter((session) => Boolean(session))
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }
    async recoverInterrupted() {
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
//# sourceMappingURL=session-store.js.map