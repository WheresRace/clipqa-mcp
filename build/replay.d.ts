import type { CommandRunner } from "./process-runner.js";
export declare const SEGMENT_SECONDS = 2;
export declare function segmentArgs(directory: string, fps: number): string[];
export declare function segmentFiles(directory: string): Promise<string[]>;
export declare function pruneSegments(directory: string, seconds: number): Promise<void>;
export declare function finalizeReplay(directory: string, output: string, seconds: number, ffmpeg: string, ffprobe: string, runner: CommandRunner): Promise<{
    offset: number;
    duration: number;
}>;
//# sourceMappingURL=replay.d.ts.map