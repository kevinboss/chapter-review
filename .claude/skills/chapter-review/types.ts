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

/** The change in the diff that left a file outside it wrong. */
export interface Cause {
  path: string;
  hunk?: Hunk;
}

export interface Issue {
  id: string;
  /**
   * The review round whose manifest the anchor is read against: its diff for
   * `hunk` and `chapterId`, its headSha for `line`.
   */
  round: number;
  path: string;
  oldPath?: string;
  hunk?: Hunk;
  /**
   * 1-based line in the file at the round's headSha: the line the finding is
   * about, in the diff or not. A finding on a file the branch does not change
   * always has one.
   */
  line?: number;
  /** For a finding outside the diff: the change responsible, which picks its chapter. */
  cause?: Cause;
  chapterId?: string;
  severity: Severity;
  note: string;
  confidence?: Confidence;
  status?: IssueStatus;
  createdAt?: string;
}

/**
 * Where a line of the old file sits in the new one, and what happened to the
 * line itself: replaced by other lines, or removed with nothing in its place.
 */
export interface MovedLine {
  line: number;
  change?: "edited" | "removed";
}

export interface ReviewedUnit {
  path: string;
  hunk?: Hunk;
  digest: string;
}

/**
 * Review checkmarks. A separate document because the extension owns it and the
 * agent owns the manifest: one writer per file means neither can clobber the
 * other's edit.
 */
export interface Progress {
  version: number;
  reviewed: ReviewedUnit[];
}

export interface Manifest {
  version: number;
  /** 1 for the first review of a branch, one more for each run after the head moved. */
  round: number;
  base: string;
  head: string;
  mergeBase: string;
  /**
   * Left side of the diff this round partitions: mergeBase in round 1, after that
   * the previous round's head, or that head replayed onto a merge base that moved.
   */
  fromSha: string;
  headSha: string;
  /** Files the replay onto a moved merge base conflicted on, diffed from the previous head as it was. */
  replayConflicts?: string[];
  generatedAt: string;
  summary?: string;
  chapters: Chapter[];
  unassigned: FileEntry[];
  issues?: Issue[];
  /**
   * Highest number ever allocated in each chapter's issue sequence, keyed by the
   * chapter number an id carries (`"0"` for findings with no chapter), so a
   * removed finding's id is never reused.
   */
  issueSeq?: Record<string, number>;
}

export interface ManifestStats {
  chapters: number;
  files: number;
  hunks: number;
}

export type ValidationResult =
  | { ok: true; errors: string[]; stats: ManifestStats }
  | { ok: false; errors: string[] };
