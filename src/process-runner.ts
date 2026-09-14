import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

export interface CommandRunner {
  run(command: string, args: string[]): Promise<ProcessResult>;
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: string[]): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}

export function conciseError(stderr: string, maxLength = 800): string {
  const cleaned = stderr.trim().replace(/\r/g, "");
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}
