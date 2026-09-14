# Contributing

Thanks for improving ClipQA MCP.

1. Create a focused branch.
2. Run `npm ci`.
3. Add tests for behavior changes.
4. Run `npm run check`, `npm test`, `npm run benchmark`, and `npm run build`.
5. Open a pull request explaining the QA problem and the resulting behavior.

Capture backends must never control user input or upload recordings without a separate, explicit feature and permission model.
