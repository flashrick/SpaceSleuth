import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

function pathApiFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparisonPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = pathApiFor(platform).resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathWithin(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = pathApiFor(platform);
  const root = comparisonPath(rootPath, platform);
  const candidate = comparisonPath(candidatePath, platform);
  const relative = pathApi.relative(root, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

export async function resolveAllowedRoots(
  rawRoots: readonly string[],
): Promise<string[]> {
  if (rawRoots.length === 0) {
    throw new Error(
      "No allowed roots were provided. Start the server with one or more directory paths.",
    );
  }

  const uniqueRoots = new Map<string, string>();

  for (const rawRoot of rawRoots) {
    const absoluteRoot = path.resolve(rawRoot);
    const rootInfo = await lstat(absoluteRoot);

    if (!rootInfo.isDirectory()) {
      throw new Error(`Allowed root is not a directory: ${absoluteRoot}`);
    }

    if (rootInfo.isSymbolicLink()) {
      throw new Error(`Allowed root must not be a symbolic link: ${absoluteRoot}`);
    }

    const canonicalRoot = await realpath(absoluteRoot);
    uniqueRoots.set(comparisonPath(canonicalRoot), canonicalRoot);
  }

  return [...uniqueRoots.values()];
}

export async function assertAllowedDirectory(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!requestedPath.trim()) {
    throw new Error("The scan path must not be empty.");
  }

  if (allowedRoots.length === 0) {
    throw new Error("The server has no configured allowed roots.");
  }

  const absolutePath = path.resolve(requestedPath);
  const pathInfo = await lstat(absolutePath);

  if (pathInfo.isSymbolicLink()) {
    throw new Error(`The scan path must not be a symbolic link: ${absolutePath}`);
  }

  if (!pathInfo.isDirectory()) {
    throw new Error(`The scan path is not a directory: ${absolutePath}`);
  }

  const canonicalPath = await realpath(absolutePath);
  const isAllowed = allowedRoots.some((root) =>
    isPathWithin(root, canonicalPath),
  );

  if (!isAllowed) {
    throw new Error(
      `The scan path is outside the configured allowed roots: ${absolutePath}`,
    );
  }

  const canonicalInfo = await stat(canonicalPath);
  if (!canonicalInfo.isDirectory()) {
    throw new Error(`The scan path is not a directory: ${absolutePath}`);
  }

  return canonicalPath;
}
