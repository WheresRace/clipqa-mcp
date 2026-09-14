import { describe, expect, it } from "vitest";
import {
  chooseBoundedInspectionTimestamps,
  chooseInspectionTimestamps,
  evenlySpaced,
  hitsInterval,
} from "../src/sampling.js";

describe("evenlySpaced", () => {
  it("includes both ends of the requested interval", () => {
    expect(evenlySpaced(2, 8, 4)).toEqual([2, 4, 6, 8]);
  });

  it("handles a single sample", () => {
    expect(evenlySpaced(3, 9, 1)).toEqual([3]);
  });
});

describe("chooseInspectionTimestamps", () => {
  it("adds a neighborhood around actions and visual changes", () => {
    expect(
      chooseInspectionTimestamps({
        startSeconds: 0,
        endSeconds: 10,
        overviewSamples: 2,
        eventTimesSeconds: [4],
        visualChangeTimesSeconds: [7],
        neighborhoodSeconds: 0.1,
      }),
    ).toEqual([0, 3.9, 4, 4.1, 6.9, 7, 7.1, 10]);
  });

  it("clamps timestamps to the clip", () => {
    expect(
      chooseInspectionTimestamps({
        startSeconds: 0,
        endSeconds: 1,
        overviewSamples: 0,
        eventTimesSeconds: [0, 1],
      }),
    ).toEqual([0, 0.2, 0.8, 1]);
  });
});

describe("hitsInterval", () => {
  it("treats interval boundaries as visible", () => {
    expect(hitsInterval(1.5, 1.5, 1.6)).toBe(true);
    expect(hitsInterval(1.7, 1.5, 1.6)).toBe(false);
  });
});

describe("chooseBoundedInspectionTimestamps", () => {
  it("never exceeds the frame budget and retains signal timestamps", () => {
    const timestamps = chooseBoundedInspectionTimestamps(
      {
        startSeconds: 0,
        endSeconds: 20,
        eventTimesSeconds: [4, 8, 12],
        visualChangeTimesSeconds: [6, 10],
      },
      10,
    );
    expect(timestamps).toHaveLength(10);
    expect(timestamps).toEqual(expect.arrayContaining([4, 6, 8, 10, 12]));
  });
});
