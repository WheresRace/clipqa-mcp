export async function capabilities(ffmpeg, runner, platform = process.platform) {
    const [filters, devices] = await Promise.all([
        runner.run(ffmpeg, ["-hide_banner", "-filters"]),
        runner.run(ffmpeg, ["-hide_banner", "-devices"]),
    ]);
    if (filters.code || devices.code)
        throw new Error("Cannot query FFmpeg capabilities. Check CLIPQA_FFMPEG_PATH.");
    const text = [filters.stdout, filters.stderr, devices.stdout, devices.stderr].join("\n");
    const names = platform === "win32" ? ["gfxcapture", "gdigrab"] : platform === "darwin" ? ["avfoundation"] : platform === "linux" ? ["x11grab"] : [];
    const available = names.filter(name => new RegExp(`\\b${name}\\b`).test(text));
    const warnings = [];
    if (platform === "win32" && !available.includes("gfxcapture"))
        warnings.push("This FFmpeg lacks Windows Graphics Capture. Set CLIPQA_FFMPEG_PATH to a build with the gfxcapture filter to enable it.");
    if (platform === "linux")
        warnings.push("X11 requires DISPLAY and x11grab. Native Wayland capture needs a portal backend and is not supported; import a video recorded by a portal-aware recorder instead.");
    if (platform === "darwin")
        warnings.push("macOS records an explicitly selected display, including other visible apps. Screen Recording permission is required. Window-only capture is not provided by AVFoundation.");
    return { platform, available, ...(available[0] ? { recommended: available[0] } : {}), warnings };
}
export function captureInput(backend, target, fps, mouse) {
    switch (backend) {
        case "gfxcapture":
            if (!target.hwnd || !/^[1-9]\d*$/.test(target.hwnd))
                throw new Error("Windows Graphics Capture requires a nonzero HWND.");
            return ["-filter_complex", `gfxcapture=hwnd=${target.hwnd}:capture_cursor=${Number(mouse)}:max_framerate=${fps},hwdownload,format=bgra,fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2[out]`, "-map", "[out]"];
        case "gdigrab":
            if (!target.title && !target.hwnd)
                throw new Error("Provide an exact window title or HWND.");
            return ["-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", String(Number(mouse)), "-thread_queue_size", "64", "-i", target.title ? `title=${target.title}` : `hwnd=${target.hwnd}`];
        case "x11grab":
            if (!target.windowId || !/^(?:0x[\da-fA-F]+|[1-9]\d*)$/.test(target.windowId) || BigInt(target.windowId) === 0n)
                throw new Error("Provide a nonzero X11 windowId from list_windows or xwininfo.");
            if (!target.display || !/^(?:[\w.-]+)?:\d+(?:\.\d+)?$/.test(target.display))
                throw new Error("Provide an X11 display such as :0.0 (or set DISPLAY).");
            return ["-f", "x11grab", "-framerate", String(fps), "-draw_mouse", String(Number(mouse)), "-window_id", target.windowId, "-i", target.display];
        case "avfoundation":
            if (!Number.isInteger(target.screenIndex) || target.screenIndex < 0)
                throw new Error("Provide a screenIndex from list_sources; camera devices are not accepted.");
            return ["-f", "avfoundation", "-framerate", String(fps), "-capture_cursor", String(Number(mouse)), "-capture_mouse_clicks", "0", "-i", `${target.screenIndex}:none`];
    }
}
export async function listScreens(ffmpeg, runner) {
    // AVFoundation exits nonzero after listing. Parse video section only; never expose cameras.
    const result = await runner.run(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    const video = result.stderr.split("AVFoundation audio devices")[0] ?? "";
    return [...video.matchAll(/\[(\d+)\]\s+(Capture screen[^\r\n]*)/g)].map(m => ({ screenIndex: Number(m[1]), name: m[2] }));
}
//# sourceMappingURL=backends.js.map