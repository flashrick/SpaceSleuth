import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { scanDisk } from "./scanner.js";
import type { ScanRequest } from "./types.js";

const scanInputSchema = z.object({
  path: z.string().min(1).describe("Directory or disk root to scan."),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(64)
    .optional()
    .describe("Maximum directory depth. Defaults to 12."),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(2_000_000)
    .optional()
    .describe("Maximum entries to inspect. Defaults to 100000."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of largest files and folders to return. Defaults to 20."),
  includeHidden: z
    .boolean()
    .optional()
    .describe(
      "Include hidden entries such as Linux or Windows dotfiles and common Windows metadata files. Defaults to false.",
    ),
});

function jsonToolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorToolResult(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

export function createDiskScanServer(allowedRoots: readonly string[]): McpServer {
  const server = new McpServer({
    name: "disk-scan-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_allowed_roots",
    {
      title: "List allowed scan roots",
      description:
        "List the directories this server is allowed to inspect. The server is read-only and cannot delete files.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonToolResult({ roots: allowedRoots, readOnly: true }),
  );

  server.registerTool(
    "scan_disk",
    {
      title: "Scan disk usage",
      description:
        "Perform a bounded, metadata-only scan of an allowed directory on Linux or Windows and return the largest non-system files, largest non-system folders, and cautious cleanup review hints. Platform-protected system locations are excluded. File contents are never read and nothing is deleted.",
      inputSchema: scanInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (request: ScanRequest) => {
      try {
        return jsonToolResult(await scanDisk(request, allowedRoots));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  return server;
}
