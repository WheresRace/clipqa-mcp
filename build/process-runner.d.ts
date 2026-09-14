import type { ProcessResult } from "./types.js";
export interface CommandRunner {
    run(command: string, args: string[]): Promise<ProcessResult>;
}
export declare class NodeCommandRunner implements CommandRunner {
    run(command: string, args: string[]): Promise<ProcessResult>;
}
export declare function conciseError(stderr: string, maxLength?: number): string;
//# sourceMappingURL=process-runner.d.ts.map