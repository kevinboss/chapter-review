import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { DiffViewer } from "./diffViewer";
import { FocusStore, focusForNode } from "./focus";
import {
  GIT_SCHEME,
  GitContentProvider,
  PATCHED_SCHEME,
  PatchedContentProvider,
  resolveGitDir,
  reviewUriPath,
} from "./gitContent";
import { computeDigests } from "./fingerprint";
import { isOpen, Manifest, parseManifest, ReviewedUnit } from "./model";
import { ReviewProgress } from "./progress";
import { checkSkill, installSkill, refreshSkillContext } from "./skillInstaller";
import { checkStaleness } from "./staleness";
import { errorMessage } from "./util";
import { ChapterTreeProvider, FileNode, HunkNode, IssueNode, Node, ViewMode } from "./tree";

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const MANIFEST_PATH = "chapter-review/chapters.json";
// Review checkmarks live in their own document, written only here. The manifest
// belongs to the agent's CLI; when both wrote chapters.json, each side's
// whole-file read-modify-write could silently drop the other's edit.
const PROGRESS_PATH = "chapter-review/progress.json";
const VIEW_MODE_KEY = "chapterReview.viewMode";

// Fingerprint of manifest bytes, so the extension can recognize its own writes.
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** progress.json as the extension expects to find it. */
function hasReviewedArray(doc: unknown): doc is { reviewed: ReviewedUnit[] } {
  return (
    typeof doc === "object" &&
    doc !== null &&
    "reviewed" in doc &&
    Array.isArray(doc.reviewed)
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The skill installer needs neither a git repo nor a manifest, so register
  // it first and let the rest bail out early on non-git workspaces.
  context.subscriptions.push(
    vscode.commands.registerCommand("chapterReview.installSkill", () => installSkill(context)),
    vscode.commands.registerCommand("chapterReview.updateSkill", () => installSkill(context))
  );
  void checkSkill(context);
  void refreshSkillContext(context);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const folderUri = folder.uri;
  const gitDir = await resolveGitDir(folderUri.fsPath);
  if (!gitDir) {
    return; // not a git repo; the view keeps its welcome content
  }
  const gitDirUri = vscode.Uri.file(gitDir);
  const manifestUri = vscode.Uri.joinPath(gitDirUri, MANIFEST_PATH);
  const progressUri = vscode.Uri.joinPath(gitDirUri, PROGRESS_PATH);

  // Hash of the last content we wrote, so the watcher can skip our own writes.
  // A container because these are reassigned from the closures below.
  const lastWritten: { manifest?: string; progress?: string } = {};

  const progress = new ReviewProgress();
  const focus = new FocusStore(gitDirUri);
  const patchedDocs = new PatchedContentProvider();

  const viewMode = context.workspaceState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  const provider = new ChapterTreeProvider(folderUri, progress, undefined, viewMode);
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  const view = vscode.window.createTreeView("chapterReview", {
    treeDataProvider: provider,
    showCollapseAll: true,
    // Containers (chapter/folder) and issues carry checkboxes backed by two
    // separate stores, so we drive parent/child state ourselves rather than
    // letting VS Code cascade a chapter tick into resolving its issues.
    manageCheckboxStateManually: true,
  });

  const diffViewer = new DiffViewer(folderUri, patchedDocs, () => provider.manifest);

  function updateSummary(): void {
    const m = provider.manifest;
    if (!m) {
      view.description = undefined;
      view.message = undefined;
      return;
    }
    const { done, total } = provider.progressSummary();
    view.description = `${done} of ${total} reviewed`;
    view.message = m.summary ? `${m.head}: ${m.summary}` : m.head;
  }

  async function reload(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(manifestUri);
      provider.manifest = parseManifest(Buffer.from(bytes).toString("utf8"));
    } catch (e) {
      provider.manifest = undefined;
      if (!(e instanceof vscode.FileSystemError)) {
        void vscode.window.showErrorMessage(`Chapter Review: ${errorMessage(e)}`);
      }
    }
    progress.load(await readProgressUnits());
    await refreshDigests();
    await refreshStaleness();
  }

  // Fingerprints the reviewed content of each unit so checkmarks track content,
  // not hunk coordinates: a regenerated chapter drops the check on units whose
  // content moved. Recomputed only here (on manifest change), since digests are
  // a pure function of the manifest's pinned commits.
  async function refreshDigests(): Promise<void> {
    provider.digests = provider.manifest
      ? await computeDigests(folderUri.fsPath, provider.manifest)
      : new Map<string, string>();
  }

  /** Checkmarks from progress.json; undefined when it is absent or unreadable. */
  async function readProgressUnits(): Promise<ReviewedUnit[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(progressUri);
      const doc: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return hasReviewedArray(doc) ? doc.reviewed : undefined;
    } catch {
      return undefined;
    }
  }

  // Write the manifest, remembering its hash so the watcher skips this write.
  async function persistManifest(m: Manifest): Promise<void> {
    const buf = Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8");
    lastWritten.manifest = sha(buf);
    await vscode.workspace.fs.writeFile(manifestUri, buf);
  }

  /**
   * Persist the checked set to progress.json and repaint from memory (only
   * checkmarks changed, so no reload or digest recompute).
   *
   * Written via a temp file and rename: the CLI reads this document, and an
   * in-place write can hand it a truncated file.
   */
  async function persistProgress(): Promise<void> {
    const m = provider.manifest;
    if (!m) {
      return;
    }
    const doc = { version: 1, reviewed: progress.toReviewedUnits(m) };
    const buf = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
    lastWritten.progress = sha(buf);
    const tmp = vscode.Uri.joinPath(gitDirUri, `${PROGRESS_PATH}.${process.pid}.tmp`);
    await vscode.workspace.fs.writeFile(tmp, buf);
    await vscode.workspace.fs.rename(tmp, progressUri, { overwrite: true });
    provider.refresh();
    updateSummary();
  }

  // Re-checks whether the manifest's pinned commit still matches the branch and
  // repaints. Cheap (a couple of git calls), so the HEAD watcher and the
  // window-focus net can call it directly without re-reading the manifest.
  async function refreshStaleness(): Promise<void> {
    provider.staleness = provider.manifest
      ? await checkStaleness(folderUri.fsPath, provider.manifest)
      : undefined;
    provider.refresh();
    updateSummary();
  }

  function setViewMode(mode: ViewMode): void {
    provider.viewMode = mode;
    void context.workspaceState.update(VIEW_MODE_KEY, mode);
    void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, mode);
    provider.refresh();
  }

  // The resource behind the active editor: the modified side of a diff, or a
  // plain editor's document. Used to recover the real file from a diff view.
  function activeReviewUri(): vscode.Uri | undefined {
    // The tab input is `unknown` by design: its shape depends on the editor kind
    // (diff, text, notebook, custom). Read the two fields that interest us if
    // they are there, rather than claiming a shape this tab may not have.
    const { input } = vscode.window.tabGroups.activeTabGroup.activeTab ?? {};
    if (typeof input !== "object" || input === null) {
      return undefined;
    }
    const fields = new Map<string, unknown>(Object.entries(input));
    const uriField = (key: string): vscode.Uri | undefined => {
      const v = fields.get(key);
      return v instanceof vscode.Uri ? v : undefined;
    };
    return uriField("modified") ?? uriField("uri");
  }

  // Opens the real working-tree file behind a diff side, at the current line.
  async function openFile(arg?: vscode.Uri): Promise<void> {
    const uri = arg && reviewUriPath(arg) ? arg : activeReviewUri();
    const rel = uri && reviewUriPath(uri);
    if (!rel) {
      return;
    }
    const selection = vscode.window.activeTextEditor?.selection;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderUri, rel));
      await vscode.window.showTextDocument(doc, selection ? { selection } : {});
    } catch {
      void vscode.window.showWarningMessage(`Chapter Review: could not open ${rel}`);
    }
  }

  // Opening an issue both shows its diff and records it as the current focus.
  async function openIssue(node: IssueNode): Promise<void> {
    await diffViewer.openIssue(node);
    const f = focusForNode(node);
    if (f) {
      await focus.write(f);
    }
  }

  // Applies the checked/unchecked state of issue checkboxes to the manifest in
  // a single write. Issue state lives in chapters.json (the skill reads it
  // back), separate from the per-user review-progress store used by files.
  async function setIssuesResolved(updates: { id: string; resolved: boolean }[]): Promise<void> {
    const m = provider.manifest;
    if (!m?.issues) {
      return;
    }
    const changed = updates.filter(({ id, resolved }) => {
      const issue = m.issues?.find((i) => i.id === id);
      if (!issue || !isOpen(issue) === resolved) {
        return false;
      }
      issue.status = resolved ? "resolved" : "open";
      return true;
    });
    if (changed.length === 0) {
      return;
    }
    try {
      await persistManifest(m);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Chapter Review: could not update the issue: ${errorMessage(e)}`
      );
      return;
    }
  }

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_SCHEME,
      new GitContentProvider(folderUri.fsPath)
    ),
    vscode.workspace.registerTextDocumentContentProvider(PATCHED_SCHEME, patchedDocs),
    view.onDidChangeCheckboxState(async (e) => {
      const issueUpdates: { id: string; resolved: boolean }[] = [];
      const progressNodes = [...e.items].filter(([node, state]) => {
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === "issue") {
          issueUpdates.push({ id: node.issue.id, resolved: checked });
          return false;
        }
        progress.setReviewed(provider.reviewUnitsFor(node), checked);
        return true;
      });
      const progressChanged = progressNodes.length > 0;
      if (issueUpdates.length > 0) {
        await setIssuesResolved(issueUpdates);
      }
      // persistProgress repaints; if only issues changed, repaint here instead.
      if (progressChanged) {
        await persistProgress();
      } else {
        provider.refresh();
        updateSummary();
      }
    }),
    view.onDidChangeSelection(async (e) => {
      const node = e.selection[0] as Node | undefined;
      const f = node && focusForNode(node);
      if (f) {
        await focus.write(f);
      }
    }),
    vscode.commands.registerCommand("chapterReview.refresh", reload),
    vscode.commands.registerCommand("chapterReview.viewAsTree", () => { setViewMode("tree"); }),
    vscode.commands.registerCommand("chapterReview.viewAsList", () => { setViewMode("list"); }),
    vscode.commands.registerCommand("chapterReview.openDiff", (node: FileNode | HunkNode) =>
      diffViewer.openDiff(node)
    ),
    vscode.commands.registerCommand("chapterReview.openFile", openFile),
    vscode.commands.registerCommand("chapterReview.openIssue", openIssue),
    vscode.commands.registerCommand("chapterReview.resetProgress", async () => {
      progress.clear();
      await persistProgress();
    })
  );

  // Skip reloads caused by our own writes; a CLI write differs and still reloads.
  async function onManifestWritten(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(manifestUri);
      if (sha(bytes) === lastWritten.manifest) {
        return;
      }
    } catch {
      // Fall through: reload() handles a missing or unreadable manifest.
    }
    await reload();
  }

  // Base the watcher on the git dir, which may sit outside the workspace
  // folder (worktrees); RelativePattern with a Uri base handles that.
  // progress.json is written by this extension and by `chapter-review uncheck`,
  // so an external change has to repaint the checkmarks. Cheaper than the
  // manifest path: only the checked set changed, so no reload or digest work.
  async function onProgressWritten(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(progressUri);
      if (sha(Buffer.from(bytes)) === lastWritten.progress) {
        return; // our own write
      }
    } catch {
      /* deleted: fall through and repaint as empty */
    }
    progress.load(await readProgressUnits());
    provider.refresh();
    updateSummary();
  }

  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, PROGRESS_PATH)
  );
  progressWatcher.onDidCreate(() => void onProgressWritten());
  progressWatcher.onDidChange(() => void onProgressWritten());
  progressWatcher.onDidDelete(() => void onProgressWritten());
  context.subscriptions.push(progressWatcher);

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, MANIFEST_PATH)
  );
  watcher.onDidCreate(onManifestWritten);
  watcher.onDidChange(onManifestWritten);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  // Live staleness: a commit, amend, rebase or checkout in the terminal moves
  // HEAD or the branch ref, both files under the git dir. Re-check on those,
  // and on window focus as a safety net for OSes where .git watches are flaky.
  const headWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, "{HEAD,refs/heads/**,packed-refs}")
  );
  headWatcher.onDidCreate(refreshStaleness);
  headWatcher.onDidChange(refreshStaleness);
  headWatcher.onDidDelete(refreshStaleness);
  context.subscriptions.push(
    headWatcher,
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refreshStaleness();
      }
    })
  );

  void reload();
}

// Nothing to tear down: every disposable is registered on the extension
// context, which VSCode disposes for us.
export function deactivate(): void {
  /* no-op */
}
