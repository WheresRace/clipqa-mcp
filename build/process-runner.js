import { spawn } from "node:child_process";
export class NodeCommandRunner {
    async run(command, args) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });
    }
}
export function conciseError(stderr, maxLength = 800) {
    const cleaned = stderr.trim().replace(/\r/g, "");
    return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}
//# sourceMappingURL=process-runner.js.map