// Shared domain types for the chapter-review manifest and its CLI. This module
// has no runtime code, so an `import type` from it erases completely and the
// file is never loaded at runtime.

export type Severity = "critical" | "high" | "low";
export type IssueStatus = "open" | "resolved";
export type Confidence = "suspected" | "verified";
export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks?: Hunk[];
  note?: string;
  reason?: string;
}

export interface Chapter {
  id: string;
  title: string;
  description?: string;
  files: FileEntry[];
}

export interface Issue {
  id: string;
  path: string;
  oldPath?: string;
  hunk?: Hunk;
  chapterId?: string;
  severity: Severity;
  note: string;
  confidence?: Confidence;
  status?: IssueStatus;
  createdAt?: string;
}

export interface ReviewedUnit {
  path: string;
  hunk?: Hunk;
  digest: string;
}

/**
 * Review checkmarks. A separate document because the extension owns it and the
 * agent owns the manifest: one writer per file means neither can clobber the
 * other's edit, which is what sharing chapters.json used to allow.
 */
export interface Progress {
  version: number;
  reviewed: ReviewedUnit[];
}

export interface Manifest {
  version: number;
  base: string;
  head: string;
  mergeBase: string;
  headSha?: string;
  generatedAt: string;
  summary?: string;
  chapters: Chapter[];
  unassigned: FileEntry[];
  issues?: Issue[];
  /** @deprecated Lives in progress.json now; still read once, to migrate it. */
  reviewed?: ReviewedUnit[];
}

export interface ManifestStats {
  chapters: number;
  files: number;
  hunks: number;
}

export type ValidationResult =
  | { ok: true; errors: string[]; stats: ManifestStats }
  | { ok: false; errors: string[] };
