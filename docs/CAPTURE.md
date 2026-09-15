# Capture setup

| Platform | Backend | Scope | Validation |
| --- | --- | --- | --- |
| Windows | `gfxcapture` | Selected HWND | Live animated fixture |
| Windows | `gdigrab` | Selected window title | Existing recorder tests; compatibility fallback |
| Linux X11 | `x11grab` | Selected X11 window | Argument/parser tests; native capture unverified |
| macOS | `avfoundation` | Selected display | Device filtering/argument tests; native capture unverified |
| Wayland | — | Import an existing recording | Native portal capture not implemented |

`capture_status` queries the installed FFmpeg's filters/devices. Compiled support alone does not establish that OS permissions or hardware are ready; startup also waits for frames.

## Windows

Run `npx -y github:WheresRace/clipqa-mcp --setup-wgc` for optional installation. This downloads a release essentials archive from [Gyan's builds](https://www.gyan.dev/ffmpeg/builds/), a provider linked on the [FFmpeg download page](https://www.ffmpeg.org/download.html). It verifies the published SHA-256 and installs executables and accompanying notices into `~/.clipqa/bin`, without administrator rights or PATH changes.

Environment overrides `CLIPQA_FFMPEG_PATH` and `CLIPQA_FFPROBE_PATH` take precedence over managed binaries and package dependencies. Restart the MCP client after setup.

Discovery includes visible top-level and secondary windows, with a `minimized` flag. Use HWND to disambiguate titles. WGC uses the HWND directly; the legacy backend resolves HWND to title for older FFmpeg compatibility.

The implementation uses the documented [`gfxcapture` filter](https://www.ffmpeg.org/ffmpeg-filters.html#gfxcapture). It downloads frames from GPU memory for encoder portability and applies stable output FPS. This transfer has a resource cost. Operating systems ultimately control capture indicators.

## Linux X11

Use FFmpeg with `x11grab`. Install `wmctrl` for discovery, or obtain the window ID with `xwininfo`. Example tool arguments:

```json
{"backend":"x11grab","windowId":"0x03a00007","display":":0.0","fps":15,"maxSeconds":60}
```

The display defaults to `DISPLAY` when set. Root-window ID zero is rejected to avoid accidental full-desktop capture. X11 captures visible pixels; occlusion and minimization can affect output. Wayland requires a separate portal backend; XWayland alone does not guarantee desktop capture.

## macOS

Use FFmpeg with `avfoundation`. Grant Screen Recording permission to the application hosting the recorder, then restart if requested by the OS. `list_sources` returns only **Capture screen** entries from the video-device list; cameras and microphones are excluded.

```json
{"backend":"avfoundation","screenIndex":1,"fps":15,"maxSeconds":60}
```

Obtain the actual index from `list_sources`. This records a display, not a single application, so other visible content can appear. Permission prompts and system indicators cannot be promised away. Apple Silicon systems may require native FFmpeg/FFprobe overrides when package binaries are incompatible.

Device behavior follows [FFmpeg's device documentation](https://www.ffmpeg.org/ffmpeg-devices.html). Native Linux and macOS capture must still be validated before those backends are treated as production-tested.
