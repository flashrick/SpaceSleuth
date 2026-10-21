import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat as lstatAsync,
  opendir as opendirAsync,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { assertAllowedDirectory, isPathWithin } from "./paths.js";
import type {
  CleanupCandidate,
  CleanupCategory,
  CleanupHint,
  FileResult,
  FolderResult,
  ScanError,
  ScanLimits,
  ScanRequest,
  ScanResult,
  ScanStats,
  ScanStopReason,
} from "./types.js";

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxDepth: 12,
  maxEntries: 100_000,
  maxResults: 20,
  includeHidden: false,
};

const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_ENTRIES = 2_000_000;
const MAX_RESULTS = 100;
const STAT_CONCURRENCY = 16;

interface MutableFolder {
  path: string;
  name: string;
  depth: number;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  modifiedAt: string | null;
  complete: boolean;
}

interface ScanFrame {
  folder: MutableFolder;
  ancestors: MutableFolder[];
  incomplete: boolean;
}

interface EntryTask {
  path: string;
  name: string;
}

interface EntryMeta {
  task: EntryTask;
  stats?: Stats;
  error?: unknown;
}

const CACHE_DIRECTORY_NAMES = new Set([
  ".cache",
  ".gradle",
  ".npm",
  ".pnpm-store",
  ".pytest_cache",
  ".turbo",
  ".yarn",
  "__pycache__",
  "node_modules",
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  ".next",
  ".nuxt",
  "build",
  "coverage",
  "dist",
  "out",
  "target",
]);

const TEMPORARY_DIRECTORY_NAMES = new Set([".tmp", "tmp", "temp"]);

const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".bz2",
  ".dmg",
  ".gz",
  ".img",
  ".iso",
  ".pkg",
  ".rar",
  ".tar",
  ".xz",
  ".zip",
]);

const INSTALLER_EXTENSIONS = new Set([".appimage", ".deb", ".exe", ".msi"]);

const TEMPORARY_EXTENSIONS = new Set([".bak", ".old", ".swp", ".temp", ".tmp"]);

const LOG_EXTENSIONS = new Set([".log", ".trace"]);

const PROTECTED_WINDOWS_ROOT_NAMES = new Set([
  "$recycle.bin",
  "boot",
  "config.msi",
  "documents and settings",
  "msocache",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
  "system volume information",
  "windows",
]);

const PROTECTED_LINUX_ROOT_NAMES = new Set([
  "dev",
  "proc",
  "run",
  "sys",
]);

function protectedRootNamesFor(platform: NodeJS.Platform): Set<string> | undefined {
  if (platform === "win32") {
    return PROTECTED_WINDOWS_ROOT_NAMES;
  }

  if (platform === "linux") {
    return PROTECTED_LINUX_ROOT_NAMES;
  }

  return undefined;
}

/**
 * Returns true only for a protected system location rooted directly at the
 * filesystem root. User folders with the same name elsewhere are not treated
 * as protected. The optional platform argument keeps this policy testable on
 * a different host operating system.
 */
export function isProtectedSystemPath(
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const protectedRootNames = protectedRootNamesFor(platform);
  if (!protectedRootNames) {
    return false;
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const absolutePath = pathApi.resolve(candidatePath);
  const filesystemRoot = pathApi.parse(absolutePath).root;
  const relativePath = pathApi.relative(filesystemRoot, absolutePath);
  const firstSegment = relativePath.split(pathApi.sep).find(Boolean);

  return (
    firstSegment !== undefined &&
    protectedRootNames.has(firstSegment.toLowerCase())
  );
}

function normalizeLimits(request: ScanRequest): ScanLimits {
  return {
    maxDepth: request.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth,
    maxEntries: request.maxEntries ?? DEFAULT_SCAN_LIMITS.maxEntries,
    maxResults: request.maxResults ?? DEFAULT_SCAN_LIMITS.maxResults,
    includeHidden: request.includeHidden ?? DEFAULT_SCAN_LIMITS.includeHidden,
  };
}

function validateLimits(limits: ScanLimits): void {
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > MAX_SCAN_DEPTH) {
    throw new Error(`maxDepth must be an integer between 0 and ${MAX_SCAN_DEPTH}.`);
  }

  if (
    !Number.isInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    limits.maxEntries > MAX_SCAN_ENTRIES
  ) {
    throw new Error(
      `maxEntries must be an integer between 1 and ${MAX_SCAN_ENTRIES}.`,
    );
  }

  if (
    !Number.isInteger(limits.maxResults) ||
    limits.maxResults < 1 ||
    limits.maxResults > MAX_RESULTS
  ) {
    throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  const precision = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") || name === "Thumbs.db" || name === "desktop.ini";
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyPath(entryPath: string, entryType: "file" | "folder"): CleanupHint[] {
  const normalizedPath = entryPath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  const baseName = (segments.at(-1) ?? "").toLowerCase();
  const extension = path.extname(baseName).toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());

  if (
    entryType === "folder" &&
    lowerSegments.some((segment) => CACHE_DIRECTORY_NAMES.has(segment))
  ) {
    return [
      {
        category: "cache",
        priority: "high",
        confidence: "high",
        reason:
          "This looks like a generated dependency or application cache and is often rebuildable.",
        caution:
          "Confirm that no running process depends on it and that the project can recreate it.",
      },
    ];
  }

  if (
    entryType === "folder" &&
    lowerSegments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))
  ) {
    return [
      {
        category: "generated_output",
        priority: "high",
        confidence: "high",
        reason:
          "This looks like build or test output that can usually be regenerated from source.",
        caution:
          "Check whether it is being served, packaged, or used by a deployment workflow.",
      },
    ];
  }

  if (
    entryType === "folder" &&
    lowerSegments.some((segment) => TEMPORARY_DIRECTORY_NAMES.has(segment))
  ) {
    return [
      {
        category: "temporary",
        priority: "medium",
        confidence: "medium",
        reason: "This directory name suggests temporary working data.",
        caution: "Verify that an active application is not using it before removal.",
      },
    ];
  }

  if (TEMPORARY_EXTENSIONS.has(extension) || baseName.includes(".tmp")) {
    return [
      {
        category: "temporary",
        priority: "medium",
        confidence: "medium",
        reason: "The filename suggests a backup, swap, or temporary artifact.",
        caution: "Confirm that it is not the only copy of important data.",
      },
    ];
  }

  if (LOG_EXTENSIONS.has(extension) || baseName === "logs") {
    return [
      {
        category: "log",
        priority: "medium",
        confidence: "medium",
        reason: "Logs can often be rotated or removed after retention requirements are checked.",
        caution: "Check retention, audit, and troubleshooting requirements first.",
      },
    ];
  }

  if (ARCHIVE_EXTENSIONS.has(extension) || INSTALLER_EXTENSIONS.has(extension)) {
    return [
      {
        category: "installer_or_archive",
        priority: "low",
        confidence: "medium",
        reason: "This looks like an installer, disk image, or compressed archive that may be redundant.",
        caution: "Verify its provenance and whether it is still needed before deleting it.",
      },
    ];
  }

  return [];
}

function priorityWeight(priority: CleanupHint["priority"]): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function candidateScore(sizeBytes: number, hint: CleanupHint): number {
  const sizeWeight = Math.log10(Math.max(sizeBytes, 1) + 1);
  return Number((priorityWeight(hint.priority) * 100 + sizeWeight).toFixed(3));
}

function createFolder(folderPath: string, depth: number): MutableFolder {
  return {
    path: folderPath,
    name: path.basename(folderPath) || folderPath,
    depth,
    sizeBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    modifiedAt: null,
    complete: false,
  };
}

function toFileResult(file: {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}): FileResult {
  return {
    ...file,
    sizeHuman: formatBytes(file.sizeBytes),
    extension: path.extname(file.name).toLowerCase() || null,
    reviewSignals: classifyPath(file.path, "file"),
  };
}

function toFolderResult(folder: MutableFolder): FolderResult {
  return {
    path: folder.path,
    name: folder.name,
    sizeBytes: folder.sizeBytes,
    sizeHuman: formatBytes(folder.sizeBytes),
    sizeComplete: folder.complete,
    fileCount: folder.fileCount,
    directoryCount: folder.directoryCount,
    modifiedAt: folder.modifiedAt,
    reviewSignals: classifyPath(folder.path, "folder"),
  };
}

function addCandidates(
  candidates: CleanupCandidate[],
  entry: FileResult | FolderResult,
  entryType: CleanupCandidate["entryType"],
): void {
  for (const hint of entry.reviewSignals) {
    candidates.push({
      ...hint,
      path: entry.path,
      name: entry.name,
      entryType,
      sizeBytes: entry.sizeBytes,
      sizeHuman: entry.sizeHuman,
      modifiedAt: "modifiedAt" in entry ? entry.modifiedAt : null,
      score: candidateScore(entry.sizeBytes, hint),
    });
  }
}

function sortBySize<T extends { sizeBytes: number; path: string }>(entries: T[]): T[] {
  return [...entries].sort(
    (left, right) =>
      right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path),
  );
}

export async function scanDisk(
  request: ScanRequest,
  allowedRoots: readonly string[],
): Promise<ScanResult> {
  const limits = normalizeLimits(request);
  validateLimits(limits);

  const scannedPath = await assertAllowedDirectory(request.path, allowedRoots);
  if (isProtectedSystemPath(scannedPath)) {
    throw new Error(
      "The scan path is a protected system location for this platform and is not supported.",
    );
  }

  const startedAt = new Date();
  const rootFolder = createFolder(scannedPath, 0);
  const folderMap = new Map<string, MutableFolder>([[scannedPath, rootFolder]]);
  const stack: ScanFrame[] = [
    { folder: rootFolder, ancestors: [rootFolder], incomplete: false },
  ];
  const files: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    modifiedAt: string;
  }> = [];
  const errors: ScanError[] = [];

  const stats: ScanStats = {
    entriesVisited: 0,
    filesScanned: 0,
    directoriesScanned: 0,
    bytesScanned: 0,
    hiddenEntriesSkipped: 0,
    protectedDirectoriesSkipped: 0,
    symlinksSkipped: 0,
    specialEntriesSkipped: 0,
    errors: 0,
  };

  let stopReason: ScanStopReason = "completed";
  let depthLimitHit = false;

  const markAncestorsIncomplete = (ancestors: MutableFolder[]): void => {
    for (const ancestor of ancestors) {
      ancestor.complete = false;
    }
  };

  const recordError = (entryPath: string, error: unknown): void => {
    errors.push({
      path: entryPath,
      code: errorCode(error),
      message: errorMessage(error),
    });
    stats.errors += 1;
  };

  const processBatch = async (
    frame: ScanFrame,
    batch: EntryTask[],
  ): Promise<void> => {
    const metadata = await Promise.all(
      batch.map(async (task): Promise<EntryMeta> => {
        try {
          return { task, stats: await lstatAsync(task.path) };
        } catch (error) {
          return { task, error };
        }
      }),
    );

    for (const entry of metadata) {
      if (entry.error) {
        recordError(entry.task.path, entry.error);
        frame.incomplete = true;
        markAncestorsIncomplete(frame.ancestors);
        continue;
      }

      const entryStats = entry.stats;
      if (!entryStats) {
        continue;
      }

      if (entryStats.isSymbolicLink()) {
        stats.symlinksSkipped += 1;
        continue;
      }

      if (entryStats.isDirectory()) {
        if (isProtectedSystemPath(entry.task.path)) {
          stats.protectedDirectoriesSkipped += 1;
          continue;
        }

        let canonicalChildPath: string;
        try {
          canonicalChildPath = await realpath(entry.task.path);
        } catch (error) {
          recordError(entry.task.path, error);
          frame.incomplete = true;
          markAncestorsIncomplete(frame.ancestors);
          continue;
        }

        if (!isPathWithin(scannedPath, canonicalChildPath)) {
          stats.symlinksSkipped += 1;
          continue;
        }

        const childDepth = frame.folder.depth + 1;
        const childFolder = createFolder(entry.task.path, childDepth);
        childFolder.modifiedAt = new Date(entryStats.mtimeMs).toISOString();
        folderMap.set(childFolder.path, childFolder);

        for (const ancestor of frame.ancestors) {
          ancestor.directoryCount += 1;
        }

        if (childDepth <= limits.maxDepth) {
          stack.push({
            folder: childFolder,
            ancestors: [...frame.ancestors, childFolder],
            incomplete: false,
          });
        } else {
          depthLimitHit = true;
          frame.incomplete = true;
          childFolder.complete = false;
          markAncestorsIncomplete(frame.ancestors);
        }

        continue;
      }

      if (entryStats.isFile()) {
        const sizeBytes = entryStats.size;
        const modifiedAt = new Date(entryStats.mtimeMs).toISOString();
        files.push({
          path: entry.task.path,
          name: entry.task.name,
          sizeBytes,
          modifiedAt,
        });
        stats.filesScanned += 1;
        stats.bytesScanned += sizeBytes;

        for (const ancestor of frame.ancestors) {
          ancestor.sizeBytes += sizeBytes;
          ancestor.fileCount += 1;
        }

        continue;
      }

      stats.specialEntriesSkipped += 1;
    }
  };

  while (stack.length > 0 && stopReason === "completed") {
    const frame = stack.pop();
    if (!frame) {
      break;
    }

    stats.directoriesScanned += 1;
    let directory;
    try {
      directory = await opendirAsync(frame.folder.path);
    } catch (error) {
      recordError(frame.folder.path, error);
      frame.incomplete = true;
      markAncestorsIncomplete(frame.ancestors);
      continue;
    }

    const batch: EntryTask[] = [];
    let directoryFinished = true;

    try {
      for await (const dirent of directory) {
        if (stats.entriesVisited >= limits.maxEntries) {
          stopReason = "max_entries";
          directoryFinished = false;
          frame.incomplete = true;
          break;
        }

        stats.entriesVisited += 1;

        if (!limits.includeHidden && isHiddenName(dirent.name)) {
          stats.hiddenEntriesSkipped += 1;
          continue;
        }

        batch.push({
          path: path.join(frame.folder.path, dirent.name),
          name: dirent.name,
        });

        if (batch.length >= STAT_CONCURRENCY) {
          await processBatch(frame, batch.splice(0, batch.length));
        }

        if (stopReason !== "completed") {
          directoryFinished = false;
          frame.incomplete = true;
          break;
        }
      }
    } catch (error) {
      recordError(frame.folder.path, error);
      frame.incomplete = true;
      markAncestorsIncomplete(frame.ancestors);
      directoryFinished = false;
    } finally {
      if (batch.length > 0 && stopReason === "completed") {
        await processBatch(frame, batch.splice(0, batch.length));
      }
      await directory.close().catch(() => undefined);
    }

    if (directoryFinished && stopReason === "completed" && !frame.incomplete) {
      frame.folder.complete = true;
    } else {
      frame.folder.complete = false;
      markAncestorsIncomplete(frame.ancestors);
    }
  }

  if (stopReason === "max_entries") {
    for (const pending of stack) {
      pending.folder.complete = false;
      markAncestorsIncomplete(pending.ancestors);
    }
    rootFolder.complete = false;
  } else if (depthLimitHit) {
    stopReason = "max_depth";
  } else if (errors.length > 0) {
    stopReason = errors.every((error) =>
      new Set(["EACCES", "EPERM", "EBUSY"]).has(error.code ?? ""),
    )
      ? "permission_errors"
      : "scan_errors";
  }

  const largestFiles = sortBySize(files)
    .filter((file) => !isProtectedSystemPath(file.path))
    .slice(0, limits.maxResults)
    .map(toFileResult);
  const largestFolders = sortBySize(
    [...folderMap.values()]
      .filter(
        (folder) =>
          folder.path !== scannedPath && !isProtectedSystemPath(folder.path),
      )
      .map(toFolderResult),
  ).slice(0, limits.maxResults);

  const cleanupCandidates: CleanupCandidate[] = [];
  for (const file of largestFiles) {
    addCandidates(cleanupCandidates, file, "file");
  }
  for (const folder of largestFolders) {
    addCandidates(cleanupCandidates, folder, "folder");
  }
  cleanupCandidates.sort(
    (left, right) =>
      right.score - left.score || right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path),
  );

  const completedAt = new Date();
  const complete = stopReason === "completed" && errors.length === 0 && !depthLimitHit;
  const notes = [
    "This is a metadata-only scan: file contents are not read and files are never deleted.",
    "Folder sizes are sums of files observed within the scan limits; nested folders can overlap in the ranking.",
  ];

  if (!complete) {
    notes.push("The result is partial. Increase maxEntries/maxDepth or resolve reported access errors for a fuller view.");
  }

  if (stats.symlinksSkipped > 0) {
    notes.push("Symbolic links were skipped to avoid escaping the configured roots or double-counting data.");
  }

  if (stats.protectedDirectoriesSkipped > 0) {
    notes.push(
      "Protected system directories for this platform were intentionally excluded from traversal, totals, rankings, and cleanup candidates.",
    );
  }

  return {
    scanId: randomUUID(),
    requestedPath: request.path,
    scannedPath,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    complete,
    stopReason,
    limits,
    stats,
    largestFiles,
    largestFolders,
    cleanupCandidates,
    errors: errors.slice(0, 100),
    notes,
  };
}
