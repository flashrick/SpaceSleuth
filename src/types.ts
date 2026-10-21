export type ScanStopReason =
  | "completed"
  | "max_entries"
  | "max_depth"
  | "permission_errors"
  | "scan_errors";

export type CleanupCategory =
  | "cache"
  | "generated_output"
  | "temporary"
  | "log"
  | "installer_or_archive";

export type ReviewPriority = "high" | "medium" | "low";
export type ReviewConfidence = "high" | "medium" | "low";

export interface ScanRequest {
  path: string;
  maxDepth?: number;
  maxEntries?: number;
  maxResults?: number;
  includeHidden?: boolean;
}

export interface ScanLimits {
  maxDepth: number;
  maxEntries: number;
  maxResults: number;
  includeHidden: boolean;
}

export interface CleanupHint {
  category: CleanupCategory;
  priority: ReviewPriority;
  confidence: ReviewConfidence;
  reason: string;
  caution: string;
}

export interface FileResult {
  path: string;
  name: string;
  sizeBytes: number;
  sizeHuman: string;
  modifiedAt: string;
  extension: string | null;
  reviewSignals: CleanupHint[];
}

export interface FolderResult {
  path: string;
  name: string;
  sizeBytes: number;
  sizeHuman: string;
  sizeComplete: boolean;
  fileCount: number;
  directoryCount: number;
  modifiedAt: string | null;
  reviewSignals: CleanupHint[];
}

export interface CleanupCandidate extends CleanupHint {
  path: string;
  name: string;
  entryType: "file" | "folder";
  sizeBytes: number;
  sizeHuman: string;
  modifiedAt: string | null;
  score: number;
}

export interface ScanError {
  path: string;
  code: string | null;
  message: string;
}

export interface ScanStats {
  entriesVisited: number;
  filesScanned: number;
  directoriesScanned: number;
  bytesScanned: number;
  hiddenEntriesSkipped: number;
  protectedDirectoriesSkipped: number;
  symlinksSkipped: number;
  specialEntriesSkipped: number;
  errors: number;
}

export interface ScanResult {
  scanId: string;
  requestedPath: string;
  scannedPath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  complete: boolean;
  stopReason: ScanStopReason;
  limits: ScanLimits;
  stats: ScanStats;
  largestFiles: FileResult[];
  largestFolders: FolderResult[];
  cleanupCandidates: CleanupCandidate[];
  errors: ScanError[];
  notes: string[];
}
