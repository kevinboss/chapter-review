// TypeScript mirror of .claude/skills/chapter-review/chapters.schema.json (contract version 1).

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
 * Progress lives in the manifest so the CLI can carry it across regeneration
 * and clear it (`uncheck`); the extension writes it as the reviewer ticks boxes.
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
  reviewed?: ReviewedUnit[];
}

export function isOpen(issue: Issue): boolean {
  return issue.status !== "resolved";
}

/**
 * Shape check, not full schema validation (that happens at generation time
 * via the skill's validate.mjs). Enough to fail loudly on wrong versions or
 * truncated files instead of rendering garbage.
 */
export function parseManifest(text: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`chapters.json is not valid JSON: ${(e as Error).message}`);
  }
  const m = data as Partial<Manifest>;
  if (m.version !== 1) {
    throw new Error(`unsupported chapters.json version: ${m.version}`);
  }
  if (!Array.isArray(m.chapters) || !Array.isArray(m.unassigned)) {
    throw new Error("chapters.json: chapters/unassigned must be arrays");
  }
  if (!m.mergeBase || !m.base || !m.head) {
    throw new Error("chapters.json: base, head and mergeBase are required");
  }
  return m as Manifest;
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
