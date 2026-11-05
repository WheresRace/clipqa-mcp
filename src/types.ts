import type { ClipMetrics } from "./metrics.js";

export type SessionState = "recording" | "stopped" | "failed" | "interrupted";

export interface CaptureTarget {
  title?: string;
  hwnd?: string;
  windowId?: string;
  display?: string;
  screenIndex?: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FindingStatus = "pass" | "fail" | "unclear";
export type FindingSeverity = "blocker" | "major" | "minor";

export interface QaFinding {
  checkpoint: string;
  status: FindingStatus;
  /** 0 broken, 1 poor, 2 acceptable, 3 good (meets the standard), 4 excellent. */
  grade?: number;
  severity?: FindingSeverity;
  note: string;
  timestampSeconds?: number;
  view?: string;
  region?: Region;
  evidencePath?: string;
  recordedAt: string;
}

export interface QaEvent {
  timestampMs: number;
  label: string;
  kind: "action" | "assertion" | "error" | "note";
  data?: Record<string, unknown>;
}

export interface RecordingSession {
  id: string;
  state: SessionState;
  target: CaptureTarget;
  startedAt: string;
  stoppedAt?: string;
  fps: number;
  encoder: string;
  drawMouse: boolean;
  maxSeconds: number;
  videoPath: string;
  events: QaEvent[];
  error?: string;
  backend?: string;
  bufferSeconds?: number;
  timelineOffsetSeconds?: number;
  warnings?: string[];
  ownerPid?: number;
  crop?: Region;
  request?: string;
  findings?: QaFinding[];
  profile?: "character" | "ui" | "vfx" | "camera" | "gameplay" | "general";
  requirements?: string[];
  /** Measurements from the last qa_review, used for auto grades and bonus points. */
  qualityMetrics?: ClipMetrics;
  /** Contact sheet from the last qa_review, reused as the roundtable's evidence image. */
  reviewSheet?: string;
  roundtable?: RoundtableRecord;
}

export interface RoundtableRecord {
  key: string;
  state: "running" | "done" | "skipped" | "failed";
  startedAt: string;
  finishedAt?: string;
  reviewers: Array<{ name: string; ok: boolean; tokens?: { input: number; output: number }; seconds?: number; error?: string }>;
  challenges: Array<{ checkpoint: string; issue: string; kind: "missed" | "disputed"; suggestedGrade?: number; timestampSeconds?: number; raisedBy: string[] }>;
  agreement?: number;
  note?: string;
}

export interface WindowInfo {
  title: string;
  hwnd: string;
  process: string;
  pid: number;
  minimized?: boolean;
  windowId?: string;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
