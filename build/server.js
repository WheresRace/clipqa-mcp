import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MediaProcessor } from "./media.js";
import { NodeCommandRunner } from "./process-runner.js";
import { Recorder } from "./recorder.js";
import { SessionStore } from "./session-store.js";
import { chooseBoundedInspectionTimestamps } from "./sampling.js";
import { listWindows } from "./windows.js";
const textResult = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const errorResult = (error) => ({
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});
export async function createServer(config) {
    const runner = new NodeCommandRunner();
    const store = new SessionStore(config.dataDir);
    await store.initialize();
    await store.recoverInterrupted();
    const recorder = new Recorder(store, config.ffmpegPath, runner);
    const media = new MediaProcessor(config.ffmpegPath, config.ffprobePath, runner);
    const server = new McpServer({ name: "clipqa-mcp", version: "0.1.3" });
    server.registerTool("list_windows", {
        description: "List visible Windows application windows that can be recorded. Read-only.",
        inputSchema: z.object({}),
    }, async () => {
        try {
            return textResult(await listWindows(runner));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("start_recording", {
        description: "Start quiet background recording of one Windows application window. This does not control input or capture audio.",
        inputSchema: z.object({
            windowTitle: z.string().min(1).optional(),
            hwnd: z.string().regex(/^\d+$/).optional(),
            fps: z.number().int().min(1).max(60).default(30),
            maxSeconds: z.number().int().min(5).max(3600).default(120),
            drawMouse: z.boolean().default(false),
            encoder: z.enum(["auto", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"]).default("auto"),
        }).refine((value) => Boolean(value.windowTitle || value.hwnd), {
            message: "Provide windowTitle or hwnd.",
        }),
    }, async ({ windowTitle, hwnd, fps, maxSeconds, drawMouse, encoder }) => {
        try {
            const target = {
                ...(windowTitle ? { title: windowTitle } : {}),
                ...(hwnd ? { hwnd } : {}),
            };
            const session = await recorder.start({ target, fps, maxSeconds, drawMouse, encoder });
            return textResult({
                ...session,
                note: "Recording runs in a hidden background process and does not control the mouse or keyboard.",
            });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("mark_event", {
        description: "Add a timestamped action, assertion, error, or note to an active QA recording.",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            label: z.string().min(1).max(500),
            kind: z.enum(["action", "assertion", "error", "note"]).default("note"),
            data: z.record(z.string(), z.unknown()).optional(),
        }),
    }, async ({ sessionId, label, kind, data }) => {
        try {
            const session = await store.update(sessionId, (current) => {
                if (current.state !== "recording") {
                    throw new Error(`Cannot mark an event on a ${current.state} session.`);
                }
                const timestampMs = Math.max(0, Date.now() - Date.parse(current.startedAt));
                return {
                    ...current,
                    events: [...current.events, { timestampMs, label, kind, ...(data ? { data } : {}) }],
                };
            });
            return textResult(session.events.at(-1));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("stop_recording", {
        description: "Stop a recording gracefully and finalize the clip.",
        inputSchema: z.object({ sessionId: z.string().uuid() }),
    }, async ({ sessionId }) => {
        try {
            return textResult(await recorder.stop(sessionId));
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("list_sessions", {
        description: "List recorded QA sessions and their status.",
        inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    }, async ({ limit }) => textResult((await store.list()).slice(0, limit)));
    server.registerTool("inspect_clip", {
        description: "Create and return a timestamped contact sheet for a completed recording.",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            startSeconds: z.number().min(0).default(0),
            endSeconds: z.number().positive().optional(),
            samples: z.number().int().min(2).max(24).default(12),
        }),
    }, async ({ sessionId, startSeconds, endSeconds, samples }) => {
        try {
            const session = await store.read(sessionId);
            if (session.state === "recording")
                throw new Error("Stop the recording before inspecting it.");
            const duration = await media.duration(session.videoPath);
            const end = Math.min(endSeconds ?? duration, duration);
            if (startSeconds >= end)
                throw new Error("startSeconds must be before the end of the clip.");
            const visualChanges = await media.detectVisualChanges(session.videoPath);
            const eventTimes = session.events.map((event) => event.timestampMs / 1000);
            const timestamps = chooseBoundedInspectionTimestamps({
                startSeconds,
                endSeconds: end,
                eventTimesSeconds: eventTimes,
                visualChangeTimesSeconds: visualChanges,
            }, samples);
            const outputPath = path.join(store.sessionDir(sessionId), "overview.jpg");
            await media.createContactSheet(session.videoPath, outputPath, timestamps);
            const data = await fs.readFile(outputPath);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            sessionId,
                            duration,
                            timestamps,
                            visualChanges,
                            eventTimes,
                            outputPath,
                        }, null, 2),
                    },
                    { type: "image", data: data.toString("base64"), mimeType: "image/jpeg" },
                ],
            };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    server.registerTool("get_frames", {
        description: "Return full-size frames from exact timestamps in a completed recording.",
        inputSchema: z.object({
            sessionId: z.string().uuid(),
            timestamps: z.array(z.number().min(0)).min(1).max(16),
        }),
    }, async ({ sessionId, timestamps }) => {
        try {
            const session = await store.read(sessionId);
            if (session.state === "recording")
                throw new Error("Stop the recording before extracting frames.");
            const duration = await media.duration(session.videoPath);
            const content = [{ type: "text", text: JSON.stringify({ sessionId, duration, timestamps }, null, 2) }];
            for (const timestamp of timestamps) {
                if (timestamp > duration)
                    throw new Error(`Timestamp ${timestamp}s exceeds clip duration ${duration}s.`);
                const file = path.join(store.sessionDir(sessionId), "frames", `${Math.round(timestamp * 1000)}ms.jpg`);
                await media.extractFrame(session.videoPath, timestamp, file);
                const data = await fs.readFile(file);
                content.push({ type: "text", text: `Frame at ${timestamp.toFixed(3)} seconds` });
                content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
            }
            return { content };
        }
        catch (error) {
            return errorResult(error);
        }
    });
    return server;
}
export async function serve(config) {
    const server = await createServer(config);
    await server.connect(new StdioServerTransport());
}
//# sourceMappingURL=server.js.map