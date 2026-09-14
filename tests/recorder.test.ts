import { describe, expect, it } from "vitest";
import { buildCaptureArgs, selectEncoder } from "../src/recorder.js";
import type { CommandRunner } from "../src/process-runner.js";

describe("buildCaptureArgs", () => {
  it("captures one HWND without mouse input or audio", () => {
    const args = buildCaptureArgs({ hwnd: "12345" }, "recording.mp4", {
      fps: 30,
      maxSeconds: 120,
      drawMouse: false,
      encoder: "libx264",
    });
    expect(args).toContain("hwnd=12345");
    expect(args).toContain("gdigrab");
    expect(args).toContain("libx264");
    expect(args).not.toContain("dshow");
    expect(args[args.indexOf("-draw_mouse") + 1]).toBe("0");
    expect(args).toContain("pad=ceil(iw/2)*2:ceil(ih/2)*2");
  });

  it("passes a title as one argument even when it contains spaces", () => {
    const args = buildCaptureArgs({ title: "Roblox Studio - My Game" }, "recording.mp4", {
      fps: 15,
      maxSeconds: 60,
      drawMouse: false,
      encoder: "h264_nvenc",
    });
    expect(args).toContain("title=Roblox Studio - My Game");
  });

  it("prefers the title when both title and HWND are available", () => {
    const args = buildCaptureArgs(
      { title: "Roblox", hwnd: "12345" },
      "recording.mp4",
      { fps: 15, maxSeconds: 60, drawMouse: false, encoder: "libx264" },
    );
    expect(args).toContain("title=Roblox");
    expect(args).not.toContain("hwnd=12345");
  });
});

describe("selectEncoder", () => {
  it("prefers hardware encoding", async () => {
    const runner: CommandRunner = {
      run: async () => ({ code: 0, stdout: " V..... h264_qsv", stderr: "" }),
    };
    await expect(selectEncoder("auto", "ffmpeg", runner)).resolves.toBe("h264_qsv");
  });

  it("falls back to libx264", async () => {
    const runner: CommandRunner = {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    await expect(selectEncoder("auto", "ffmpeg", runner)).resolves.toBe("libx264");
  });
});
