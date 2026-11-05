import fs from "node:fs/promises";
import path from "node:path";
import { escapeXml } from "./media.js";
import type { ClipMetrics } from "./metrics.js";
import type { QaFinding, RecordingSession } from "./types.js";

export interface Checkpoint {
  id: string; category: string; title: string; points: number; lookFor: string[]; verify: string;
  /** The written standard a grade is judged against. */
  standard?: string;
  /** Requirements the user listed; failing one always needs work. */
  mustPass?: boolean;
  /** Grade this checkpoint from measurements when the reviewer has not. */
  auto?: (m: ClipMetrics, recordedFps: number) => { grade: Grade; note: string } | undefined;
}

export type Grade = 0 | 1 | 2 | 3 | 4;
export const GRADE_NAMES = ["broken", "poor", "acceptable", "good", "excellent"] as const;
// Grade 3 ("good: meets the standard") earns full points, so a plain pass keeps its old meaning.
// Grade 2 earns partial credit; grade 4 earns bonus points on top.
const GRADE_FACTOR = [0, .25, .7, 1, 1] as const;
export const PROFILES = ["character", "ui", "vfx", "camera", "gameplay", "general"] as const;
export type Profile = typeof PROFILES[number];

const step = (value: number, cuts: [number, number, number, number], higherIsBetter = true): Grade => {
  const [a, b, c, d] = cuts;
  if (higherIsBetter) return (value >= a ? 4 : value >= b ? 3 : value >= c ? 2 : value >= d ? 1 : 0) as Grade;
  return (value <= a ? 4 : value <= b ? 3 : value <= c ? 2 : value <= d ? 1 : 0) as Grade;
};

const C = (c: Checkpoint) => c;
const LIBRARY: Record<string, Checkpoint> = Object.fromEntries([
  // Body proportions and mesh (character)
  C({ id: "proportions.symmetry", category: "Body proportions", title: "Left and right sides match", points: 2, lookFor: ["one arm or leg longer, thicker or set higher than the other", "shoulders or hips at different heights when they should be level", "hands or feet of different sizes"], verify: "Compare the front and back orbit views; zoom_frame on each limb pair at the same timestamp." }),
  C({ id: "proportions.ratios", category: "Body proportions", title: "Head, torso and limb ratios are believable for the style", points: 2, lookFor: ["oversized or tiny head, hands or feet that the style does not call for", "torso too long or short for the legs", "forearm and upper arm (or shin and thigh) clearly unequal"], verify: "Use the side (left/right) orbit views at elevation 0, where lengths are least distorted." }),
  C({ id: "proportions.joints", category: "Body proportions", title: "Joints sit where they should and limbs attach cleanly", points: 2, lookFor: ["elbows or knees bending at the wrong point along the limb", "shoulders floating away from the torso or sunk into it", "gaps or seams opening at joints"], verify: "zoom_frame on shoulders, elbows, hips and knees from front, side and back views." }),
  C({ id: "proportions.stable", category: "Body proportions", title: "Proportions stay constant while moving", points: 1, lookFor: ["limbs stretching or shrinking during animation", "volume collapsing at bends", "parts scaling between frames"], verify: "Compare the same body part at the start, middle and end of the motion with get_frames." }),
  C({ id: "mesh.twisting", category: "Mesh integrity", title: "No twisted or candy-wrapped geometry", points: 3, lookFor: ["wrists, forearms, shoulders, hips or neck pinched or corkscrewed like a candy wrapper", "a limb rotated past what its skin can follow", "texture or clothing patterns spiralling around a limb"], verify: "zoom_frame (2-4x, sharpened) on every joint in the most extreme pose; check from at least two azimuths." }),
  C({ id: "mesh.surface", category: "Mesh integrity", title: "Surface is intact", points: 2, lookFor: ["spikes or stray stretched vertices", "holes, missing faces or see-through/inverted (black or invisible) faces", "flickering z-fighting between overlapping surfaces"], verify: "Scan every orbit view, including top and underside; zoom on anything that looks jagged or dark." }),
  C({ id: "mesh.intersections", category: "Mesh integrity", title: "No clipping or intersections", points: 2, lookFor: ["hands, arms or legs passing through the body", "clothing, hair or accessories poking through skin", "feet or body sinking into the floor or props"], verify: "Check side and back views and the most compressed pose; zoom where limbs meet the torso." }),
  C({ id: "mesh.attached", category: "Mesh integrity", title: "All parts attached", points: 1, lookFor: ["floating or detached parts", "accessories left behind while the body moves", "a part offset from where it should be mounted"], verify: "Watch the parts across frames during motion; orbit views catch offsets hidden from the front." }),
  C({ id: "pose.request", category: "Pose and intent", title: "Pose and action match the user's request", points: 3, lookFor: ["wrong limb used (left vs right)", "facing the wrong way or wrong head/eye direction", "missing a requested element: prop, gesture, expression, stance, timing", "an extra action that was not asked for"], verify: "Split the request into individual requirements and check each one by name against specific frames. Any unmet requirement fails this checkpoint." }),
  C({ id: "pose.anatomy", category: "Pose and intent", title: "Pose is physically possible", points: 2, lookFor: ["knees or elbows bent backwards or hyperextended", "neck or spine twisted beyond a natural range", "fingers or toes mangled, merged or bent impossibly", "balance impossible: weight far outside the feet with no support"], verify: "zoom_frame on hands, knees, elbows and neck; judge balance from the side views." }),
  C({ id: "pose.contact", category: "Pose and intent", title: "Contacts are correct", points: 2, lookFor: ["feet floating above or sliding along the ground while planted", "hands not actually touching what they hold or push", "props passing through the hand"], verify: "inspect_between mode=onion over a planted step shows sliding as a smear; zoom on feet and hands." }),
  // Motion and the principles of animation
  C({ id: "motion.fluidity", category: "Motion", title: "Motion is fluid (no hitches, pops or snaps)", points: 3, lookFor: ["freezes or repeated frames during movement", "sudden pops where a limb jumps between frames", "snapping between keyframes instead of interpolating"], verify: "analyze_motion (record at 30-60 FPS), then inspect_between mode=strip around each flagged time.", standard: "Smoothness score: 95+ excellent, 85+ good, 70+ acceptable.",
    auto: m => m.motion.verdict === "no motion" ? undefined : { grade: step(m.motion.fluidityScore, [95, 85, 70, 50]), note: `auto: smoothness ${m.motion.fluidityScore}/100, ${m.motion.hitches} hitches, ${m.motion.pops} pops` } }),
  C({ id: "motion.quality", category: "Motion", title: "Timing, arcs and stillness look natural", points: 2, lookFor: ["robotic linear movement with no ease in/out (unless requested)", "jitter or vibration when the body should be still", "a visible pop where a loop restarts"], verify: "Check the measured easing and jitter-while-still, then inspect_between around the start, peak and end of each action and the loop point.", standard: "Most movements ease in and out (measured easing 0.75+); no visible jitter when still." }),
  C({ id: "anim.anticipation", category: "Animation principles", title: "Anticipation and follow-through", points: 2, lookFor: ["big actions (jump, throw, swing) start with no wind-up", "hair, cloth, tails or loose parts stop dead at the same instant as the body", "everything moves and stops in perfect sync (no overlapping action)"], verify: "inspect_between mode=strip on the 0.3 s before and after each big action." }),
  C({ id: "anim.arcs", category: "Animation principles", title: "Movement follows arcs", points: 1, lookFor: ["hands, head or feet travelling in straight lines", "paths with kinks or sudden direction changes"], verify: "inspect_between mode=onion over each gesture: the coloured trail should curve smoothly." }),
  C({ id: "anim.weight", category: "Animation principles", title: "Timing conveys weight", points: 1, lookFor: ["heavy things moving as fast as light things", "landings with no compression or settle", "floaty jumps with constant speed"], verify: "Compare ascent, hang time and landing in a strip; watch the settle time after events." }),
  C({ id: "coverage.angles", category: "Coverage", title: "Checked from every angle", points: 2, lookFor: ["problems visible only from the back, top or underside", "silhouette reading wrong from the side", "anything hidden from the default camera"], verify: "Use orbit_plan + orbit_sheet so every azimuth and elevation (and close-ups) was looked at." }),
  C({ id: "render.materials", category: "Rendering", title: "Materials and textures look right", points: 1, lookFor: ["missing or stretched textures", "wrong colours or materials compared with the request", "lighting artefacts that hide detail"], verify: "Zoom on texture seams and colour-critical areas." }),
  // Measured standards shared by every profile
  C({ id: "perf.framerate", category: "Performance", title: "Hits its frame rate while moving", points: 2, lookFor: ["motion updating fewer times per second than the recording", "frame rate dropping during heavy moments"], verify: "Measured: real FPS while moving vs the recording FPS. Confirm drops with inspect_between mode=strip.", standard: "Real FPS while moving at least 95% of the recorded FPS (record at the target, e.g. 60).",
    auto: (m, fps) => m.effectiveFps === null ? undefined : { grade: step(m.effectiveFps / Math.max(1, fps), [.95, .85, .7, .5]), note: `auto: ${m.effectiveFps} new frames/s while moving of ${fps} recorded` } }),
  C({ id: "perf.pacing", category: "Performance", title: "Frames arrive evenly", points: 2, lookFor: ["judder: uneven gaps between new frames even at a good average FPS", "periodic long frames (stutter)"], verify: "Measured from gaps between new frames.", standard: "Gap unevenness under 10% and under 1% long frames (>1.5× usual) for excellent; under 20% / 3% for good.",
    auto: m => m.pacing.jitter === null || m.pacing.longFrameRatio === null ? undefined : { grade: Math.min(step(m.pacing.jitter, [.1, .2, .35, .5], false), step(m.pacing.longFrameRatio, [.01, .03, .08, .15], false)) as Grade, note: `auto: pacing unevenness ${m.pacing.jitter}, long frames ${(m.pacing.longFrameRatio * 100).toFixed(1)}%` } }),
  C({ id: "render.flicker", category: "Rendering", title: "No flicker or black frames", points: 2, lookFor: ["brightness pulsing frame to frame", "single black or blank frames", "z-fighting shimmer"], verify: "Measured flicker and black frames; inspect_between mode=changes catches one-frame flashes.", standard: "Under 0.2 brightness reversals per second and no black frames for excellent; under 0.5/s for good.",
    auto: m => ({ grade: m.blackFrames > 0 ? (m.blackFrames > 3 ? 0 : 1) : step(m.flickerPerSecond, [.2, .5, 1.5, 3], false), note: `auto: ${m.flickerPerSecond} flicker/s, ${m.blackFrames} black frames` }) }),
  C({ id: "render.exposure", category: "Rendering", title: "Exposure and clarity", points: 1, lookFor: ["details lost in pure black or pure white", "blurry or smeared image where it should be sharp"], verify: "Measured crushed/blown pixels; zoom on dark and bright areas.", standard: "Under 1% crushed blacks and under 1% blown highlights, unless the style calls for it.",
    auto: m => ({ grade: step(Math.max(m.exposure.crushed, m.exposure.blown), [.01, .03, .08, .2], false), note: `auto: ${(m.exposure.crushed * 100).toFixed(1)}% crushed, ${(m.exposure.blown * 100).toFixed(1)}% blown` }) }),
  C({ id: "intent.request", category: "Intent", title: "Result matches the request", points: 3, lookFor: ["anything asked for that is missing or different", "something added that was not asked for"], verify: "Split the request into separate requirements and check each one against specific frames." }),
  C({ id: "general.glitches", category: "Visual quality", title: "No visual glitches", points: 3, lookFor: ["missing or stretched textures", "objects popping in or out", "z-fighting, clipping, misplaced or overlapping elements"], verify: "inspect_clip, then inspect_between mode=changes over the whole clip to catch brief glitches." }),
  C({ id: "general.consistency", category: "Visual quality", title: "Consistent with the style and previous version", points: 2, lookFor: ["colours, sizes or spacing differing from the rest", "a regression compared with an earlier recording"], verify: "compare_clips against a known-good recording when one exists." }),
  // UI
  C({ id: "ui.layout", category: "UI", title: "Layout is aligned and nothing is cut off", points: 3, lookFor: ["misaligned edges or uneven spacing", "text truncated, overflowing or overlapping", "elements jumping position as content loads"], verify: "zoom_frame with showGrid on each screen; inspect_between mode=changes during loading.", standard: "Consistent spacing (one spacing scale), aligned edges, no truncation or layout shift." }),
  C({ id: "ui.text", category: "UI", title: "Text is legible", points: 2, lookFor: ["low contrast text", "text too small or blurry", "inconsistent fonts or sizes"], verify: "zoom_frame on small and low-contrast text.", standard: "Contrast at least WCAG AA (4.5:1 body, 3:1 large text); crisp rendering." }),
  C({ id: "ui.states", category: "UI", title: "Interactive states and feedback", points: 2, lookFor: ["no visible hover, pressed, focus or disabled state", "no loading or progress feedback", "action with no confirmation"], verify: "mark_event each action, then inspect_between mode=strip around it." }),
  C({ id: "ui.transitions", category: "UI", title: "Transitions are quick and eased", points: 2, lookFor: ["transitions too slow or abrupt", "linear robotic motion", "content flashing during transitions"], verify: "inspect_between mode=strip over each transition; check easing and settle time.", standard: "Most transitions 150-400 ms, eased, settling within 0.5 s of the action." }),
  C({ id: "ui.response", category: "UI", title: "Responds immediately", points: 2, lookFor: ["visible delay between an action and its response"], verify: "Use mark_event for each action and read the measured settle time; inspect_between right after the event.", standard: "Visible response within 100 ms of the action (one to six frames at 60 FPS)." }),
  // VFX
  C({ id: "vfx.readability", category: "VFX", title: "Effect reads clearly", points: 2, lookFor: ["shape lost against the background", "too busy or noisy to read", "colour clashing with the scene"], verify: "Look at the peak frame and at small size; onion skin shows the overall shape." }),
  C({ id: "vfx.timing", category: "VFX", title: "Anticipation, impact and dissipation", points: 2, lookFor: ["no build-up before impact", "abrupt cut-off instead of fading out", "lingers too long"], verify: "inspect_between mode=strip over the whole effect." }),
  C({ id: "vfx.integration", category: "VFX", title: "Blends with the scene", points: 2, lookFor: ["hard edges where particles meet geometry", "sorting errors (drawn in front of or behind the wrong thing)", "particles passing through walls"], verify: "zoom_frame where the effect meets geometry." }),
  // Camera
  C({ id: "camera.stability", category: "Camera", title: "No unintended shake or drift", points: 3, lookFor: ["vibration when the camera should be still", "drift after a move ends"], verify: "Measured jitter while still; inspect_between mode=changes over still stretches.", standard: "Jitter while still under 0.05 (no visible shake)." }),
  C({ id: "camera.motion", category: "Camera", title: "Camera moves are smooth and eased", points: 2, lookFor: ["abrupt starts or stops", "speed changes mid-move", "clipping into geometry"], verify: "analyze_motion over each move; strip at the start and end." }),
  C({ id: "camera.framing", category: "Camera", title: "Subject is framed well", points: 2, lookFor: ["subject cut off or off-centre without reason", "important action out of frame"], verify: "inspect_clip contact sheet across the move." }),
  // Gameplay
  C({ id: "game.response", category: "Gameplay", title: "Input feels responsive", points: 3, lookFor: ["delay between input and on-screen reaction"], verify: "mark_event on each input; measured settle time and a strip right after the event.", standard: "Visible reaction within 100 ms (50 ms excellent)." }),
  C({ id: "game.feedback", category: "Gameplay", title: "Actions have clear feedback", points: 2, lookFor: ["hits, pickups or damage with no visual feedback", "feedback too subtle to notice"], verify: "inspect_between mode=strip around each action." }),
  C({ id: "game.physics", category: "Gameplay", title: "Physics behave", points: 2, lookFor: ["objects jittering at rest", "tunnelling through walls or floors", "sudden teleports"], verify: "inspect_between mode=changes over resting objects; strip around collisions." }),
].map(c => [c.id, c]));

const CHARACTER = ["proportions.symmetry", "proportions.ratios", "proportions.joints", "proportions.stable", "mesh.twisting", "mesh.surface", "mesh.intersections", "mesh.attached", "pose.request", "pose.anatomy", "pose.contact", "motion.fluidity", "motion.quality", "coverage.angles", "render.materials"];
const PROFILE_IDS: Record<Profile, string[]> = {
  character: [...CHARACTER, "anim.anticipation", "anim.arcs", "anim.weight", "perf.framerate", "perf.pacing", "render.flicker", "render.exposure"],
  ui: ["intent.request", "ui.layout", "ui.text", "ui.states", "ui.transitions", "ui.response", "motion.fluidity", "perf.framerate", "perf.pacing", "render.flicker", "general.glitches", "general.consistency"],
  vfx: ["intent.request", "vfx.readability", "vfx.timing", "vfx.integration", "anim.arcs", "motion.fluidity", "perf.framerate", "perf.pacing", "render.flicker", "render.exposure", "general.glitches"],
  camera: ["intent.request", "camera.stability", "camera.motion", "camera.framing", "motion.fluidity", "perf.framerate", "perf.pacing", "render.flicker", "general.glitches"],
  gameplay: ["intent.request", "game.response", "game.feedback", "game.physics", "motion.fluidity", "perf.framerate", "perf.pacing", "render.flicker", "render.exposure", "general.glitches", "general.consistency"],
  general: ["intent.request", "general.glitches", "general.consistency", "motion.fluidity", "perf.framerate", "perf.pacing", "render.flicker", "render.exposure"],
};

/** The original character checklist, kept for compatibility. */
export const CHECKPOINTS: Checkpoint[] = CHARACTER.map(id => LIBRARY[id]!);

export function checkpointsFor(profile: Profile = "character", requirements: string[] = []): Checkpoint[] {
  const base = PROFILE_IDS[profile].map(id => LIBRARY[id]!);
  const custom = requirements.map((text, i) => ({ id: `req.${i + 1}`, category: "Your requirements", title: text, points: 3, lookFor: ["anything that does not match this requirement exactly"], verify: "Check it against specific frames; any mismatch fails.", mustPass: true }));
  return [...custom, ...base];
}

export const sessionCheckpoints = (s: Pick<RecordingSession, "profile" | "requirements">) => checkpointsFor(s.profile ?? "character", s.requirements ?? []);

/** Grade of a finding: explicit grade, else pass = 3 (meets the standard), fail = 0. Unclear has no grade. */
export function gradeOf(f: QaFinding): Grade | undefined {
  if (f.grade !== undefined) return f.grade as Grade;
  return f.status === "pass" ? 3 : f.status === "fail" ? 0 : undefined;
}

export function latestFindings(findings: QaFinding[] = []): Map<string, QaFinding> {
  const map = new Map<string, QaFinding>();
  for (const finding of findings) map.set(finding.checkpoint, finding);
  return map;
}

export interface Bonus { reason: string; points: number }

/** Plus points for quality beyond the standard. Only measured facts and explicit "excellent" grades count. */
export function bonusPoints(findings: Map<string, QaFinding>, checkpoints: Checkpoint[], metrics?: ClipMetrics, recordedFps = 30): Bonus[] {
  const out: Bonus[] = [];
  if (metrics) {
    const m = metrics;
    if (m.motion.verdict !== "no motion" && m.motion.fluidityScore >= 95 && !m.motion.hitches && !m.motion.pops) out.push({ reason: "Silky smooth: smoothness 95+ with no hitches or pops", points: 3 });
    if (m.effectiveFps !== null && m.effectiveFps >= .97 * recordedFps && recordedFps >= 50) out.push({ reason: `Full ${recordedFps} FPS while moving`, points: 2 });
    if (m.pacing.jitter !== null && m.pacing.jitter <= .1 && (m.pacing.longFrameRatio ?? 1) <= .01) out.push({ reason: "Even frame pacing", points: 2 });
    if (m.easing !== null && m.easing >= .75) out.push({ reason: "Movements ease in and out", points: 1 });
    if (m.stillJitter !== null && m.stillJitter <= .02) out.push({ reason: "Rock-steady when still", points: 1 });
  }
  const excellent = checkpoints.filter(c => gradeOf(findings.get(c.id) ?? { status: "unclear" } as QaFinding) === 4 && !findings.get(c.id)?.note.startsWith("auto:"));
  if (excellent.length) out.push({ reason: `Rated excellent: ${excellent.map(c => c.title).slice(0, 4).join("; ")}`, points: Math.min(3, excellent.length * .5) });
  return out;
}

export const MAX_BONUS = 10;

export function letter(total: number): string {
  return total >= 100 ? "A+" : total >= 90 ? "A" : total >= 80 ? "B" : total >= 70 ? "C" : total >= 60 ? "D" : "F";
}

export function scoreFindings(findings: QaFinding[] = [], checkpoints = CHECKPOINTS, metrics?: ClipMetrics, recordedFps?: number) {
  const latest = latestFindings(findings);
  const total = checkpoints.reduce((sum, c) => sum + c.points, 0);
  let earned = 0;
  const unchecked: string[] = [], failed: string[] = [], blockers: string[] = [], missedRequirements: string[] = [];
  for (const checkpoint of checkpoints) {
    const finding = latest.get(checkpoint.id);
    if (!finding) { unchecked.push(checkpoint.id); continue; }
    const grade = gradeOf(finding);
    earned += checkpoint.points * (grade === undefined ? .5 : GRADE_FACTOR[grade]);
    if (finding.status === "fail") {
      failed.push(checkpoint.id);
      if (finding.severity === "blocker") blockers.push(checkpoint.id);
      if (checkpoint.mustPass) missedRequirements.push(checkpoint.title);
    }
  }
  const score = Math.round(earned / total * 100);
  const bonus = blockers.length ? [] : bonusPoints(latest, checkpoints, metrics, recordedFps);
  const bonusTotal = Math.min(MAX_BONUS, bonus.reduce((s, b) => s + b.points, 0));
  const verdict = blockers.length ? "FAIL" : unchecked.length ? "INCOMPLETE" : failed.length || score < 85 ? "NEEDS WORK" : "PASS";
  const finalScore = score + bonusTotal;
  return { score, bonus: bonusTotal, bonuses: bonus, total: finalScore, letter: letter(finalScore), earned, of: checkpoints.length, max: total, verdict, unchecked, failed, blockers, missedRequirements, checked: checkpoints.length - unchecked.length };
}

export function checklistText(request: string | undefined, checkpoints = CHECKPOINTS, profile: Profile = "character"): string {
  const lines = [
    `CLIPQA REVIEW CHECKLIST (${profile})`,
    request ? `User request: "${request}"` : "User request: not provided. Ask for it, or judge the request checkpoint against the conversation.",
    "",
    "Treat every item as a question to answer with evidence. Assume something is broken until you have looked.",
    "Grade each 0-4: 0 broken, 1 poor, 2 acceptable, 3 good (meets the standard), 4 excellent (clearly beyond it; earns bonus points). Severity for failures: blocker / major / minor.",
    "Items marked [auto] were graded from measurements; override them if what you see disagrees.",
    "",
  ];
  let category = "";
  for (const c of checkpoints) {
    if (c.category !== category) { category = c.category; lines.push(`## ${category}`); }
    lines.push(`- [${c.id}] (${c.points} pts${c.mustPass ? ", must pass" : ""}) ${c.title}`, `    Look for: ${c.lookFor.join("; ")}.`, `    How: ${c.verify}`);
    if (c.standard) lines.push(`    Standard: ${c.standard}`);
  }
  lines.push("", "Workflow:", "1. Read the contact sheet below. Note anything suspicious with its timestamp.", "2. For a character, model or pose: orbit_plan -> run the script while recording -> orbit_sheet to see every angle, including close-ups.", "3. Look between samples: inspect_between mode=strip (every frame), onion (paths and arcs) or changes (anything that changed at any point).", "4. zoom_frame on joints, hands, feet, face and anything suspicious.", "5. record_finding for EVERY checkpoint with a grade and a specific note. Do not grade without having looked.", "6. qa_report for the score, bonus points and verdict. Report failures honestly; do not round a FAIL up.");
  return lines.join("\n");
}

/** Auto-grade measured checkpoints the reviewer has not graded yet. */
export function autoFindings(checkpoints: Checkpoint[], existing: QaFinding[] = [], metrics: ClipMetrics, recordedFps: number): QaFinding[] {
  const latest = latestFindings(existing), out: QaFinding[] = [];
  for (const c of checkpoints) {
    if (!c.auto || latest.has(c.id)) continue;
    const result = c.auto(metrics, recordedFps);
    if (!result) continue;
    const status = result.grade >= 2 ? "pass" as const : "fail" as const;
    out.push({ checkpoint: c.id, status, grade: result.grade, ...(status === "fail" ? { severity: result.grade === 0 ? "major" as const : "minor" as const } : {}), note: result.note, recordedAt: new Date().toISOString() });
  }
  return out;
}

export interface ReviewDelta { checkpoint: string; title: string; before: Grade | null; after: Grade | null; verdict: "improved" | "regressed" | "unchanged" | "n/a" }

/** Grade changes between two reviews of the same kind of work. */
export function compareReviews(before: RecordingSession, after: RecordingSession) {
  const checkpoints = sessionCheckpoints(after), a = latestFindings(before.findings), b = latestFindings(after.findings);
  const rows: ReviewDelta[] = checkpoints.map(c => {
    const ga = a.get(c.id) ? gradeOf(a.get(c.id)!) ?? null : null, gb = b.get(c.id) ? gradeOf(b.get(c.id)!) ?? null : null;
    return { checkpoint: c.id, title: c.title, before: ga, after: gb, verdict: ga === null || gb === null ? "n/a" : gb > ga ? "improved" : gb < ga ? "regressed" : "unchanged" };
  });
  const sa = scoreFindings(before.findings, sessionCheckpoints(before), before.qualityMetrics, before.fps);
  const sb = scoreFindings(after.findings, checkpoints, after.qualityMetrics, after.fps);
  return { before: { total: sa.total, verdict: sa.verdict }, after: { total: sb.total, verdict: sb.verdict }, change: sb.total - sa.total, improved: rows.filter(r => r.verdict === "improved").map(r => r.title), regressed: rows.filter(r => r.verdict === "regressed").map(r => r.title), rows: rows.filter(r => r.verdict === "improved" || r.verdict === "regressed") };
}

export async function writeQaReport(session: RecordingSession, directory: string, extraHtml = ""): Promise<{ reportPath: string; jsonPath: string } & ReturnType<typeof scoreFindings>> {
  const checkpoints = sessionCheckpoints(session);
  const summary = scoreFindings(session.findings, checkpoints, session.qualityMetrics, session.fps);
  const latest = latestFindings(session.findings);
  await fs.mkdir(directory, { recursive: true });
  const rows = await Promise.all(checkpoints.map(async c => {
    const f = latest.get(c.id);
    const evidence = f?.evidencePath ? await fs.readFile(f.evidencePath).then(d => `<img alt="Evidence" src="data:image/jpeg;base64,${d.toString("base64")}">`, () => "") : "";
    const grade = f ? gradeOf(f) : undefined;
    const status = f ? `${f.status.toUpperCase()}${grade !== undefined ? `<br>${grade}/4 ${GRADE_NAMES[grade]}` : ""}` : "NOT CHECKED";
    const where = [f?.timestampSeconds !== undefined ? `${f.timestampSeconds.toFixed(3)}s` : "", f?.view ?? ""].filter(Boolean).join(" · ");
    return `<tr class="${f?.status ?? "none"}"><td>${escapeXml(c.category)}<br><b>${escapeXml(c.title)}</b><br><code>${c.id}</code>${c.standard ? `<br><small>Standard: ${escapeXml(c.standard)}</small>` : ""}</td><td>${status}${f?.severity ? `<br>${f.severity}` : ""}</td><td>${c.points}</td><td>${escapeXml(f?.note ?? "")}${where ? `<br><small>${escapeXml(where)}</small>` : ""}${evidence}</td></tr>`;
  }));
  const json = { schemaVersion: 2, sessionId: session.id, request: session.request, profile: session.profile ?? "character", requirements: session.requirements ?? [], ...summary, findings: session.findings ?? [] };
  const jsonPath = path.join(directory, "qa-report.json"), reportPath = path.join(directory, "qa-report.html");
  const bonusHtml = summary.bonuses.length ? `<p>Bonus: ${summary.bonuses.map(b => `+${b.points} ${escapeXml(b.reason)}`).join(" · ")}</p>` : "";
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
  await fs.writeFile(reportPath, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ClipQA review</title><style>body{font:15px system-ui;background:#0d1117;color:#e6edf3;margin:32px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #30363d;padding:10px;vertical-align:top}tr.fail td:nth-child(2){color:#f87171;font-weight:bold}tr.pass td:nth-child(2){color:#4ade80}tr.unclear td:nth-child(2){color:#fbbf24}tr.none td:nth-child(2){color:#8b949e}img{max-width:420px;display:block;margin-top:8px}code,small{color:#8b949e}h1 span{font-size:16px;color:#8b949e}</style><h1>${summary.verdict} · ${summary.letter} · ${summary.score}/100${summary.bonus ? ` +${summary.bonus} bonus` : ""} <span>${summary.checked}/${summary.of} checkpoints checked · ${escapeXml(session.profile ?? "character")}</span></h1>${session.request ? `<p>Request: ${escapeXml(session.request)}</p>` : ""}${bonusHtml}${extraHtml}<table><tr><td>Checkpoint</td><td>Status</td><td>Points</td><td>Notes and evidence</td></tr>${rows.join("")}</table></html>`);
  return { reportPath, jsonPath, ...summary };
}
