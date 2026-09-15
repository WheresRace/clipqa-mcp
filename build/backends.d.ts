import type { CommandRunner } from "./process-runner.js";
import type { CaptureTarget } from "./types.js";
export type Backend = "gdigrab" | "gfxcapture" | "x11grab" | "avfoundation";
export interface Capabilities {
    platform: string;
    available: Backend[];
    recommended?: Backend;
    warnings: string[];
}
export declare function capabilities(ffmpeg: string, runner: CommandRunner, platform?: NodeJS.Platform): Promise<Capabilities>;
export declare function captureInput(backend: Backend, target: CaptureTarget, fps: number, mouse: boolean): string[];
export declare function listScreens(ffmpeg: string, runner: CommandRunner): Promise<Array<{
    screenIndex: number;
    name: string;
}>>;
//# sourceMappingURL=backends.d.ts.map