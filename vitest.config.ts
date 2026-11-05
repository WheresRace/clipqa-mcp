import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Never spend real reviewer tokens in tests; roundtable tests inject fake reviewers.
    env: { CLIPQA_ROUNDTABLE: "off" },
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
