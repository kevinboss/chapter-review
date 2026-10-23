import * as path from "node:path";
import * as vscode from "vscode";
import { DigestMap } from "../fingerprint";
import { chapterTooltip, fileTooltip, issueTooltip, textTooltip } from "../tooltips";
import {
  allEntries,
  Chapter,
  chapterNumber,
  entryKeys,
  FileEntry,
  Hunk,
  isOpen,
  Issue,
  issueNumber,
  isOutsideDiff,
  Manifest,
  reviewKey,
  UnassignedEntry,
} from "../model";
import { ReviewUnit } from "../progress";
import { Staleness } from "../staleness";
import { buildFolderTree } from "./folderTree";
import { FileNode, folderFileKeys, HunkNode, IssueNode, Node, RoundView, ViewMode } from "./nodes";

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

  /** Every round of the review, oldest first; the last one is the current round. */
  rounds: RoundView[] = [];

  /**
   * Set by the host once digests have been pending for a moment. Rows whose
   * counts are still unknown spin only then, so a load that finishes quickly
   * never flashes a spinner.
   */
  showLoading = false;

  constructor(
    private readonly workspaceRoot: vscode.Uri,
    public viewMode: ViewMode
  ) {}

  /** The current round's manifest, which also holds every round's findings. */
  get manifest(): Manifest | undefined {
    return this.rounds.at(-1)?.manifest;
  }

  roundView(round: number): RoundView | undefined {
    return this.rounds.find((r) => r.manifest.round === round);
  }

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
        return (this.roundView(node.round)?.manifest.unassigned ?? []).flatMap(entryKeys);
      case "folder":
        return folderFileKeys(node);
      default:
        return [];
    }
  }

  /** The round a node's checkmarks belong to; undefined for a node holding none. */
  roundOf(node: Node): number | undefined {
    return "round" in node ? node.round : undefined;
  }

  /** Each review key a node covers, paired with its unit's current digest. */
  reviewUnitsFor(node: Node): ReviewUnit[] {
    const digests = this.digestsOf(this.roundOf(node));
    return this.reviewKeysFor(node).map((key) => ({ key, digest: digests.get(key)?.unit }));
  }

  private digestsOf(round: number | undefined): DigestMap {
    const none: DigestMap = new Map();
    return (round === undefined ? undefined : this.roundView(round)?.digests) ?? none;
  }

  /**
   * Whether one review unit of a round reads as reviewed. An exact-match test: a
   * mark recorded at another granularity is reconciled by adoptWholeFileMarks.
   */
  private isReviewed(round: number, key: string): boolean {
    const view = this.roundView(round);
    return view?.progress.isReviewedAt(key, view.digests?.get(key)?.unit) === true;
  }

  /**
   * Checkbox state for a node backed by review keys, or none if it has zero or
   * its round's digests are still being computed: a tick then would carry no
   * digest, which setReviewed records as an untick.
   */
  private checkbox(node: Node): vscode.TreeItemCheckboxState | undefined {
    const keys = this.reviewKeysFor(node);
    const round = this.roundOf(node);
    if (keys.length === 0 || round === undefined || !this.roundView(round)?.digests) {
      return undefined;
    }
    return keys.every((k) => this.isReviewed(round, k))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  getChildren(node?: Node): Node[] {
    const current = this.manifest;
    if (!current) {
      return [];
    }
    if (!node) {
      // One round needs no drawer: the tree reads as it always has.
      const roots: Node[] =
        this.rounds.length > 1
          ? [...this.rounds].reverse().map((r): Node => ({ kind: "round", round: r.manifest.round }))
          : this.roundChildren(current);
      // Dirty second so it sits below the staler warning when both apply.
      if (this.staleness?.dirty) {
        roots.unshift({ kind: "dirtyWarning" });
      }
      if (this.staleness?.stale) {
        roots.unshift({ kind: "staleWarning" });
      }
      return roots;
    }
    switch (node.kind) {
      case "round": {
        const view = this.roundView(node.round);
        return view ? this.roundChildren(view.manifest) : [];
      }
      case "chapter":
        return [
          ...this.fileChildren(node.round, node.chapter.id, node.chapter.files),
          ...this.issuesForChapter(node.round, node.chapter.id).map(
            (issue): IssueNode => ({ kind: "issue", issue })
          ),
        ];
      case "unassignedRoot":
        return this.fileChildren(
          node.round,
          "unassigned",
          this.roundView(node.round)?.manifest.unassigned ?? []
        );
      case "issuesRoot":
        return this.orphanIssues(node.round).map((issue): IssueNode => ({ kind: "issue", issue }));
      case "folder":
        return node.children;
      case "file": {
        const hunks = node.entry.hunks ?? [];
        if (hunks.length < 2) {
          return []; // single review unit; the file's own checkbox covers it
        }
        return hunks.map((hunk, index) => ({
          kind: "hunk",
          round: node.round,
          ownerId: node.ownerId,
          entry: node.entry,
          hunk,
          index,
        }));
      }
      case "hunk":
      case "issue":
      case "staleWarning":
      case "dirtyWarning":
        return [];
    }
  }

  /** A round's chapters, then its quarantined files and its findings no chapter owns. */
  private roundChildren(m: Manifest): Node[] {
    const nodes: Node[] = m.chapters.map((chapter) => ({ kind: "chapter", round: m.round, chapter }));
    if (m.unassigned.length > 0) {
      nodes.push({ kind: "unassignedRoot", round: m.round });
    }
    if (this.orphanIssues(m.round).length > 0) {
      nodes.push({ kind: "issuesRoot", round: m.round });
    }
    return nodes;
  }

  private allIssues(): Issue[] {
    return this.manifest?.issues ?? [];
  }

  private issuesForChapter(round: number, chapterId: string): Issue[] {
    return this.allIssues()
      .filter((i) => i.round === round && i.chapterId === chapterId)
      .sort(byIssueNumber);
  }

  private issuesForFile(round: number, chapterId: string, filePath: string): Issue[] {
    return this.allIssues().filter(
      (i) => i.round === round && i.chapterId === chapterId && i.path === filePath
    );
  }

  /** A round's issues whose chapterId is unset or names no chapter of that round. */
  private orphanIssues(round: number): Issue[] {
    const ids = new Set(this.roundView(round)?.manifest.chapters.map((c) => c.id));
    return this.allIssues()
      .filter((i) => i.round === round && (!i.chapterId || !ids.has(i.chapterId)))
      .sort(byIssueNumber);
  }

  private fileChildren(
    round: number,
    ownerId: string,
    entries: (FileEntry | UnassignedEntry)[]
  ): Node[] {
    const files: FileNode[] = entries.map((entry) => ({
      kind: "file",
      round,
      ownerId,
      entry,
    }));
    if (this.viewMode === "list") {
      return files;
    }
    return buildFolderTree(round, ownerId, files);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "round":
        return this.roundItem(node.round);
      case "chapter":
        return this.chapterItem(node.round, node.chapter);
      case "unassignedRoot":
        return this.unassignedRootItem(node.round);
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
        return this.issuesRootItem(node.round);
      case "staleWarning":
        return this.staleWarningItem();
      case "dirtyWarning":
        return this.dirtyWarningItem();
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
    item.tooltip = this.staleness?.detail && textTooltip(this.staleness.detail);
    item.command = { command: "chapterReview.refresh", title: "Re-check", arguments: [] };
    return item;
  }

  private dirtyWarningItem(): vscode.TreeItem {
    const n = this.staleness?.dirty ?? 0;
    const item = new vscode.TreeItem(
      `${n} file${n === 1 ? "" : "s"} with uncommitted changes`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = "dirtyWarning";
    item.iconPath = new vscode.ThemeIcon("pencil", new vscode.ThemeColor("list.warningForeground"));
    item.tooltip = textTooltip(
      "The diff shown here is from the last commit, so it does not include your " +
        "uncommitted edits. Commit them and re-run the chapter-review skill to review them."
    );
    item.command = { command: "chapterReview.refresh", title: "Re-check", arguments: [] };
    return item;
  }

  /**
   * A round's drawer. The current round opens expanded and earlier ones closed;
   * the id says which it is, so a round that stops being current comes back
   * closed rather than as it was last left.
   */
  private roundItem(round: number): vscode.TreeItem {
    const m = this.roundView(round)?.manifest;
    const current = round === this.manifest?.round;
    const item = new vscode.TreeItem(
      `Round ${String(round)}`,
      current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `round:${String(round)}:${current ? "current" : "earlier"}`;
    if (!m) {
      return item;
    }
    const units = this.countUnits(round, allEntries(m));
    const day = new Date(m.generatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    item.description = `${day} · ${short(m.fromSha)} → ${short(m.headSha)} · ${fraction(units)}`;
    item.iconPath = new vscode.ThemeIcon(
      this.spins(units) ? LOADING : current ? "git-commit" : "history"
    );
    item.tooltip = textTooltip(
      round === 1
        ? "The whole branch as first reviewed, from the merge base to its head then."
        : `What changed since round ${String(round - 1)}: from that round's head` +
            (m.fromSha === this.roundView(round - 1)?.manifest.headSha
              ? ""
              : ", replayed onto the base the branch moved to,") +
            ` to ${short(m.headSha)}.` +
            (m.replayConflicts?.length
              ? ` These files did not replay cleanly, so their diff also shows the base's changes: ${m.replayConflicts.join(", ")}.`
              : "")
    );
    return item;
  }

  private chapterItem(round: number, chapter: Chapter): vscode.TreeItem {
    // Numbered on the row so the reviewer can say "chapter 2" to the agent and
    // mean the same chapter the agent calls ch-2. Findings carry the number too,
    // which is how a chapter and its findings read as one sequence.
    const number = chapterNumber(chapter.id);
    const item = new vscode.TreeItem(
      number === undefined ? chapter.title : `${number} · ${chapter.title}`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `r${String(round)}/chapter:${chapter.id}`;
    const units = this.countUnits(round, chapter.files);
    const { done, total } = units;
    const open = this.issuesForChapter(round, chapter.id).filter(isOpen).length;
    item.description =
      open > 0 ? `${fraction(units)} · ${open} issue${open > 1 ? "s" : ""}` : fraction(units);
    item.iconPath = new vscode.ThemeIcon(
      this.spins(units) ? LOADING : open > 0 ? "warning" : done === total ? "pass-filled" : "book"
    );
    item.checkboxState = this.checkbox({ kind: "chapter", round, chapter });
    // The full id leads the tooltip: the row shows the bare number, and this is
    // where the spelling the CLI takes (`--chapter ch-2`) is available.
    item.tooltip = chapterTooltip(chapter.id, chapter.description);
    return item;
  }

  private unassignedRootItem(round: number): vscode.TreeItem {
    const item = new vscode.TreeItem(
      "Unassigned",
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `r${String(round)}/unassignedRoot`;
    const units = this.countUnits(round, this.roundView(round)?.manifest.unassigned ?? []);
    item.description = fraction(units);
    item.iconPath = new vscode.ThemeIcon(this.spins(units) ? LOADING : "archive");
    item.checkboxState = this.checkbox({ kind: "unassignedRoot", round });
    item.tooltip = textTooltip(
      "Noise quarantined by the skill (lockfiles, generated code, autoformat)"
    );
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
    item.id = `r${String(node.round)}/${node.ownerId}:${entry.path}`;
    item.resourceUri = vscode.Uri.joinPath(this.workspaceRoot, entry.path);
    // A later round's diff is only what changed since the round before; the menu
    // offers the whole branch's change to the file next to it.
    if (node.round > 1) {
      item.contextValue = "laterRoundFile";
    }

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
        ? this.issuesForFile(node.round, node.ownerId, entry.path).filter(isOpen).length
        : 0;
    if (openIssues > 0) {
      parts.push(`${openIssues} issue${openIssues > 1 ? "s" : ""}`);
    }
    if (this.roundView(node.round)?.manifest.replayConflicts?.includes(entry.path)) {
      parts.push("with base changes");
    }
    item.description = parts.join("  ");

    const note = "note" in entry ? entry.note : undefined;
    if (note || entry.oldPath) {
      item.tooltip = fileTooltip(entry.oldPath, note);
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
    item.id = `r${String(node.round)}/${node.ownerId}:${node.entry.path}#${String(node.index)}`;
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
    // "1.2 · note": the number is what the reviewer quotes back to the agent, and
    // it reads as chapter one's second finding because the id is numbered there.
    const number = issueNumber(issue.id);
    const item = new vscode.TreeItem(
      number === undefined ? issue.note : `${number} · ${issue.note}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `issue:${issue.id}`;
    const resolved = !isOpen(issue);
    const confidence = issue.confidence === "verified" ? "verified" : "suspected";
    const parts: string[] = [issue.severity, confidence];
    const own = this.roundView(issue.round)?.manifest;
    const outside = own !== undefined && isOutsideDiff(own, issue);
    if (outside) parts.push("outside the diff");
    if (resolved) parts.push("resolved");
    item.description = parts.join(" · ");
    item.tooltip = issueTooltip(issue, outside);
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

  private issuesRootItem(round: number): vscode.TreeItem {
    // Unnumbered, unlike a chapter row: a chapter's number is a handle (`ch-2`,
    // `--chapter ch-2`), and there is no ch-0 for this row's number to name. The
    // findings under it still read 0.1, 0.2, and those ids do resolve.
    const item = new vscode.TreeItem("Issues", vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `r${String(round)}/issuesRoot`;
    const open = this.orphanIssues(round).filter(isOpen).length;
    item.description = `${open} open`;
    item.iconPath = new vscode.ThemeIcon("warning");
    item.tooltip = textTooltip(
      "Findings no chapter owns: on a quarantined path, or in a chapter this " +
        "generation dropped. Numbered in the chapter-0 sequence (iss-0.N)."
    );
    return item;
  }

  /** Reviewed/total review units of the current round (backs the view header). */
  progressSummary(): UnitCount {
    const m = this.manifest;
    return m ? this.countUnits(m.round, allEntries(m)) : { done: 0, total: 0 };
  }

  private spins(units: UnitCount): boolean {
    return this.showLoading && units.done === undefined;
  }

  private countUnits(round: number, entries: (FileEntry | UnassignedEntry)[]): UnitCount {
    const keys = entries.flatMap(entryKeys);
    return {
      done: this.roundView(round)?.digests
        ? keys.filter((k) => this.isReviewed(round, k)).length
        : undefined,
      total: keys.length,
    };
  }
}

/** Review units under a node; `done` is undefined while its round's digests are computed. */
interface UnitCount {
  done: number | undefined;
  total: number;
}

const fraction = ({ done, total }: UnitCount): string => `${done ?? "…"}/${total}`;

/** The icon a row with a count wears while its round's digests are slow to come. */
const LOADING = "loading~spin";

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Findings in numeric order rather than the order they were recorded. A finding
 * a regeneration re-homed keeps its place in the manifest array but takes the
 * next number in its new chapter, so the array order can read 2.3, 2.1, 2.2.
 */
function byIssueNumber(a: Issue, b: Issue): number {
  const parts = (id: string): number[] => (issueNumber(id) ?? "0.0").split(".").map(Number);
  const [chapterA, numberA] = parts(a.id);
  const [chapterB, numberB] = parts(b.id);
  return chapterA - chapterB || numberA - numberB;
}

// Every issue node keeps an icon so it reads as an issue at a glance. The
// neutral (i) is the baseline flag; open critical/high swap in a colored
// severity glyph. The checkbox and row description carry resolved state along
// with the exact severity and confidence, so resolved issues fall back to (i)
// rather than a redundant checkmark.
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
