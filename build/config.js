import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
export function resolveConfig(env = process.env) {
    const managed = path.join(os.homedir(), ".clipqa", "bin");
    const executable = (name) => path.join(managed, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    return {
        dataDir: env.CLIPQA_DATA_DIR ?? path.join(os.homedir(), ".clipqa", "sessions"),
        ffmpegPath: env.CLIPQA_FFMPEG_PATH ?? (existsSync(executable("ffmpeg")) ? executable("ffmpeg") : ffmpegStatic ?? "ffmpeg"),
        ffprobePath: env.CLIPQA_FFPROBE_PATH ?? (existsSync(executable("ffprobe")) ? executable("ffprobe") : ffprobeStatic.path ?? "ffprobe"),
    };
}
//# sourceMappingURL=config.js.map