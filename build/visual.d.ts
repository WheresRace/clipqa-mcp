import { MediaProcessor } from "./media.js";
export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Difference {
    meanDifference: number;
    peakTileDifference: number;
    ssim: number;
    changedFraction: number;
}
export declare function difference(a: Uint8Array, b: Uint8Array, width: number, height: number, ignore?: Region[]): Difference;
export interface VisualIndex {
    fps: number;
    decodedFrames: number;
    width: number;
    height: number;
    changes: Array<{
        timestamp: number;
        score: number;
    }>;
    warnings: string[];
}
export declare function indexVideo(ffmpeg: string, video: string, start: number, end: number, fps?: number): Promise<VisualIndex>;
export declare function compareVideos(media: MediaProcessor, before: string, after: string, directory: string, options: {
    beforeStart: number;
    afterStart: number;
    seconds: number;
    samples: number;
    threshold: number;
    ignore: Region[];
}): Promise<{
    schemaVersion: number;
    options: {
        beforeStart: number;
        afterStart: number;
        seconds: number;
        samples: number;
        threshold: number;
        ignore: Region[];
    };
    changedSamples: number;
    rows: (Difference & {
        beforeSeconds: number;
        afterSeconds: number;
        score: number;
        changed: boolean;
    })[];
    note: string;
    previewSample: (Difference & {
        beforeSeconds: number;
        afterSeconds: number;
        score: number;
        changed: boolean;
    }) | undefined;
    previewPath: string;
    reportPath: string;
    jsonPath: string;
}>;
//# sourceMappingURL=visual.d.ts.map