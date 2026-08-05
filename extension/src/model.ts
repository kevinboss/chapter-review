// TypeScript mirror of .claude/skills/chapter-review/chapters.schema.json (contract version 1).

import { errorMessage } from "./util";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
  /** Absent = the file's entire diff belongs to this entry. */
  hunks?: Hunk[];
  note?: string;
}

export interface UnassignedEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks?: Hunk[];
  reason: string;
}

export interface Chapter {
  id: string;
  title: string;
  description?: string;
  files: FileEntry[];
}

export type IssueSeverity = "critical" | "high" | "low";
export type IssueStatus = "open" | "resolved";
/** Whether the finding's premise has been checked. Omitted defaults to "suspected". */
export type IssueConfidence = "suspected" | "verified";

/** A review finding the skill recorded. Grouped by chapterId, anchored to path(+hunk). */
export interface Issue {
  id: string;
  path: string;
  oldPath?: string;
  hunk?: Hunk;
  chapterId?: string;
  severity: IssueSeverity;
  note: string;
  confidence?: IssueConfidence;
  status?: IssueStatus;
  createdAt?: string;
}

/**
 * A checked-off review unit, with the content digest it was checked against.
 * Lives in progress.json: the CLI carries it across regeneration and clears it
 * (`uncheck`); the extension writes it as the reviewer ticks boxes.
 */
export interface ReviewedUnit {
  path: string;
  hunk?: Hunk;
  digest: string;
}

export interface Manifest {
  version: 1;
  base: string;
  head: string;
  mergeBase: string;
  headSha?: string;
  generatedAt: string;
  summary?: string;
  chapters: Chapter[];
  unassigned: UnassignedEntry[];
  issues?: Issue[];
}

export function isOpen(issue: Issue): boolean {
  return issue.status !== "resolved";
}

/**
 * The number a `ch-N` id carries, undefined if the id is not of that form. Shown
 * on the chapter row so the reviewer can name a chapter to the agent without
 * retyping its title.
 */
export function chapterNumber(id: string): string | undefined {
  const m = /^ch-([0-9]+)$/.exec(id);
  return m ? m[1] : undefined;
}

/**
 * The number part of an `iss-<chapter>.<n>` id, undefined if the id is not of
 * that form. Findings are numbered within their chapter, so this is what reads
 * usefully on the row: "1.2" is the second finding in chapter one, and the
 * `iss-` prefix is the same on every row.
 */
export function issueNumber(id: string): string | undefined {
  const m = /^iss-([0-9]+\.[0-9]+)$/.exec(id);
  return m ? m[1] : undefined;
}

/**
 * Shape check, not full schema validation (that happens at generation time
 * via the skill's validate.ts). Enough to fail loudly on wrong versions or
 * truncated files instead of rendering garbage.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`chapters.json is not valid JSON: ${errorMessage(e)}`, { cause: e });
  }
}

/** Narrowing companion to the checks in parseManifest, so it needs no cast. */
function hasManifestShape(m: Record<string, unknown>): m is Manifest & Record<string, unknown> {
  return (
    m.version === 1 &&
    Array.isArray(m.chapters) &&
    Array.isArray(m.unassigned) &&
    typeof m.mergeBase === "string" &&
    m.mergeBase.length > 0 &&
    typeof m.base === "string" &&
    m.base.length > 0 &&
    typeof m.head === "string" &&
    m.head.length > 0
  );
}

export function parseManifest(text: string): Manifest {
  const parsed = parseJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("chapters.json: must be an object");
  }
  const m: Record<string, unknown> = { ...parsed };
  // Reported individually, since each says something different about the file.
  if (m.version !== 1) {
    throw new Error(`unsupported chapters.json version: ${String(m.version)}`);
  }
  if (!Array.isArray(m.chapters) || !Array.isArray(m.unassigned)) {
    throw new Error("chapters.json: chapters/unassigned must be arrays");
  }
  if (!m.mergeBase || !m.base || !m.head) {
    throw new Error("chapters.json: base, head and mergeBase are required");
  }
  if (!hasManifestShape(m)) {
    throw new Error("chapters.json: base, head and mergeBase must be strings");
  }
  return m;
}

/**
 * Stable identity of a review unit. Derived from content coordinates, not
 * chapter ids, so progress survives regeneration as long as the hunk itself
 * is unchanged.
 */
export function reviewKey(path: string, hunk?: Hunk): string {
  return hunk
    ? `${path}#${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}`
    : `${path}#whole`;
}

/** Review units of an entry: one per hunk, or one for the whole file. */
export function entryKeys(entry: FileEntry | UnassignedEntry): string[] {
  return entry.hunks
    ? entry.hunks.map((h) => reviewKey(entry.path, h))
    : [reviewKey(entry.path)];
}

export function allEntries(m: Manifest): (FileEntry | UnassignedEntry)[] {
  return [...m.chapters.flatMap((c) => c.files), ...m.unassigned];
}
