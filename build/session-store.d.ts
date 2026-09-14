import type { RecordingSession } from "./types.js";
export declare class SessionStore {
    readonly rootDir: string;
    constructor(rootDir: string);
    sessionDir(id: string): string;
    manifestPath(id: string): string;
    initialize(): Promise<void>;
    create(session: RecordingSession): Promise<void>;
    read(id: string): Promise<RecordingSession>;
    write(session: RecordingSession): Promise<void>;
    update(id: string, change: (session: RecordingSession) => RecordingSession): Promise<RecordingSession>;
    list(): Promise<RecordingSession[]>;
    recoverInterrupted(): Promise<number>;
}
//# sourceMappingURL=session-store.d.ts.map