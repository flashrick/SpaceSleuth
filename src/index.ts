import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveAllowedRoots } from "./paths.js";
import { createDiskScanServer } from "./server.js";

function printUsage(): void {
  console.error(
    [
      "Usage: disk-scan-mcp <allowed-root> [additional-allowed-root ...]",
      "",
      "The server exposes read-only disk scanning tools over MCP stdio.",
      "Every scan path must be inside one of the allowed roots.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const allowedRoots = await resolveAllowedRoots(args);
  console.error(`disk-scan-mcp ready; allowed roots: ${allowedRoots.join(", ")}`);
  await serveStdio(() => createDiskScanServer(allowedRoots));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
