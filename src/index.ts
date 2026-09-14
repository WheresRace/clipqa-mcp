#!/usr/bin/env node
import { resolveConfig } from "./config.js";
import { serve } from "./server.js";

serve(resolveConfig()).catch((error: unknown) => {
  console.error("clipqa-mcp failed to start:", error);
  process.exitCode = 1;
});
