import type { CommandRunner } from "./process-runner.js";
export declare class MediaProcessor {
    private readonly ffmpegPath;
    private readonly ffprobePath;
    private readonly runner;
    constructor(ffmpegPath: string, ffprobePath: string, runner: CommandRunner);
    duration(videoPath: string): Promise<number>;
    extractFrame(videoPath: string, timestamp: number, outputPath: string): Promise<void>;
    detectVisualChanges(videoPath: string, threshold?: number, maxChanges?: number): Promise<number[]>;
    createContactSheet(videoPath: string, outputPath: string, timestamps: number[]): Promise<number[]>;
}
//# sourceMappingURL=media.d.ts.map