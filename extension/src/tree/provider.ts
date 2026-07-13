import * as path from "node:path";
import * as vscode from "vscode";
import {
  Chapter,
  entryKeys,
  FileEntry,
  Hunk,
  isOpen,
  Issue,
  Manifest,
  reviewKey,
  UnassignedEntry,
} from "../model";
import { Staleness } from "../staleness";
import { buildFolderTree } from "./folderTree";
import { FileNode, folderFileKeys, HunkNode, IssueNode, Node, ProgressReader, ViewMode } from "./nodes";

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export class ChapterTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Set by the host when the manifest's pinned commit diverges from the branch. */
  staleness: Staleness | undefined;

  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly progress: ProgressReader,
    public manifest: Manifest | undefined,
    public viewMode: ViewMode
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  /**
   * Review-progress keys a node's checkbox stands for. A file/hunk yields its
   * own unit; a chapter, folder or the unassigned root yields every file unit
   * beneath it, so ticking a container completes all its files at once. Empty
   * for nodes tracked elsewhere (issues) or with nothing beneath them.
   */
  reviewKeysFor(node: Node): string[] {
    switch (node.kind) {
      case "file":
        return entryKeys(node.entry);
      case "hunk":
        return [reviewKey(node.entry.path, node.hunk)];
      case "chapter":
        return node.chapter.files.flatMap(entryKeys);
      case "unassignedRoot":
        return (this.manifest?.unassigned ?? []).flatMap(entryKeys);
      case "folder":
        return folderFileKeys(node);
      default:
        return [];
    }
  }

  /** Checkbox state for a node backed by review keys, or none if it has zero. */
  private checkbox(node: Node): vscode.TreeItemCheckboxState | undefined {
    const keys = this.reviewKeysFor(node);
    if (keys.length === 0) {
      return undefined;
    }
    return keys.every((k) => this.progress.isReviewed(k))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  getChildren(node?: Node): Node[] {
    if (!this.manifest) {
      return [];
    }
    if (!node) {
      const roots: Node[] = this.manifest.chapters.map((chapter) => ({
        kind: "chapter",
        chapter,
      }));
      if (this.manifest.unassigned.length > 0) {
        roots.push({ kind: "unassignedRoot" });
      }
      if (this.orphanIssues().length > 0) {
        roots.push({ kind: "issuesRoot" });
      }
      if (this.staleness?.stale) {
        roots.unshift({ kind: "staleWarning" });
      }
      return roots;
    }
    switch (node.kind) {
      case "chapter":
        return [
          ...this.fileChildren(node.chapter.id, node.chapter.files),
          ...this.issuesForChapter(node.chapter.id).map(
            (issue): IssueNode => ({ kind: "issue", issue })
          ),
        ];
      case "unassignedRoot":
        return this.fileChildren("unassigned", this.manifest.unassigned);
      case "issuesRoot":
        return this.orphanIssues().map((issue): IssueNode => ({ kind: "issue", issue }));
      case "folder":
        return node.children;
      case "file": {
        const hunks = node.entry.hunks ?? [];
        if (hunks.length < 2) {
          return []; // single review unit; the file's own checkbox covers it
        }
        return hunks.map((hunk, index) => ({
          kind: "hunk",
          ownerId: node.ownerId,
          entry: node.entry,
          hunk,
          index,
        }));
      }
      case "hunk":
      case "issue":
      case "staleWarning":
        return [];
    }
  }

  private allIssues(): Issue[] {
    return this.manifest?.issues ?? [];
  }

  private issuesForChapter(chapterId: string): Issue[] {
    return this.allIssues().filter((i) => i.chapterId === chapterId);
  }

  private issuesForFile(chapterId: string, filePath: string): Issue[] {
    return this.allIssues().filter(
      (i) => i.chapterId === chapterId && i.path === filePath
    );
  }

  /** Issues whose chapterId is unset or no longer names a chapter. */
  private orphanIssues(): Issue[] {
    const ids = new Set(this.manifest?.chapters.map((c) => c.id));
    return this.allIssues().filter((i) => !i.chapterId || !ids.has(i.chapterId));
  }

  private fileChildren(
    ownerId: string,
    entries: (FileEntry | UnassignedEntry)[]
  ): Node[] {
    const files: FileNode[] = entries.map((entry) => ({
      kind: "file",
      ownerId,
      entry,
    }));
    if (this.viewMode === "list") {
      return files;
    }
    return buildFolderTree(ownerId, files);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "chapter":
        return this.chapterItem(node.chapter);
      case "unassignedRoot":
        return this.unassignedRootItem();
      case "folder": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = vscode.ThemeIcon.Folder;
        item.checkboxState = this.checkbox(node);
        return item;
      }
      case "file":
        return this.fileItem(node);
      case "hunk":
        return this.hunkItem(node);
      case "issue":
        return this.issueItem(node);
      case "issuesRoot":
        return this.issuesRootItem();
      case "staleWarning":
        return this.staleWarningItem();
    }
  }

  private staleWarningItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.staleness?.summary ?? "Review may be out of date",
      vscode.TreeItemCollapsibleState.None
    );
    item.id = "staleWarning";
    item.iconPath = new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("list.warningForeground")
    );
    item.tooltip = this.staleness?.detail;
    item.command = { command: "chapterReview.refresh", title: "Re-check", arguments: [] };
    return item;
  }

  private chapterItem(chapter: Chapter): vscode.TreeItem {
    const item = new vscode.TreeItem(
      chapter.title,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `chapter:${chapter.id}`;
    const { done, total } = this.countUnits(chapter.files);
    const open = this.issuesForChapter(chapter.id).filter(isOpen).length;
    item.description =
      open > 0 ? `${done}/${total} · ${open} issue${open > 1 ? "s" : ""}` : `${done}/${total}`;
    item.iconPath = new vscode.ThemeIcon(
      open > 0 ? "warning" : done === total ? "pass-filled" : "book"
    );
    item.checkboxState = this.checkbox({ kind: "chapter", chapter });
    if (chapter.description) {
      item.tooltip = chapter.description;
    }
    return item;
  }

  private unassignedRootItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      "Unassigned",
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = "unassignedRoot";
    const { done, total } = this.countUnits(this.manifest?.unassigned ?? []);
    item.description = `${done}/${total}`;
    item.iconPath = new vscode.ThemeIcon("archive");
    item.checkboxState = this.checkbox({ kind: "unassignedRoot" });
    item.tooltip = "Noise quarantined by the skill (lockfiles, generated code, autoformat)";
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { entry } = node;
    const item = new vscode.TreeItem(
      path.posix.basename(entry.path),
      (entry.hunks ?? []).length > 1
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = `${node.ownerId}:${entry.path}`;
    item.resourceUri = vscode.Uri.joinPath(this.workspaceRoot, entry.path);

    const parts: string[] = [];
    if (this.viewMode === "list") {
      const dir = path.posix.dirname(entry.path);
      if (dir !== ".") {
        parts.push(dir);
      }
    }
    parts.push(STATUS_LETTER[entry.status] ?? "?");
    if ("reason" in entry) {
      parts.push(`(${entry.reason})`);
    }
    const openIssues =
      node.ownerId !== "unassigned"
        ? this.issuesForFile(node.ownerId, entry.path).filter(isOpen).length
        : 0;
    if (openIssues > 0) {
      parts.push(`${openIssues} issue${openIssues > 1 ? "s" : ""}`);
    }
    item.description = parts.join("  ");

    const note = "note" in entry ? entry.note : undefined;
    if (note || entry.oldPath) {
      item.tooltip = [entry.oldPath && `was ${entry.oldPath}`, note]
        .filter(Boolean)
        .join("\n");
    }

    item.checkboxState = this.checkbox(node);

    item.command = {
      command: "chapterReview.openDiff",
      title: "Open Diff",
      arguments: [node],
    };
    return item;
  }

  private hunkItem(node: HunkNode): vscode.TreeItem {
    const h = node.hunk;
    const item = new vscode.TreeItem(
      hunkLabel(h),
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `${node.ownerId}:${node.entry.path}#${node.index}`;
    item.description = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    item.iconPath = new vscode.ThemeIcon("diff");
    item.checkboxState = this.checkbox(node);
    item.command = {
      command: "chapterReview.openDiff",
      title: "Open Diff",
      arguments: [node],
    };
    return item;
  }

  private issueItem(node: IssueNode): vscode.TreeItem {
    const { issue } = node;
    const item = new vscode.TreeItem(issue.note, vscode.TreeItemCollapsibleState.None);
    item.id = `issue:${issue.id}`;
    const resolved = !isOpen(issue);
    item.description = resolved ? `${issue.severity} · resolved` : issue.severity;
    item.tooltip = `${issue.severity.toUpperCase()}${resolved ? " (resolved)" : ""}: ${issue.note}\n${issue.path}`;
    item.iconPath = issueIcon(issue);
    // Same checkbox affordance as files: ticked means resolved. Its toggle is
    // routed to the manifest (not review progress) by the checkbox handler.
    item.checkboxState = resolved
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: "chapterReview.openIssue",
      title: "Open Issue",
      arguments: [node],
    };
    return item;
  }

  private issuesRootItem(): vscode.TreeItem {
    const item = new vscode.TreeItem("Issues", vscode.TreeItemCollapsibleState.Collapsed);
    item.id = "issuesRoot";
    const open = this.orphanIssues().filter(isOpen).length;
    item.description = `${open} open`;
    item.iconPath = new vscode.ThemeIcon("warning");
    item.tooltip = "Issues not tied to a current chapter";
    return item;
  }

  private countUnits(entries: (FileEntry | UnassignedEntry)[]): {
    done: number;
    total: number;
  } {
    const keys = entries.flatMap(entryKeys);
    return {
      done: keys.filter((k) => this.progress.isReviewed(k)).length,
      total: keys.length,
    };
  }
}

// Every issue node keeps an icon so it reads as an issue at a glance. The
// neutral (i) is the baseline flag; open critical/high swap in a colored
// severity glyph. Resolved state and exact severity live in the checkbox and
// the row description, so resolved issues fall back to (i) rather than a
// redundant checkmark.
function issueIcon(issue: Issue): vscode.ThemeIcon {
  if (issue.status !== "resolved") {
    if (issue.severity === "critical") {
      return new vscode.ThemeIcon("error");
    }
    if (issue.severity === "high") {
      return new vscode.ThemeIcon("warning");
    }
  }
  return new vscode.ThemeIcon("info");
}

function hunkLabel(h: Hunk): string {
  if (h.newLines === 0) {
    return `Deletion at line ${h.newStart}`;
  }
  return h.newLines === 1
    ? `Line ${h.newStart}`
    : `Lines ${h.newStart}-${h.newStart + h.newLines - 1}`;
}
