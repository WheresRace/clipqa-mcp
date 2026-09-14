export interface DefectInterval {
  start: number;
  end: number;
}

export interface TemporalScenario {
  name: string;
  duration: number;
  defects: DefectInterval[];
  events: number[];
  visualChanges: number[];
}

export const scenarios: TemporalScenario[] = [
  {
    name: "single-frame purchase-button flicker",
    duration: 15,
    defects: [{ start: 4.08, end: 4.16 }],
    events: [4.05],
    visualChanges: [4.09],
  },
  {
    name: "placement preview teleports and returns",
    duration: 20,
    defects: [{ start: 12.42, end: 12.61 }],
    events: [12.35],
    visualChanges: [12.44, 12.6],
  },
  {
    name: "dialog closes late after click",
    duration: 18,
    defects: [{ start: 8.5, end: 10.2 }],
    events: [8.0],
    visualChanges: [10.2],
  },
  {
    name: "loading overlay gets stuck",
    duration: 30,
    defects: [{ start: 16, end: 30 }],
    events: [14.8],
    visualChanges: [15.1],
  },
  {
    name: "tooltip flashes at the wrong location",
    duration: 25,
    defects: [{ start: 22.01, end: 22.11 }],
    events: [21.95],
    visualChanges: [22.02],
  },
  {
    name: "character collision causes a short teleport",
    duration: 12,
    defects: [{ start: 6.18, end: 6.36 }],
    events: [6.16],
    visualChanges: [6.2],
  },
  {
    name: "purchase state updates near end of test",
    duration: 32,
    defects: [{ start: 28.5, end: 29.8 }],
    events: [28.1],
    visualChanges: [29.7],
  },
  {
    name: "animation freezes briefly without an input event",
    duration: 24,
    defects: [{ start: 16.0, end: 16.7 }],
    events: [],
    visualChanges: [16.05, 16.65],
  },
  {
    name: "clean run",
    duration: 20,
    defects: [],
    events: [3, 8, 14],
    visualChanges: [3.1, 8.2, 14.2],
  },
];
