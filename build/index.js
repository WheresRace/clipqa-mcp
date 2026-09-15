#!/usr/bin/env node
import { resolveConfig } from "./config.js";
import { serve } from "./server.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv.includes("--setup-wgc")) {
    if (process.platform !== "win32") {
        console.error("Windows Graphics Capture setup is Windows-only.");
        process.exitCode = 1;
    }
    else {
        const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../scripts/install-wgc.ps1", import.meta.url))], { windowsHide: true, stdio: "inherit" });
        child.on("error", error => { console.error(error.message); process.exitCode = 1; });
        child.on("close", code => { process.exitCode = code ?? 1; });
    }
}
else if (process.argv.includes("--help")) {
    console.log("ClipQA MCP — start without arguments for STDIO MCP.\n--setup-wgc  Install WGC-capable FFmpeg on Windows (downloads a verified build).\n--help       Show this help.");
}
else
    serve(resolveConfig()).catch((error) => {
        console.error("clipqa-mcp failed to start:", error);
        process.exitCode = 1;
    });
//# sourceMappingURL=index.js.map