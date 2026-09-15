import fs from "node:fs/promises";
import path from "node:path";
import { MediaProcessor } from "./media.js";
export const SEGMENT_SECONDS = 2;
export function segmentArgs(directory, fps) {
    return ["-g", String(fps * SEGMENT_SECONDS), "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-reset_timestamps", "1", path.join(directory, "part-%08d.ts")];
}
export async function segmentFiles(directory) {
    return (await fs.readdir(directory)).filter(name => /^part-\d{8}\.ts$/.test(name)).sort();
}
export async function pruneSegments(directory, seconds) {
    const files = await segmentFiles(directory);
    // Keep the open segment plus boundary slack. Never remove a file still being written.
    const keep = Math.ceil(seconds / SEGMENT_SECONDS) + 2;
    await Promise.all(files.slice(0, Math.max(0, files.length - keep)).map(name => fs.unlink(path.join(directory, name))));
}
export async function finalizeReplay(directory, output, seconds, ffmpeg, ffprobe, runner) {
    const files = await segmentFiles(directory);
    if (!files.length)
        throw new Error("Replay buffer contains no video segments.");
    const media = new MediaProcessor(ffmpeg, ffprobe, runner);
    // Probe the concatenation: TS container duration may include timestamp offsets.
    const list = path.join(directory, "concat.txt");
    await fs.writeFile(list, files.map(name => `file '${name}'`).join("\n"));
    const joined = path.join(directory, "joined.mp4");
    let result = await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", list, "-an", "-c:v", "copy", joined]);
    if (result.code)
        throw new Error(`Cannot join replay segments: ${result.stderr.slice(-800)}`);
    const duration = await media.duration(joined);
    const trim = Math.max(0, duration - seconds);
    result = await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(trim), "-i", joined, "-t", String(seconds), "-an", ...(trim > 0 ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"] : ["-c:v", "copy"]), "-movflags", "+faststart", output]);
    if (result.code)
        throw new Error(`Cannot save replay: ${result.stderr.slice(-800)}`);
    const offset = Number(files[0].match(/\d+/)[0]) * SEGMENT_SECONDS + trim;
    // Only remove known recorder artifacts after a successful final output.
    await Promise.all([...files, "concat.txt", "joined.mp4"].map(name => fs.unlink(path.join(directory, name))));
    return { offset, duration: Math.min(seconds, duration) };
}
//# sourceMappingURL=replay.js.map