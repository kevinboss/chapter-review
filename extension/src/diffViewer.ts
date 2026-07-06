import * as path from "node:path";
import * as vscode from "vscode";
import { applyHunks } from "./diffScope";
import { gitShow, gitUri, patchedUri, PatchedContentProvider } from "./gitContent";
import { FileEntry, Hunk, Issue, Manifest, UnassignedEntry } from "./model";
import { FileNode, HunkNode, IssueNode } from "./tree";

type Entry = FileEntry | UnassignedEntry;

/**
 * Opens diffs and issue targets in the editor. Everything the openDiff and
 * openIssue commands do to *show* content lives here; progress, focus and
 * manifest persistence stay with their owners.
 */
export class DiffViewer {
  constructor(
    private readonly folderUri: vscode.Uri,
    private readonly patchedDocs: PatchedContentProvider,
    private readonly getManifest: () => Manifest | undefined
  ) {}

  /** Diff for a file or hunk node. */
  openDiff(node: FileNode | HunkNode): Promise<void> {
    const focusHunk = node.kind === "hunk" ? node.hunk : undefined;
    return this.openEntry(node.ownerId, node.entry, focusHunk);
  }

  /**
   * Opens the diff for an issue's owning chapter entry, positioned on the
   * issue's hunk. Falls back to the plain working file for an orphaned issue
   * whose chapter/entry no longer exists.
   */
  async openIssue(node: IssueNode): Promise<void> {
    const m = this.getManifest();
    if (!m) {
      return;
    }
    const { issue } = node;
    const entry = m.chapters
      .find((c) => c.id === issue.chapterId)
      ?.files.find((f) => f.path === issue.path);
    if (entry) {
      await this.openEntry(issue.chapterId!, entry, focusHunkFor(issue, entry));
    } else {
      await this.openWorkingFile(issue);
    }
  }

  /**
   * Diff of an entry: merge base on the left, the head file (or a chapter-scoped
   * patch) on the right, with the cursor placed on the focused hunk.
   */
  private async openEntry(ownerId: string, entry: Entry, focusHunk?: Hunk): Promise<void> {
    const m = this.getManifest();
    if (!m) {
      return;
    }
    const headRef = m.headSha ?? m.head;
    const oldName = entry.oldPath ?? entry.path;
    const title = `${path.posix.basename(entry.path)} (${ownerTitle(m, ownerId)})`;

    const left =
      entry.status === "added" ? gitUri("", entry.path) : gitUri(m.mergeBase, oldName);
    let right: vscode.Uri;
    const options: vscode.TextDocumentShowOptions = {};

    if (entry.hunks && entry.status !== "added" && entry.status !== "deleted") {
      // Chapter-scoped view: right side is merge-base content with only this
      // entry's hunks applied, so the diff shows nothing but this chapter.
      const [oldText, newText] = await Promise.all([
        gitShow(this.folderUri.fsPath, m.mergeBase, oldName),
        gitShow(this.folderUri.fsPath, headRef, entry.path),
      ]);
      const patch = applyHunks(oldText, newText, entry.hunks);
      right = patchedUri(ownerId, entry.path);
      this.patchedDocs.set(right, patch.text);

      const focus = focusHunk ?? entry.hunks[0];
      const line = Math.max(0, (patch.changeLines.get(focus) ?? 1) - 1);
      options.selection = new vscode.Range(line, 0, line, 0);
    } else {
      // No scoped diff (whole-file claim, or an added/deleted file): the right
      // side is the real head file, so a focus hunk's newStart is the real line.
      right = entry.status === "deleted" ? gitUri("", entry.path) : gitUri(headRef, entry.path);
      if (focusHunk && entry.status !== "deleted") {
        const line = Math.max(0, focusHunk.newStart - 1);
        options.selection = new vscode.Range(line, 0, line, 0);
      }
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
  }

  /** Orphaned issue: open the plain working file at the issue's line. */
  private async openWorkingFile(issue: Issue): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(this.folderUri, issue.path)
      );
      const line = Math.max(0, (issue.hunk?.newStart ?? 1) - 1);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
      });
    } catch {
      void vscode.window.showWarningMessage(`Chapter Review: could not open ${issue.path}`);
    }
  }
}

function ownerTitle(m: Manifest, ownerId: string): string {
  if (ownerId === "unassigned") {
    return "Unassigned";
  }
  return m.chapters.find((c) => c.id === ownerId)?.title ?? ownerId;
}

/**
 * The hunk to focus when opening an issue. Prefer the entry's own hunk object so
 * the scoped-diff line lookup matches by identity, but fall back to the issue's
 * own hunk for whole-file entries that enumerate no hunks; otherwise the line
 * would be discarded and the diff would open at line 1.
 */
function focusHunkFor(issue: Issue, entry: Entry): Hunk | undefined {
  if (!issue.hunk) {
    return undefined;
  }
  return (
    entry.hunks?.find(
      (h) =>
        h.oldStart === issue.hunk!.oldStart &&
        h.oldLines === issue.hunk!.oldLines &&
        h.newStart === issue.hunk!.newStart &&
        h.newLines === issue.hunk!.newLines
    ) ?? issue.hunk
  );
}
