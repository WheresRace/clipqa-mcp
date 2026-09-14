export type SessionState = "recording" | "stopped" | "failed" | "interrupted";
export interface CaptureTarget {
    title?: string;
    hwnd?: string;
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
}
export interface WindowInfo {
    title: string;
    hwnd: string;
    process: string;
    pid: number;
}
export interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
}
//# sourceMappingURL=types.d.ts.map