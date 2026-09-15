import fs from "node:fs/promises";
import path from "node:path";
export async function directoryBytes(directory) {
    let total = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory())
            total += await directoryBytes(file);
        else if (entry.isFile())
            total += (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    }
    return total;
}
export async function deleteSession(store, id) {
    const session = await store.read(id);
    if (session.state === "recording")
        throw new Error("Stop the recording before deleting its artifacts.");
    const root = await fs.realpath(store.rootDir), target = await fs.realpath(store.sessionDir(id));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative !== id)
        throw new Error("Refusing to delete a directory outside the session store.");
    await fs.rm(target, { recursive: true });
}
//# sourceMappingURL=artifacts.js.map