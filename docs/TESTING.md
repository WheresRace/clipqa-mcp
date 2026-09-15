# Testing ClipQA

`npm test` runs deterministic tests and real-video integration tests. It does not record the desktop. The live test is skipped unless explicitly enabled.

## Windows live capture

Install WGC-capable FFmpeg, then run:

```powershell
$env:CLIPQA_LIVE_CAPTURE_TEST = '1'
npx vitest run tests/capture.live.test.ts
```

The test creates a dedicated animated WinForms window without activation and places it behind other windows. It exports a live preview while recording continues, saves the last five seconds, verifies event rebasing, closes the fixture and removes temporary artifacts. It does not record existing applications.

Set `CLIPQA_TEST_OUTPUT_DIR` to retain `live-preview.mp4` and `live-preview.jpg` for manual viewing. Only fixture media is exported there.

## What the tests establish

- A small, short visual change is indexed when scene-cut detection returns no candidates.
- Identical clips produce zero flagged comparison samples; a known altered frame is flagged; masking its region suppresses it.
- Rolling disk segments are pruned and saved output has the requested duration.
- A real MCP client imports, annotates, inspects, retrieves frames, compares, returns progress images/video links and deletes artifacts.
- Concurrent event updates are preserved; recovery does not interrupt sessions owned by live processes.
- Platform selection tests are not substitutes for native OS capture testing.

The original timestamp benchmark is synthetic and uses unequal image budgets. It measures evidence coverage only. Use the evaluation protocol for blind model diagnosis tests, including equal-budget baselines.
