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
            const timeout = setTimeout(() => { child.kill(); reject(new Error(`Command timed out: ${command}`)); }, 120_000);
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-2_000_000)));
            child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2_000_000)));
            child.on("error", error => { clearTimeout(timeout); reject(error); });
            child.on("close", (code) => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }); });
        });
    }
}
export function conciseError(stderr, maxLength = 800) {
    const cleaned = stderr.trim().replace(/\r/g, "");
    return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}
//# sourceMappingURL=process-runner.js.map