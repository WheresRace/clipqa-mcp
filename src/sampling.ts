export interface InspectionSignals {
  startSeconds: number;
  endSeconds: number;
  overviewSamples: number;
  eventTimesSeconds?: number[];
  visualChangeTimesSeconds?: number[];
  neighborhoodSeconds?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function evenlySpaced(start: number, end: number, count: number): number[] {
  if (count <= 0 || end < start) return [];
  if (count === 1 || end === start) return [start];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => start + step * index);
}

export function chooseInspectionTimestamps(signals: InspectionSignals): number[] {
  const {
    startSeconds,
    endSeconds,
    overviewSamples,
    eventTimesSeconds = [],
    visualChangeTimesSeconds = [],
    neighborhoodSeconds = 0.2,
  } = signals;
  const candidates = evenlySpaced(startSeconds, endSeconds, overviewSamples);

  for (const time of [...eventTimesSeconds, ...visualChangeTimesSeconds]) {
    candidates.push(time - neighborhoodSeconds, time, time + neighborhoodSeconds);
  }

  return [...new Set(candidates.map((time) => clamp(time, startSeconds, endSeconds).toFixed(3)))]
    .map(Number)
    .sort((a, b) => a - b);
}

export function chooseBoundedInspectionTimestamps(
  signals: Omit<InspectionSignals, "overviewSamples">,
  maxSamples: number,
): number[] {
  if (maxSamples <= 0) return [];
  const {
    startSeconds,
    endSeconds,
    eventTimesSeconds = [],
    visualChangeTimesSeconds = [],
    neighborhoodSeconds = 0.2,
  } = signals;
  const result = new Set<string>();
  const add = (time: number) => {
    if (result.size >= maxSamples) return;
    result.add(clamp(time, startSeconds, endSeconds).toFixed(3));
  };

  add(startSeconds);
  add(endSeconds);
  const anchors = [...new Set([...eventTimesSeconds, ...visualChangeTimesSeconds])]
    .filter((time) => time >= startSeconds && time <= endSeconds)
    .sort((a, b) => a - b);
  for (const time of anchors) add(time);
  for (const time of anchors) {
    add(time - neighborhoodSeconds);
    add(time + neighborhoodSeconds);
  }
  for (const time of evenlySpaced(startSeconds, endSeconds, maxSamples)) add(time);

  return [...result].map(Number).sort((a, b) => a - b);
}

export function hitsInterval(timestamp: number, start: number, end: number): boolean {
  return timestamp >= start && timestamp <= end;
}
