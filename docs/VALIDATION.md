# v0.2.0 validation — 2026-09-15

Validated locally on Windows:

| Check | Result |
| --- | --- |
| TypeScript check/build | Passed |
| Automated suite | 39 passed; live capture test skipped by default |
| Bundled FFmpeg compatibility suite | 39 passed |
| New WGC-capable FFmpeg suite | 39 passed |
| Opt-in Windows live test | Passed separately |
| Packaged installation | Installed successfully; STDIO client connected to v0.2.0 with 15 tools |
| Optional Windows FFmpeg installer | Download, SHA-256 verification and managed installation passed |
| Production dependency audit | Zero reported vulnerabilities |

The live fixture emitted an animated rectangle in a nonactivating window. A three-second preview was exported while recording continued. The saved rolling clip was exactly 5.0 seconds, 13,251 bytes, with ten indexed visual changes and one retained event. The older event was excluded and the retained event timestamp was shifted into the saved clip. A subsequent full recording using `gdigrab` also finalized successfully.

The real-video integration fixture contains a small white patch visible for roughly 200 ms. The scene-cut detector selected no changes, while perceptual indexing selected the change interval. Before/after comparison identified the affected sample, identical clips produced zero flagged samples, and an ignore region covering the patch suppressed the difference.

These are implementation/evidence tests, not model diagnosis or fix-accuracy results. Linux and macOS capture were not exercised on native hardware. The CI matrix includes those OS families for software tests; hosted results are separate from these local results.
