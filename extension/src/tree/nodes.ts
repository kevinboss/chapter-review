import type { DigestMap } from "../fingerprint";
import { Chapter, entryKeys, FileEntry, Hunk, Issue, Manifest, UnassignedEntry } from "../model";

export type ViewMode = "tree" | "list";

/**
 * Every node below a round carries the round's number, since a chapter id, a
 * path and a review key all recur from one round to the next.
 */
export interface RoundNode {
  kind: "round";
  round: number;
}
export interface ChapterNode {
  kind: "chapter";
  round: number;
  chapter: Chapter;
}
export interface UnassignedRootNode {
  kind: "unassignedRoot";
  round: number;
}
export interface FolderNode {
  kind: "folder";
  round: number;
  ownerId: string;
  label: string;
  children: (FolderNode | FileNode)[];
}
export interface FileNode {
  kind: "file";
  round: number;
  ownerId: string; // chapter id or "unassigned"; a path may appear under several owners
  entry: FileEntry | UnassignedEntry;
}
export interface HunkNode {
  kind: "hunk";
  round: number;
  ownerId: string;
  entry: FileEntry | UnassignedEntry;
  hunk: Hunk;
  index: number;
}
export interface IssueNode {
  kind: "issue";
  issue: Issue;
}
export interface IssuesRootNode {
  kind: "issuesRoot";
  round: number;
}
export interface StaleWarningNode {
  kind: "staleWarning";
}
export interface DirtyWarningNode {
  kind: "dirtyWarning";
}

export type Node =
  | RoundNode
  | ChapterNode
  | UnassignedRootNode
  | FolderNode
  | FileNode
  | HunkNode
  | IssueNode
  | IssuesRootNode
  | StaleWarningNode
  | DirtyWarningNode;

/** What the tree needs from review progress (ReviewProgress satisfies it). */
export interface ProgressReader {
  /** Reviewed iff the digest recorded for this unit matches its current content. */
  isReviewedAt(key: string, currentDigest: string | undefined): boolean;
}

/** One review round as the tree shows it: its partition, checkmarks and digests. */
export interface RoundView {
  manifest: Manifest;
  progress: ProgressReader;
  /** Undefined while still being computed: the round shows, but not yet what is reviewed. */
  digests: DigestMap | undefined;
}

/** Review keys for every file in a folder subtree (backs the folder checkbox). */
export function folderFileKeys(folder: FolderNode): string[] {
  const keys: string[] = [];
  for (const child of folder.children) {
    keys.push(...(child.kind === "file" ? entryKeys(child.entry) : folderFileKeys(child)));
  }
  return keys;
}
