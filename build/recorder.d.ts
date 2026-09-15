import type { CommandRunner } from "./process-runner.js";
import type { CaptureTarget, RecordingSession } from "./types.js";
import { SessionStore } from "./session-store.js";
import { type Backend } from "./backends.js";
export type EncoderChoice = "auto" | "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf";
export interface StartRecordingOptions {
    target: CaptureTarget;
    fps: number;
    maxSeconds: number;
    drawMouse: boolean;
    encoder: EncoderChoice;
    backend?: Backend | "auto";
    bufferSeconds?: number;
    maxWidth?: number;
}
export declare function buildCaptureArgs(target: CaptureTarget, outputPath: string, options: Omit<StartRecordingOptions, "target" | "encoder"> & {
    encoder: string;
}): string[];
export declare function selectEncoder(requested: EncoderChoice, ffmpegPath: string, runner: CommandRunner): Promise<string>;
export declare class Recorder {
    private readonly store;
    private readonly ffmpegPath;
    private readonly runner;
    private readonly ffprobePath;
    private readonly active;
    private readonly errors;
    private readonly finished;
    private starting;
    private readonly fileQueues;
    private withFiles;
    constructor(store: SessionStore, ffmpegPath: string, runner: CommandRunner, ffprobePath?: string);
    start(options: StartRecordingOptions): Promise<RecordingSession>;
    stop(id: string): Promise<RecordingSession>;
    shutdown(): Promise<void>;
    preview(id: string, seconds: number): Promise<{
        videoPath: string;
        offset: number;
        duration: number;
    } | undefined>;
    private markFailed;
}
//# sourceMappingURL=recorder.d.ts.map