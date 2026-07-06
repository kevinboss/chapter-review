import * as vscode from "vscode";
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

/** The focus a given tree node represents, or undefined if it carries none. */
export function focusForNode(node: Node): Focus | undefined {
  switch (node.kind) {
    case "file":
      return {
        path: node.entry.path,
        line: node.entry.hunks?.[0]?.newStart,
        chapterId: node.ownerId !== "unassigned" ? node.ownerId : undefined,
      };
    case "hunk":
      return {
        path: node.entry.path,
        line: node.hunk.newStart,
        chapterId: node.ownerId !== "unassigned" ? node.ownerId : undefined,
      };
    case "issue":
      return {
        path: node.issue.path,
        line: node.issue.hunk?.newStart,
        chapterId: node.issue.chapterId,
        issueId: node.issue.id,
      };
    case "chapter":
      return { chapterId: node.chapter.id };
    default:
      return undefined;
  }
}
