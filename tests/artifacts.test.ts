import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { deleteSession, directoryBytes } from "../src/artifacts.js";
import type { RecordingSession } from "../src/types.js";
let directory = "";
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-artifacts-"));
  const store = new SessionStore(path.join(directory, "store")); await store.initialize();
  const session: RecordingSession = { id: "11111111-1111-4111-8111-111111111111", state: "recording", target: { title: "fixture" }, startedAt: new Date().toISOString(), fps: 15, encoder: "libx264", drawMouse: false, maxSeconds: 30, videoPath: "unused.mp4", events: [] };
  return { store, session };
}
it("refuses to delete active recordings", async () => {
  const { store, session } = await fixture(); await store.create(session);
  await expect(deleteSession(store, session.id)).rejects.toThrow("Stop");
  expect((await store.read(session.id)).state).toBe("recording");
});
it("deletes completed artifacts without affecting sibling files", async () => {
  const { store, session } = await fixture(); await store.create({ ...session, state: "stopped" });
  const sibling = path.join(directory, "keep.mp4"); await fs.writeFile(sibling, "keep");
  await fs.writeFile(path.join(store.sessionDir(session.id), "video.mp4"), Buffer.alloc(100));
  expect(await directoryBytes(store.sessionDir(session.id))).toBeGreaterThan(100);
  await deleteSession(store, session.id); expect(await fs.readFile(sibling, "utf8")).toBe("keep");
});
it("refuses a session-directory link pointing outside the store", async () => {
  const { store, session } = await fixture(); const external = path.join(directory, "external"); await fs.mkdir(external);
  await fs.writeFile(path.join(external, "session.json"), JSON.stringify({ ...session, state: "stopped" }));
  await fs.symlink(external, store.sessionDir(session.id), process.platform === "win32" ? "junction" : "dir");
  await expect(deleteSession(store, session.id)).rejects.toThrow("outside");
  expect((await fs.stat(external)).isDirectory()).toBe(true);
});
