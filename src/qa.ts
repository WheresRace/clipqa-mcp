import fs from "node:fs/promises";
import path from "node:path";
import { escapeXml } from "./media.js";
import type { QaFinding, RecordingSession } from "./types.js";

export interface Checkpoint { id: string; category: string; title: string; points: number; lookFor: string[]; verify: string }

export const CHECKPOINTS: Checkpoint[] = [
  { id: "proportions.symmetry", category: "Body proportions", title: "Left and right sides match", points: 2, lookFor: ["one arm or leg longer, thicker or set higher than the other", "shoulders or hips at different heights when they should be level", "hands or feet of different sizes"], verify: "Compare the front and back orbit views; zoom_frame on each limb pair at the same timestamp." },
  { id: "proportions.ratios", category: "Body proportions", title: "Head, torso and limb ratios are believable for the style", points: 2, lookFor: ["oversized or tiny head, hands or feet that the style does not call for", "torso too long or short for the legs", "forearm and upper arm (or shin and thigh) clearly unequal"], verify: "Use the side (left/right) orbit views at elevation 0, where lengths are least distorted." },
  { id: "proportions.joints", category: "Body proportions", title: "Joints sit where they should and limbs attach cleanly", points: 2, lookFor: ["elbows or knees bending at the wrong point along the limb", "shoulders floating away from the torso or sunk into it", "gaps or seams opening at joints"], verify: "zoom_frame on shoulders, elbows, hips and knees from front, side and back views." },
  { id: "proportions.stable", category: "Body proportions", title: "Proportions stay constant while moving", points: 1, lookFor: ["limbs stretching or shrinking during animation", "volume collapsing at bends", "parts scaling between frames"], verify: "Compare the same body part at the start, middle and end of the motion with get_frames." },
  { id: "mesh.twisting", category: "Mesh integrity", title: "No twisted or candy-wrapped geometry", points: 3, lookFor: ["wrists, forearms, shoulders, hips or neck pinched or corkscrewed like a candy wrapper", "a limb rotated past what its skin can follow", "texture or clothing patterns spiralling around a limb"], verify: "zoom_frame (2-4x, sharpened) on every joint in the most extreme pose; check from at least two azimuths." },
  { id: "mesh.surface", category: "Mesh integrity", title: "Surface is intact", points: 2, lookFor: ["spikes or stray stretched vertices", "holes, missing faces or see-through/inverted (black or invisible) faces", "flickering z-fighting between overlapping surfaces"], verify: "Scan every orbit view, including top and underside; zoom on anything that looks jagged or dark." },
  { id: "mesh.intersections", category: "Mesh integrity", title: "No clipping or intersections", points: 2, lookFor: ["hands, arms or legs passing through the body", "clothing, hair or accessories poking through skin", "feet or body sinking into the floor or props"], verify: "Check side and back views and the most compressed pose; zoom where limbs meet the torso." },
  { id: "mesh.attached", category: "Mesh integrity", title: "All parts attached", points: 1, lookFor: ["floating or detached parts", "accessories left behind while the body moves", "a part offset from where it should be mounted"], verify: "Watch the parts across frames during motion; orbit views catch offsets hidden from the front." },
  { id: "pose.request", category: "Pose and intent", title: "Pose and action match the user's request", points: 3, lookFor: ["wrong limb used (left vs right)", "facing the wrong way or wrong head/eye direction", "missing a requested element: prop, gesture, expression, stance, timing", "an extra action that was not asked for"], verify: "Split the request into individual requirements and check each one by name against specific frames. Any unmet requirement fails this checkpoint." },
  { id: "pose.anatomy", category: "Pose and intent", title: "Pose is physically possible", points: 2, lookFor: ["knees or elbows bent backwards or hyperextended", "neck or spine twisted beyond a natural range", "fingers or toes mangled, merged or bent impossibly", "balance impossible: weight far outside the feet with no support"], verify: "zoom_frame on hands, knees, elbows and neck; judge balance from the side views." },
  { id: "pose.contact", category: "Pose and intent", title: "Contacts are correct", points: 2, lookFor: ["feet floating above or sliding along the ground while planted", "hands not actually touching what they hold or push", "props passing through the hand"], verify: "Zoom on feet and hands across consecutive frames; low elevation views make floating obvious." },
  { id: "motion.fluidity", category: "Motion", title: "Motion is fluid (no hitches, pops or snaps)", points: 3, lookFor: ["freezes or repeated frames during movement", "sudden pops where a limb jumps between frames", "snapping between keyframes instead of interpolating"], verify: "Run analyze_motion (record at 30-60 FPS) and confirm flagged timestamps with get_frames." },
  { id: "motion.quality", category: "Motion", title: "Timing, arcs and stillness look natural", points: 2, lookFor: ["robotic linear movement with no ease in/out (unless requested)", "uneven speed or limbs moving in straight lines instead of arcs", "jitter or vibration when the body should be still", "a visible pop where a loop restarts"], verify: "Look at consecutive frames around the start, peak and end of each action, and at the loop point." },
  { id: "coverage.angles", category: "Coverage", title: "Checked from every angle", points: 2, lookFor: ["problems visible only from the back, top or underside", "silhouette reading wrong from the side", "anything hidden from the default camera"], verify: "Use orbit_plan + orbit_sheet so every azimuth and elevation (and close-ups) was looked at." },
  { id: "render.materials", category: "Rendering", title: "Materials and textures look right", points: 1, lookFor: ["missing or stretched textures", "wrong colours or materials compared with the request", "lighting artefacts that hide detail"], verify: "Zoom on texture seams and colour-critical areas." },
];

const STATUS_FACTOR = { pass: 1, unclear: .5, fail: 0 } as const;

export function latestFindings(findings: QaFinding[] = []): Map<string, QaFinding> {
  const map = new Map<string, QaFinding>();
  for (const finding of findings) map.set(finding.checkpoint, finding);
  return map;
}

export function scoreFindings(findings: QaFinding[] = [], checkpoints = CHECKPOINTS) {
  const latest = latestFindings(findings);
  const total = checkpoints.reduce((sum, c) => sum + c.points, 0);
  let earned = 0;
  const unchecked: string[] = [], failed: string[] = [], blockers: string[] = [];
  for (const checkpoint of checkpoints) {
    const finding = latest.get(checkpoint.id);
    if (!finding) { unchecked.push(checkpoint.id); continue; }
    earned += checkpoint.points * STATUS_FACTOR[finding.status];
    if (finding.status === "fail") { failed.push(checkpoint.id); if (finding.severity === "blocker") blockers.push(checkpoint.id); }
  }
  const score = Math.round(earned / total * 100);
  const verdict = blockers.length ? "FAIL" : unchecked.length ? "INCOMPLETE" : failed.length || score < 85 ? "NEEDS WORK" : "PASS";
  return { score, earned, total, verdict, unchecked, failed, blockers, checked: checkpoints.length - unchecked.length, of: checkpoints.length };
}

export function checklistText(request: string | undefined, checkpoints = CHECKPOINTS): string {
  const lines = [
    "CLIPQA REVIEW CHECKLIST",
    request ? `User request: "${request}"` : "User request: not provided. Ask for it, or judge pose.request against the conversation.",
    "",
    "Treat every item as a question to answer with evidence. Assume something is broken until you have looked: models and animations very often have twisted joints, wrong proportions or poses that do not match the request.",
    "Severity: blocker = obviously broken, the user would notice immediately; major = clearly wrong on inspection; minor = polish.",
    "",
  ];
  let category = "";
  for (const c of checkpoints) {
    if (c.category !== category) { category = c.category; lines.push(`## ${category}`); }
    lines.push(`- [${c.id}] (${c.points} pts) ${c.title}`, `    Look for: ${c.lookFor.join("; ")}.`, `    How: ${c.verify}`);
  }
  lines.push("", "Workflow:", "1. Read the contact sheet below. Note anything suspicious with its timestamp.", "2. For a character, model or pose: orbit_plan -> run the script while recording -> orbit_sheet to see every angle, including close-ups.", "3. zoom_frame on joints, hands, feet, face and anything suspicious (use showGrid, then pick a cell). Zoom is digital; for real detail add a close-up zoom level to the orbit.", "4. analyze_motion for anything that moves.", "5. record_finding for EVERY checkpoint (pass, fail or unclear) with a specific note. Do not mark pass without having looked.", "6. qa_report for the score and verdict. Report failures to the user honestly; do not round a FAIL up.");
  return lines.join("\n");
}

export async function writeQaReport(session: RecordingSession, directory: string): Promise<{ reportPath: string; jsonPath: string } & ReturnType<typeof scoreFindings>> {
  const summary = scoreFindings(session.findings);
  const latest = latestFindings(session.findings);
  await fs.mkdir(directory, { recursive: true });
  const rows = await Promise.all(CHECKPOINTS.map(async c => {
    const f = latest.get(c.id);
    const evidence = f?.evidencePath ? await fs.readFile(f.evidencePath).then(d => `<img alt="Evidence" src="data:image/jpeg;base64,${d.toString("base64")}">`, () => "") : "";
    const status = f ? f.status.toUpperCase() : "NOT CHECKED";
    const where = [f?.timestampSeconds !== undefined ? `${f.timestampSeconds.toFixed(3)}s` : "", f?.view ?? ""].filter(Boolean).join(" · ");
    return `<tr class="${f?.status ?? "none"}"><td>${escapeXml(c.category)}<br><b>${escapeXml(c.title)}</b><br><code>${c.id}</code></td><td>${status}${f?.severity ? `<br>${f.severity}` : ""}</td><td>${c.points}</td><td>${escapeXml(f?.note ?? "")}${where ? `<br><small>${escapeXml(where)}</small>` : ""}${evidence}</td></tr>`;
  }));
  const json = { schemaVersion: 1, sessionId: session.id, request: session.request, ...summary, findings: session.findings ?? [] };
  const jsonPath = path.join(directory, "qa-report.json"), reportPath = path.join(directory, "qa-report.html");
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
  await fs.writeFile(reportPath, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ClipQA review</title><style>body{font:15px system-ui;background:#0d1117;color:#e6edf3;margin:32px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #30363d;padding:10px;vertical-align:top}tr.fail td:nth-child(2){color:#f87171;font-weight:bold}tr.pass td:nth-child(2){color:#4ade80}tr.unclear td:nth-child(2){color:#fbbf24}tr.none td:nth-child(2){color:#8b949e}img{max-width:420px;display:block;margin-top:8px}code{color:#8b949e}h1 span{font-size:16px;color:#8b949e}</style><h1>${summary.verdict} · ${summary.score}/100 <span>${summary.checked}/${summary.of} checkpoints checked</span></h1>${session.request ? `<p>Request: ${escapeXml(session.request)}</p>` : ""}<table><tr><td>Checkpoint</td><td>Status</td><td>Points</td><td>Notes and evidence</td></tr>${rows.join("")}</table></html>`);
  return { reportPath, jsonPath, ...summary };
}
