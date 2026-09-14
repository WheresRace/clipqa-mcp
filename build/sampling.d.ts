export interface InspectionSignals {
    startSeconds: number;
    endSeconds: number;
    overviewSamples: number;
    eventTimesSeconds?: number[];
    visualChangeTimesSeconds?: number[];
    neighborhoodSeconds?: number;
}
export declare function evenlySpaced(start: number, end: number, count: number): number[];
export declare function chooseInspectionTimestamps(signals: InspectionSignals): number[];
export declare function chooseBoundedInspectionTimestamps(signals: Omit<InspectionSignals, "overviewSamples">, maxSamples: number): number[];
export declare function hitsInterval(timestamp: number, start: number, end: number): boolean;
//# sourceMappingURL=sampling.d.ts.map