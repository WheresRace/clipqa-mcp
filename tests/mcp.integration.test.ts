import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("MCP integration", () => {
  it("negotiates with a real client and exposes the complete tool surface", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipqa-mcp-client-"));
    temporaryDirectories.push(dataDir);
    const config = { ...resolveConfig(), dataDir };
    const server = await createServer(config);
    const client = new Client({ name: "clipqa-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "get_frames",
        "inspect_clip",
        "list_sessions",
        "list_windows",
        "mark_event",
        "start_recording",
        "stop_recording",
      ]);

      const result = await client.callTool({ name: "list_sessions", arguments: { limit: 5 } });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
