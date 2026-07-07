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
import { allEntries, entryKeys, parseManifest } from "./model";
import { ReviewProgress } from "./progress";
import { checkSkill, installSkill, refreshSkillContext } from "./skillInstaller";
import { checkStaleness } from "./staleness";
import { ChapterTreeProvider, FileNode, HunkNode, IssueNode, Node, nodeKeys, ViewMode } from "./tree";

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const MANIFEST_PATH = "chapter-review/chapters.json";
const VIEW_MODE_KEY = "chapterReview.viewMode";

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

  const progress = new ReviewProgress(context.workspaceState);
  const focus = new FocusStore(gitDirUri);
  const patchedDocs = new PatchedContentProvider();

  const viewMode = context.workspaceState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  const provider = new ChapterTreeProvider(folderUri, progress, undefined, viewMode);
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  const view = vscode.window.createTreeView("chapterReview", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const diffViewer = new DiffViewer(folderUri, patchedDocs, () => provider.manifest);

  function updateSummary(): void {
    const m = provider.manifest;
    if (!m) {
      view.description = undefined;
      view.message = undefined;
      return;
    }
    const keys = allEntries(m).flatMap(entryKeys);
    const done = keys.filter((k) => progress.isReviewed(k)).length;
    view.description = `${done} of ${keys.length} reviewed`;
    view.message = m.summary ? `${m.head}: ${m.summary}` : m.head;
  }

  async function reload(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(manifestUri);
      provider.manifest = parseManifest(Buffer.from(bytes).toString("utf8"));
    } catch (e) {
      provider.manifest = undefined;
      if (!(e instanceof vscode.FileSystemError)) {
        void vscode.window.showErrorMessage(`Chapter Review: ${(e as Error).message}`);
      }
    }
    await refreshStaleness();
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
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
      | { modified?: vscode.Uri; uri?: vscode.Uri }
      | undefined;
    return input?.modified ?? input?.uri;
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

  async function resolveIssue(node: IssueNode): Promise<void> {
    const m = provider.manifest;
    const issue = m?.issues?.find((i) => i.id === node.issue.id);
    if (!m || !issue) {
      return;
    }
    issue.status = issue.status === "resolved" ? "open" : "resolved";
    try {
      await vscode.workspace.fs.writeFile(
        manifestUri,
        Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8")
      );
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Chapter Review: could not update the issue: ${(e as Error).message}`
      );
      return;
    }
    await reload();
  }

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_SCHEME,
      new GitContentProvider(folderUri.fsPath)
    ),
    vscode.workspace.registerTextDocumentContentProvider(PATCHED_SCHEME, patchedDocs),
    view.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        await progress.setReviewed(
          nodeKeys(node as Node),
          state === vscode.TreeItemCheckboxState.Checked
        );
      }
      provider.refresh();
      updateSummary();
    }),
    view.onDidChangeSelection(async (e) => {
      const node = e.selection[0] as Node | undefined;
      const f = node && focusForNode(node);
      if (f) {
        await focus.write(f);
      }
    }),
    vscode.commands.registerCommand("chapterReview.refresh", reload),
    vscode.commands.registerCommand("chapterReview.viewAsTree", () => setViewMode("tree")),
    vscode.commands.registerCommand("chapterReview.viewAsList", () => setViewMode("list")),
    vscode.commands.registerCommand("chapterReview.openDiff", (node: FileNode | HunkNode) =>
      diffViewer.openDiff(node)
    ),
    vscode.commands.registerCommand("chapterReview.openFile", openFile),
    vscode.commands.registerCommand("chapterReview.openIssue", openIssue),
    vscode.commands.registerCommand("chapterReview.resolveIssue", resolveIssue),
    vscode.commands.registerCommand("chapterReview.resetProgress", async () => {
      await progress.clear();
      provider.refresh();
      updateSummary();
    })
  );

  // Base the watcher on the git dir, which may sit outside the workspace
  // folder (worktrees); RelativePattern with a Uri base handles that.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, MANIFEST_PATH)
  );
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
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

export function deactivate(): void {}
