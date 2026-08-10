import * as vscode from "vscode";
import { changeLineFor } from "./changeLine";
import { Hunk, Manifest } from "./model";
import { Node } from "./tree";

// The extension writes what the user is looking at here; the chapter-review
// skill reads it to resolve "this file/issue" in follow-up questions.
const FOCUS_DIR = "chapter-review";
const FOCUS_PATH = "chapter-review/focus.json";

export interface Focus {
  path?: string;
  line?: number;
  chapterId?: string;
  issueId?: string;
}

/**
 * What a node points at before its line is known. The anchor is a hunk, and a
 * hunk's newStart is the top of its leading context rather than the change, so
 * the line the skill reads back has to be resolved against the file (see
 * resolveFocus).
 */
export interface FocusAnchor {
  path?: string;
  oldPath?: string;
  hunk?: Hunk;
  chapterId?: string;
  issueId?: string;
}

/**
 * Best-effort convenience channel: records the user's current selection to
 * <git-dir>/chapter-review/focus.json so the skill can resolve "this
 * file/change/issue" from the terminal. Write failures are swallowed.
 */
export class FocusStore {
  private readonly focusUri: vscode.Uri;
  private readonly dirUri: vscode.Uri;

  constructor(gitDirUri: vscode.Uri) {
    this.focusUri = vscode.Uri.joinPath(gitDirUri, FOCUS_PATH);
    this.dirUri = vscode.Uri.joinPath(gitDirUri, FOCUS_DIR);
  }

  async write(focus: Focus): Promise<void> {
    const data = Buffer.from(
      JSON.stringify({ ...focus, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
    try {
      await vscode.workspace.fs.writeFile(this.focusUri, data);
    } catch {
      // The chapter-review/ dir may not exist yet; create it and retry once.
      try {
        await vscode.workspace.fs.createDirectory(this.dirUri);
        await vscode.workspace.fs.writeFile(this.focusUri, data);
      } catch {
        /* convenience channel; ignore write failures */
      }
    }
  }
}

/** The anchor a given tree node represents, or undefined if it carries none. */
export function focusForNode(node: Node): FocusAnchor | undefined {
  switch (node.kind) {
    case "file":
      return {
        path: node.entry.path,
        oldPath: node.entry.oldPath,
        hunk: node.entry.hunks?.[0],
        chapterId: node.ownerId !== "unassigned" ? node.ownerId : undefined,
      };
    case "hunk":
      return {
        path: node.entry.path,
        oldPath: node.entry.oldPath,
        hunk: node.hunk,
        chapterId: node.ownerId !== "unassigned" ? node.ownerId : undefined,
      };
    case "issue":
      return {
        path: node.issue.path,
        oldPath: node.issue.oldPath,
        hunk: node.issue.hunk,
        chapterId: node.issue.chapterId,
        issueId: node.issue.id,
      };
    case "chapter":
      return { chapterId: node.chapter.id };
    default:
      return undefined;
  }
}

/**
 * The pointer to write for an anchor: its hunk becomes the line where the change
 * actually lands. The skill quotes this line back as the place a finding is
 * about, so handing it newStart named a context line up to three above the code.
 * Without a manifest to resolve against, the hunk's own start is all there is.
 */
export async function resolveFocus(
  repoRoot: string,
  m: Manifest | undefined,
  anchor: FocusAnchor
): Promise<Focus> {
  const { path, hunk, chapterId, issueId } = anchor;
  const line =
    hunk === undefined || path === undefined
      ? undefined
      : m === undefined
        ? hunk.newStart
        : await changeLineFor(repoRoot, m, { path, oldPath: anchor.oldPath }, hunk);
  return { path, line, chapterId, issueId };
}
