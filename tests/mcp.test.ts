import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MCP stdio boundary", () => {
  it("exposes the scan tools to an MCP client", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "disk-scan-mcp-protocol-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "large.bin"), "12345678901234567890");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist", "index.js"), root],
      stderr: "pipe",
    });
    const client = new Client({ name: "disk-scan-mcp-test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_allowed_roots", "scan_disk"]),
      );

      const response = await client.callTool({
        name: "scan_disk",
        arguments: { path: root, maxResults: 5 },
      });
      const textBlock = response.content.find((block) => block.type === "text");
      expect(textBlock?.type).toBe("text");

      const result = JSON.parse(textBlock?.text ?? "{}");
      expect(result.complete).toBe(true);
      expect(result.largestFiles[0].path).toBe(path.join(root, "large.bin"));
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });
});
