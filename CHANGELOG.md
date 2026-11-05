# Changelog

All notable changes will be documented here.

## 0.4.0 - 2026-11-05

- See between frames: `inspect_between` shows every frame of a range with repeated frames and jumps flagged (`strip`), moving parts layered earliest to latest (`onion`), or a map of everything that changed in any frame (`changes`).
- Compare by quality: `compare_clips` measures both clips (smoothness, real FPS while moving, frame pacing, easing, jitter while still, sharpness, exposure, flicker, black frames, colour) and reports each as improved, regressed or unchanged. It also compares every aligned frame on a divergence timeline, saves a watchable side-by-side MP4, and lists grade changes when both clips were reviewed. Replies list only the rows that moved.
- `analyze_motion` includes the same quality measurements and settle time after events.
- Graded scoring: checkpoints are graded 0-4 against written standards. A plain pass is grade 3 and keeps full points. Profiles for character, UI, VFX, camera, gameplay and general work; character adds the principles of animation. Measured checkpoints are auto-graded. Up to +10 bonus points for measured smoothness, full frame rate, even pacing, easing, steadiness and excellent grades, plus a letter grade. `qa_review` accepts must-pass `requirements`.
- Roundtable audit: after a complete review, `qa_report` has small models (Claude Haiku and Codex through their local CLIs) audit it for misses and disputed grades. It runs once per distinct review, with no tools, one compact image, a token budget, and timeouts that kill the whole process tree. `roundtable_review` fetches the result; `CLIPQA_ROUNDTABLE=off` disables it.
- Memory: the frame decoder fills one buffer per frame instead of re-concatenating on every chunk, and the image cache is capped. `npm run leak-check` verifies a flat heap and no leftover processes, timers or pipes after shutdown.
- `stop_recording` suggests `qa_review` as the next step. Tests never start real reviewers.

## 0.3.0 - 2026-10-29

- Add a structured QA review: `qa_review` checklist (body proportions, twisted/broken meshes, pose vs request, fluidity, every-angle coverage, materials), `record_finding` with zoomed evidence, and `qa_report` scoring with PASS / NEEDS WORK / FAIL / INCOMPLETE verdicts.
- Add `analyze_motion`: fluidity score with hitches, pops and uneven speed.
- Add 360° inspection: `orbit_plan` (Roblox Luau, Blender Python or generic views, with close-up passes) and `orbit_sheet` (finds each held view from camera cuts).
- Add `zoom_frame` with a labelled grid and cell/range, point+factor or region targets at native resolution.
- Add `wait_until_stable`, `attach_log` / `start_recording.logs`, and `recover_session` for interrupted recordings.
- `compare_clips` now auto-aligns runs by shared events or motion, samples around changes and events, and supports a larger analysis canvas.
- `start_recording` accepts `windowTitleContains`, `crop` and `request`; `inspect_clip`/`get_frames` accept `region`; contact sheets and reports show event labels.
- Fix: event timestamps are measured from the first captured frame, not session creation, so live events line up with the video.
- Faster: batched frame extraction, per-process caching of capture capability and encoder probes, and a precompiled Windows window-list helper.
- `get_frames` validates all timestamps before extracting; the server version is read from package.json.
- Stop committing `build/`. Installing from a GitHub link (`github:WheresRace/clipqa-mcp`) is no longer supported: it reinstalled and recompiled everything on each launch, could loop past client startup timeouts and flood the disk. Use the npm package.
- Remove the `prepare` script so a GitHub install fails fast instead of compiling in a restart loop.
- Stop active recordings and exit cleanly when the MCP client closes stdin or sends SIGINT/SIGTERM/SIGHUP/SIGBREAK.

## 0.2.1 - 2026-09-15

- Publish the public package to the npm registry and use `npx clipqa-mcp` as the primary installation route.
- Protect the GitHub `main` branch from force pushes and deletion.

## 0.2.0 - 2026-09-15

- Add Windows Graphics Capture with capability checks and optional verified FFmpeg setup.
- Add Linux X11 window and macOS display capture backends (native validation pending).
- Add disk-based rolling recording, correctly rebased events, and live preview exports.
- Add progress screenshots, saved video links, explicit deletion and age-based cleanup.
- Add local perceptual indexing, static/black-frame warnings, and cached analysis.
- Add before/after comparisons with ignore regions, difference maps and standalone HTML/JSON reports.
- Add video imports and timestamped application events for general-purpose QA.
- Improve window discovery, first-frame startup checks, shutdown, command timeouts, and concurrent event persistence.
- Replace the README banner with a minimal imagegen asset and document actual platform/QA limits.
- Keep the Roblox Studio plugin deferred.

## 0.1.3 - 2026-09-14

- Keep installation guidance on the verified direct GitHub route until the package is published to the npm registry.
- Report the correct server version during MCP initialization.

## 0.1.2 - 2026-09-14

- Include the compiled server in GitHub checkouts so direct and global GitHub installs do not require TypeScript during installation.

## 0.1.1 - 2026-09-14

- Make direct GitHub installs build the executable automatically.
- Correct the installation and MCP client examples for the GitHub release.

## 0.1.0 - 2026-09-14

- Initial Windows-first MCP server.
- Background capture of one application window.
- Timestamped QA events, contact sheets, and exact-frame retrieval.
- Hardware encoder selection with CPU fallback.
- Temporal evidence coverage benchmark and automated test suite.
