import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
export function resolveConfig(env = process.env) {
    return {
        dataDir: env.CLIPQA_DATA_DIR ?? path.join(os.homedir(), ".clipqa", "sessions"),
        ffmpegPath: env.CLIPQA_FFMPEG_PATH ?? ffmpegStatic ?? "ffmpeg",
        ffprobePath: env.CLIPQA_FFPROBE_PATH ?? ffprobeStatic.path ?? "ffprobe",
    };
}
//# sourceMappingURL=config.js.map