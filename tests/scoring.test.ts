import { describe, expect, it } from "vitest";
import { autoFindings, checkpointsFor, checklistText, compareReviews, PROFILES, scoreFindings } from "../src/qa.js";
import type { ClipMetrics } from "../src/metrics.js";
import type { QaFinding, RecordingSession } from "../src/types.js";

const f = (checkpoint: string, status: QaFinding["status"], grade?: number, severity?: QaFinding["severity"]): QaFinding => ({ checkpoint, status, ...(grade !== undefined ? { grade } : {}), ...(severity ? { severity } : {}), note: "checked", recordedAt: new Date().toISOString() });
const metrics = (over: Partial<ClipMetrics> = {}): ClipMetrics => ({
  start: 0, end: 3, analysisFps: 60, frames: 180,
  motion: { fluidityScore: 98, verdict: "smooth", duplicateFrames: 0, speedVariation: .2, hitches: 0, pops: 0, movingFrames: 170 },
  effectiveFps: 60, pacing: { jitter: .05, longFrameRatio: 0 }, easing: .9, stillJitter: .01, sharpness: 300,
  exposure: { meanLuma: 120, crushed: 0, blown: 0 }, color: { r: 120, g: 120, b: 120 }, flickerPerSecond: 0, flashes: [], blackFrames: 0, longestFreezeSeconds: 0, settle: [], warnings: [], ...over,
});

describe("graded scoring", () => {
  const ui = checkpointsFor("ui");
  it("keeps plain passes at full points and gives partial credit for acceptable", () => {
    expect(scoreFindings(ui.map(c => f(c.id, "pass")), ui)).toMatchObject({ score: 100, verdict: "PASS", bonus: 0, letter: "A+" });
    const acceptable = scoreFindings(ui.map(c => f(c.id, "pass", 2)), ui);
    expect(acceptable.score).toBe(70); expect(acceptable.verdict).toBe("NEEDS WORK");
  });
  it("adds bonus points for measured smoothness and excellent grades, capped at 10", () => {
    const s = scoreFindings(ui.map(c => f(c.id, "pass", 4)), ui, metrics(), 60);
    expect(s.score).toBe(100); expect(s.bonus).toBe(10); expect(s.total).toBe(110);
    expect(s.bonuses.map(b => b.reason).join()).toContain("Silky smooth");
    const choppy = scoreFindings(ui.map(c => f(c.id, "pass")), ui, metrics({ motion: { ...metrics().motion, fluidityScore: 60, hitches: 4 }, effectiveFps: 30, pacing: { jitter: .5, longFrameRatio: .2 }, easing: .1, stillJitter: .3 }), 60);
    expect(choppy.bonus).toBe(0);
  });
  it("gives no bonus when there is a blocker", () => {
    const s = scoreFindings([...ui.map(c => f(c.id, "pass", 4)), f("ui.layout", "fail", 0, "blocker")], ui, metrics(), 60);
    expect(s.verdict).toBe("FAIL"); expect(s.bonus).toBe(0);
  });
  it("turns the user's requirements into must-pass checkpoints", () => {
    const cps = checkpointsFor("character", ["waves with the LEFT hand", "loop is seamless"]);
    expect(cps.slice(0, 2).map(c => c.id)).toEqual(["req.1", "req.2"]);
    const s = scoreFindings([...cps.map(c => f(c.id, "pass")), f("req.1", "fail", 1, "minor")], cps);
    expect(s.verdict).toBe("NEEDS WORK"); expect(s.missedRequirements).toEqual(["waves with the LEFT hand"]);
    expect(checklistText("wave", cps)).toContain("must pass");
  });
  it("has a checklist for every profile with written standards", () => {
    for (const p of PROFILES) {
      const cps = checkpointsFor(p);
      expect(cps.length).toBeGreaterThan(6);
      expect(new Set(cps.map(c => c.id)).size).toBe(cps.length);
      expect(cps.some(c => c.standard)).toBe(true);
    }
    expect(checklistText(undefined, checkpointsFor("character"))).toContain("Animation principles");
  });
  it("auto-grades measured checkpoints without overriding the reviewer", () => {
    const cps = checkpointsFor("general");
    const auto = autoFindings(cps, [], metrics({ effectiveFps: 30 }), 60);
    expect(auto.find(a => a.checkpoint === "motion.fluidity")?.grade).toBe(4);
    expect(auto.find(a => a.checkpoint === "perf.framerate")).toMatchObject({ grade: 1, status: "fail" });
    expect(autoFindings(cps, [f("perf.framerate", "pass", 3)], metrics({ effectiveFps: 30 }), 60).some(a => a.checkpoint === "perf.framerate")).toBe(false);
  });
  it("compares two reviews grade by grade", () => {
    const base = { id: "a", state: "stopped", target: {}, startedAt: "", fps: 60, encoder: "", drawMouse: false, maxSeconds: 10, videoPath: "", events: [], profile: "ui" } as RecordingSession;
    const before = { ...base, findings: ui.map(c => f(c.id, "pass", c.id === "ui.text" ? 1 : 3)) };
    const after = { ...base, id: "b", findings: ui.map(c => f(c.id, "pass", c.id === "ui.text" ? 4 : c.id === "ui.layout" ? 2 : 3)) };
    const d = compareReviews(before, after);
    expect(d.improved).toContain("Text is legible"); expect(d.regressed).toContain("Layout is aligned and nothing is cut off");
    expect(d.rows).toHaveLength(2);
  });
});
