import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";
import type { RecordingSession } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

async function makeStore(): Promise<SessionStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-test-"));
  temporaryDirectories.push(directory);
  const store = new SessionStore(directory);
  await store.initialize();
  return store;
}

function sampleSession(id = "11111111-1111-4111-8111-111111111111"): RecordingSession {
  return {
    id,
    state: "recording",
    target: { title: "Roblox" },
    startedAt: "2026-09-14T12:00:00.000Z",
    fps: 30,
    encoder: "libx264",
    drawMouse: false,
    maxSeconds: 120,
    videoPath: "recording.mp4",
    events: [],
  };
}

describe("SessionStore", () => {
  it("preserves concurrent event updates", async () => {
    const store = await makeStore(); const session = sampleSession(); await store.create(session);
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.update(session.id, s => ({ ...s, events: [...s.events, { timestampMs: i, label: String(i), kind: "note" }] }))));
    expect((await store.read(session.id)).events).toHaveLength(30);
  });
  it("does not interrupt a session owned by a live MCP process", async () => {
    const store = await makeStore(); await store.create({ ...sampleSession(), ownerPid: process.pid });
    expect(await store.recoverInterrupted()).toBe(0);
  });
  it("round-trips and updates a session", async () => {
    const store = await makeStore();
    const session = sampleSession();
    await store.create(session);
    await store.update(session.id, (current) => ({ ...current, state: "stopped" }));
    expect((await store.read(session.id)).state).toBe("stopped");
  });

  it("recovers stale recording sessions after a process restart", async () => {
    const store = await makeStore();
    await store.create(sampleSession());
    expect(await store.recoverInterrupted()).toBe(1);
    expect((await store.list())[0]?.state).toBe("interrupted");
  });

  it("rejects unsafe session ids", async () => {
    const store = await makeStore();
    expect(() => store.sessionDir("../escape")).toThrow("Invalid session id");
  });
});
