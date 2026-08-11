import * as path from "node:path";
import * as vscode from "vscode";
import { changeLineFor } from "./changeLine";
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
    if (entry && issue.chapterId !== undefined) {
      await this.openEntry(issue.chapterId, entry, focusHunkFor(issue, entry));
    } else {
      await this.openWorkingFile(issue, m);
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
    const { right, line } = await (async (): Promise<{
      right: vscode.Uri;
      line: number | undefined;
    }> => {
      if (entry.hunks && entry.status !== "added" && entry.status !== "deleted") {
        // Chapter-scoped view: right side is merge-base content with only this
        // entry's hunks applied, so the diff shows nothing but this chapter.
        const [oldText, newText] = await Promise.all([
          gitShow(this.folderUri.fsPath, m.mergeBase, oldName),
          gitShow(this.folderUri.fsPath, headRef, entry.path),
        ]);
        const patch = applyHunks(oldText, newText, entry.hunks);
        const scoped = patchedUri(ownerId, entry.path);
        this.patchedDocs.set(scoped, patch.text);

        // A hunk from outside this entry misses the map. No line at all then:
        // defaulting to 1 read as if the finding were at the top of the file.
        const focus = focusHunk ?? entry.hunks[0];
        const at = patch.changeLines.get(focus);
        return { right: scoped, line: at === undefined ? undefined : Math.max(0, at - 1) };
      }
      // No scoped diff (whole-file claim, or an added/deleted file), so the right
      // side is the real head file and the focus hunk resolves against it.
      const right =
        entry.status === "deleted" ? gitUri("", entry.path) : gitUri(headRef, entry.path);
      if (!focusHunk || entry.status === "deleted") {
        return { right, line: undefined };
      }
      const at = await changeLineFor(this.folderUri.fsPath, m, entry, focusHunk);
      return { right, line: Math.max(0, at - 1) };
    })();
    const options: vscode.TextDocumentShowOptions =
      line === undefined ? {} : { selection: new vscode.Range(line, 0, line, 0) };
    await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
  }

  /**
   * Orphaned issue: open the plain working file at the issue's line. The line is
   * resolved against the manifest's commits, which is the closest the finding's
   * coordinates can get; the working copy may have moved since either of them.
   */
  private async openWorkingFile(issue: Issue, m: Manifest): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(this.folderUri, issue.path)
      );
      const at = issue.hunk
        ? await changeLineFor(this.folderUri.fsPath, m, issue, issue.hunk)
        : 1;
      const line = Math.max(0, at - 1);
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
 * The hunk to focus when opening an issue. It has to be the entry's own object:
 * the scoped diff's line map is keyed by identity, so an equal-but-separate hunk
 * finds nothing there and the diff opens with no cursor.
 *
 * Exact coordinates first, then the range covering the finding, since a partition
 * rewrite renumbers hunks and merges neighbours while the finding keeps the
 * coordinates it was recorded with. Old side before new, as the CLI's own
 * re-keying does: an edit above a hunk moves its new side only, so matching there
 * can land on a neighbour.
 *
 * A whole-file entry has no ranges to match, and a finding's coordinates are the
 * head file's own in that case.
 */
export function focusHunkFor(issue: Issue, entry: Entry): Hunk | undefined {
  const { hunk } = issue;
  if (!hunk || !entry.hunks) {
    return hunk;
  }
  return (
    entry.hunks.find((h) => sameRange(h, hunk)) ??
    entry.hunks.find((h) => spansOverlap(h.oldStart, h.oldLines, hunk.oldStart, hunk.oldLines)) ??
    entry.hunks.find((h) => spansOverlap(h.newStart, h.newLines, hunk.newStart, hunk.newLines)) ??
    hunk
  );
}

const sameRange = (a: Hunk, b: Hunk): boolean =>
  a.oldStart === b.oldStart &&
  a.oldLines === b.oldLines &&
  a.newStart === b.newStart &&
  a.newLines === b.newLines;

/** Do two spans [start, start+len) overlap? A zero-length span overlaps nothing. */
function spansOverlap(startA: number, lenA: number, startB: number, lenB: number): boolean {
  if (lenA === 0 || lenB === 0) return false;
  return startA < startB + lenB && startB < startA + lenA;
}
