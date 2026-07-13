import { Chapter, entryKeys, FileEntry, Hunk, Issue, UnassignedEntry } from "../model";

export type ViewMode = "tree" | "list";

export interface ChapterNode {
  kind: "chapter";
  chapter: Chapter;
}
export interface UnassignedRootNode {
  kind: "unassignedRoot";
}
export interface FolderNode {
  kind: "folder";
  ownerId: string;
  label: string;
  children: (FolderNode | FileNode)[];
}
export interface FileNode {
  kind: "file";
  ownerId: string; // chapter id or "unassigned"; a path may appear under several owners
  entry: FileEntry | UnassignedEntry;
}
export interface HunkNode {
  kind: "hunk";
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
}
export interface StaleWarningNode {
  kind: "staleWarning";
}

export type Node =
  | ChapterNode
  | UnassignedRootNode
  | FolderNode
  | FileNode
  | HunkNode
  | IssueNode
  | IssuesRootNode
  | StaleWarningNode;

/** What the tree needs from review progress (ReviewProgress satisfies it). */
export interface ProgressReader {
  isReviewed(key: string): boolean;
}

/** Review keys for every file in a folder subtree (backs the folder checkbox). */
export function folderFileKeys(folder: FolderNode): string[] {
  const keys: string[] = [];
  for (const child of folder.children) {
    keys.push(...(child.kind === "file" ? entryKeys(child.entry) : folderFileKeys(child)));
  }
  return keys;
}
