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
