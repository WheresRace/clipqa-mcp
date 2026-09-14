import { chooseBoundedInspectionTimestamps, evenlySpaced, hitsInterval } from "../src/sampling.js";
import { scenarios } from "./scenarios.js";

interface StrategyResult {
  name: string;
  found: number;
  total: number;
  frames: number;
}

function evaluate(name: string, choose: (index: number) => number[]): StrategyResult {
  let found = 0;
  let total = 0;
  let frames = 0;
  scenarios.forEach((scenario, index) => {
    const timestamps = choose(index);
    frames += timestamps.length;
    for (const defect of scenario.defects) {
      total += 1;
      if (timestamps.some((timestamp) => hitsInterval(timestamp, defect.start, defect.end))) found += 1;
    }
  });
  return { name, found, total, frames };
}

const baseline = evaluate("Periodic screenshots (4/run)", (index) => {
  const scenario = scenarios[index]!;
  return evenlySpaced(0, scenario.duration, 4);
});

const clipqa = evaluate("ClipQA event + scene sampler", (index) => {
  const scenario = scenarios[index]!;
  return chooseBoundedInspectionTimestamps(
    {
      startSeconds: 0,
      endSeconds: scenario.duration,
      eventTimesSeconds: scenario.events,
      visualChangeTimesSeconds: scenario.visualChanges,
      neighborhoodSeconds: 0.2,
    },
    16,
  );
});

console.log("ClipQA temporal evidence coverage benchmark");
console.log("This measures whether selected evidence includes labeled defect intervals; it does not measure model diagnosis accuracy.\n");
console.table(
  [baseline, clipqa].map((result) => ({
    strategy: result.name,
    "defects covered": `${result.found}/${result.total}`,
    recall: `${((result.found / result.total) * 100).toFixed(1)}%`,
    "frames selected": result.frames,
  })),
);

if (clipqa.found !== clipqa.total) process.exitCode = 1;
