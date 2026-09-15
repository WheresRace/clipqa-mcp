# Changelog

All notable changes will be documented here.

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
