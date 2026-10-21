import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProtectedSystemPath, scanDisk } from "../src/scanner.js";
import { isPathWithin } from "../src/paths.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "disk-scan-mcp-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "project", "node_modules"), { recursive: true });
  await mkdir(path.join(root, "project", "dist"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await writeFile(path.join(root, "small.txt"), "small");
  await writeFile(path.join(root, "project", "node_modules", "cache.bin"), "1234567890");
  await writeFile(path.join(root, "project", "dist", "bundle.js"), "12345678901234567890");
  await writeFile(path.join(root, ".hidden", "secret.bin"), "123456789012345678901234567890");
  return root;
}

describe("scanDisk", () => {
  it("protects platform system roots without hiding similarly named user folders", () => {
    expect(isProtectedSystemPath("C:\\Windows", "win32")).toBe(true);
    expect(isProtectedSystemPath("C:\\Program Files", "win32")).toBe(true);
    expect(isProtectedSystemPath("C:\\Users\\Rick\\Windows", "win32")).toBe(false);

    expect(isProtectedSystemPath("/proc", "linux")).toBe(true);
    expect(isProtectedSystemPath("/sys", "linux")).toBe(true);
    expect(isProtectedSystemPath("/home/rick/proc", "linux")).toBe(false);
    expect(isProtectedSystemPath("/var", "linux")).toBe(false);
  });

  it("rejects a direct scan of a protected Windows system location", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const driveRoot = path.parse(process.env.SystemRoot ?? process.cwd()).root;
    await expect(
      scanDisk({ path: path.join(driveRoot, "Windows") }, [driveRoot]),
    ).rejects.toThrow(/protected system location/);
  });

  it("rejects a direct scan of a protected Linux virtual filesystem", async () => {
    if (process.platform !== "linux") {
      return;
    }

    await expect(
      scanDisk({ path: "/proc" }, ["/"]),
    ).rejects.toThrow(/protected system location/);
  });

  it("uses platform-native path boundaries for Linux and Windows", () => {
    expect(isPathWithin("/home/rick", "/home/rick/projects", "linux")).toBe(true);
    expect(isPathWithin("/home/rick", "/home/ricky", "linux")).toBe(false);
    expect(isPathWithin("C:\\Users\\Rick", "C:\\Users\\Rick\\Projects", "win32")).toBe(true);
    expect(isPathWithin("C:\\Users\\Rick", "C:\\Users\\Ricky", "win32")).toBe(false);
  });

  it("returns largest files, folders, and review signals without reading outside the root", async () => {
    const root = await createFixture();
    const result = await scanDisk(
      { path: root, maxDepth: 5, maxEntries: 100, maxResults: 10 },
      [root],
    );

    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.largestFiles[0]?.path).toBe(
      path.join(root, "project", "dist", "bundle.js"),
    );
    expect(result.largestFiles.some((file) => file.path.includes(".hidden"))).toBe(false);

    const nodeModules = result.largestFolders.find((folder) => folder.name === "node_modules");
    expect(nodeModules?.sizeBytes).toBe(10);
    expect(nodeModules?.reviewSignals[0]?.category).toBe("cache");
    expect(result.cleanupCandidates.some((candidate) => candidate.category === "generated_output")).toBe(true);
  });

  it("enforces the configured allowed roots", async () => {
    const root = await createFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "disk-scan-mcp-outside-"));
    temporaryRoots.push(outside);

    await expect(scanDisk({ path: outside }, [root])).rejects.toThrow(
      /outside the configured allowed roots/,
    );
  });

  it("reports a bounded scan as partial instead of running without a limit", async () => {
    const root = await createFixture();
    const result = await scanDisk(
      { path: root, maxDepth: 5, maxEntries: 2, maxResults: 10 },
      [root],
    );

    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("max_entries");
    expect(result.stats.entriesVisited).toBe(2);
  });

  it("marks folder totals incomplete when the depth limit prevents descent", async () => {
    const root = await createFixture();
    const result = await scanDisk(
      { path: root, maxDepth: 0, maxEntries: 100, maxResults: 10 },
      [root],
    );

    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("max_depth");
    expect(result.largestFolders.find((folder) => folder.name === "project")?.sizeComplete).toBe(false);
  });
});
