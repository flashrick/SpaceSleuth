# DiskScan MCP

DiskScan MCP is a read-only Model Context Protocol server that helps an AI agent understand where disk space is being used on Linux and Windows. It scans configured directories using filesystem metadata only, returns the largest non-system files and folders, and adds cautious review hints for common caches, generated output, temporary artifacts, logs, installers, and archives.

The server never reads file contents and has no delete or move tool. An agent can use the scan result to prepare a user-facing cleanup list, but the user remains responsible for deciding what to remove.

DiskScan MCP is the public project name. The existing `disk-scan-mcp` npm package and command name are retained so current MCP configurations continue to work.

## Requirements

- Node.js 24 or newer
- npm
- Linux or Windows

Docker, Python, and OS-specific helper utilities are not required. The server runs as a local stdio process launched by an MCP host and reports directories that the current user cannot access as partial-scan errors.

## Install and verify

```text
npm install
npm run verify
```

## Run locally

Pass one or more allowed directories when starting the server. A scan request must stay inside one of these roots.

```powershell
npm run build
node .\dist\index.js C:\Users\Rick\Downloads D:\Projects
```

On Linux, pass POSIX paths to the same command:

```bash
npm run build
node ./dist/index.js /home/alice/Downloads /srv/projects
```

The MCP protocol uses stdout, so server diagnostics are written to stderr.

## MCP configuration

For a Windows MCP host that launches commands through `cmd`, use an entry like this and replace the paths with the directories you want the agent to inspect:

```json
{
  "mcpServers": {
    "disk-scan": {
      "command": "cmd",
      "args": [
        "/c",
        "node",
        "E:\\workspace\\www\\diskScan\\dist\\index.js",
        "C:\\Users\\Rick\\Downloads",
        "D:\\Projects"
      ]
    }
  }
}
```

For a Linux MCP host, use the native `node` command and POSIX paths:

```json
{
  "mcpServers": {
    "disk-scan": {
      "command": "node",
      "args": [
        "/opt/disk-scan-mcp/dist/index.js",
        "/home/alice/Downloads",
        "/srv/projects"
      ]
    }
  }
}
```

Only configure directories the user intentionally wants the agent to inspect. The server does not automatically grant access to an entire machine.

## Tools

### `list_allowed_roots`

Returns the roots configured at process startup. This is useful for an agent to confirm scope before scanning.

### `scan_disk`

Inputs:

- `path` — an allowed directory or disk root.
- `maxDepth` — maximum directory depth, default `12`, maximum `64`.
- `maxEntries` — maximum entries inspected, default `100000`, maximum `2000000`.
- `maxResults` — largest files and folders returned, default `20`, maximum `100`.
- `includeHidden` — include dotfiles on Linux and common Windows metadata files, default `false`.

The response includes:

- scan completeness and stop reason;
- counts and bytes scanned, including intentionally excluded protected-directory counts;
- largest files with size, modification time, and review signals;
- largest folders with observed size, file/directory counts, and a completeness flag;
- cleanup candidates with a priority, confidence, reason, and caution;
- access errors and notes.

Folder rankings can overlap: a project folder and a generated `dist` folder may both appear. A partial scan is explicit in the response and should not be presented as a full-disk conclusion.

### Platform-protected locations

When scanning a Windows drive root, the server never descends into or reports these root-level system locations:

- `Windows`
- `Program Files` and `Program Files (x86)`
- `ProgramData`
- `Recovery`, `Boot`, and `Config.Msi`
- `$Recycle.Bin` and `System Volume Information`

When scanning the Linux filesystem root `/`, the server also excludes these virtual filesystems because they are not ordinary disk data and can change while a scan is running:

- `/dev`
- `/proc`
- `/run`
- `/sys`

The response increments `stats.protectedDirectoriesSkipped` and adds a note when exclusions occur. A direct request to scan one of these locations, or a path inside one, is rejected. Real Linux directories such as `/home`, `/var`, `/srv`, and `/mnt` remain scannable when they are explicitly configured as allowed roots.

## Recommended agent workflow

1. Call `list_allowed_roots` and confirm the user-selected scope.
2. Call `scan_disk` with a bounded result size.
3. Prefer large, high-confidence generated/cache candidates when preparing a cleanup review.
4. Explain why each candidate is likely reclaimable and include the caution from the result.
5. Ask for confirmation before any deletion performed through a separate, explicitly authorized workflow. This server itself cannot delete anything.

## Design notes

- Symlinks and reparse-point-like entries are skipped to avoid escaping the allowed roots and double-counting data.
- Platform-protected system locations are excluded before traversal and are never returned as cleanup candidates.
- File contents are not opened, hashed, or classified by content.
- Scanning is bounded and uses concurrent metadata requests within each directory batch.
- Access failures are reported as partial results instead of stopping the entire scan.
