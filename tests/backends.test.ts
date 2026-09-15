import { describe, expect, it } from "vitest";
import { capabilities, captureInput, listScreens } from "../src/backends.js";
import { buildCaptureArgs } from "../src/recorder.js";
import type { CommandRunner } from "../src/process-runner.js";

const runner = (text: string): CommandRunner => ({ run: async () => ({ code: 0, stdout: text, stderr: text }) });
describe("capture backends", () => {
  it("prefers WGC only when compiled in", async () => {
    expect((await capabilities("ffmpeg", runner("gfxcapture gdigrab"), "win32")).recommended).toBe("gfxcapture");
    const old = await capabilities("ffmpeg", runner("gdigrab"), "win32");
    expect(old.recommended).toBe("gdigrab"); expect(old.warnings.join()).toContain("lacks");
  });
  it("does not select a backend from another platform", async () => {
    expect((await capabilities("ffmpeg", runner("gdigrab"), "darwin")).available).toEqual([]);
    expect((await capabilities("ffmpeg", runner("x11grab"), "linux")).recommended).toBe("x11grab");
  });
  it("uses WGC window handles without interpolating user titles into filters", () => {
    const args = buildCaptureArgs({ hwnd: "123", title: "hostile:'[];movie=http://x" }, "out.mp4", { backend: "gfxcapture", fps: 15, maxSeconds: 20, drawMouse: false, encoder: "libx264", maxWidth: 640 });
    expect(args.join(" ")).toContain("gfxcapture=hwnd=123:capture_cursor=0");
    expect(args.join(" ")).toContain("scale='min(640,iw)'");
    expect(args.join(" ")).not.toContain("hostile"); expect(args).not.toContain("-vf");
    expect(() => captureInput("gfxcapture", { hwnd: "0" }, 15, false)).toThrow();
  });
  it("rejects root-window capture and invalid X11 targets", () => {
    expect(() => captureInput("x11grab", { windowId: "0x0", display: ":0" }, 15, false)).toThrow();
    expect(() => captureInput("x11grab", { windowId: "0x123", display: "bad" }, 15, false)).toThrow();
    expect(captureInput("x11grab", { windowId: "0x123", display: ":0.0" }, 15, false)).toContain("0x123");
  });
  it("lists only displays in the macOS video section, excluding cameras and audio", async () => {
    const screens = await listScreens("ffmpeg", runner("AVFoundation video devices:\n[AVFoundation] [0] FaceTime Camera\n[AVFoundation] [1] Capture screen 0\nAVFoundation audio devices:\n[AVFoundation] [2] Capture screen fake"));
    expect(screens).toEqual([{ screenIndex: 1, name: "Capture screen 0" }]);
    expect(captureInput("avfoundation", { screenIndex: 1 }, 15, false)).toContain("1:none");
  });
});
