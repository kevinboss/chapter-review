import * as vscode from "vscode";
import { DiffViewer } from "./diffViewer";
import { FocusStore, focusForNode } from "./focus";
import {
  GIT_SCHEME,
  GitContentProvider,
  PATCHED_SCHEME,
  PatchedContentProvider,
  resolveGitDir,
} from "./gitContent";
import { allEntries, entryKeys, parseManifest } from "./model";
import { ReviewProgress } from "./progress";
import { checkSkill, installSkill } from "./skillInstaller";
import { ChapterTreeProvider, FileNode, HunkNode, IssueNode, Node, nodeKeys, ViewMode } from "./tree";

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const MANIFEST_PATH = "chapter-review/chapters.json";
const VIEW_MODE_KEY = "chapterReview.viewMode";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The skill installer needs neither a git repo nor a manifest, so register
  // it first and let the rest bail out early on non-git workspaces.
  context.subscriptions.push(
    vscode.commands.registerCommand("chapterReview.installSkill", () => installSkill(context))
  );
  void checkSkill(context);

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
    provider.refresh();
    updateSummary();
  }

  function setViewMode(mode: ViewMode): void {
    provider.viewMode = mode;
    void context.workspaceState.update(VIEW_MODE_KEY, mode);
    void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, mode);
    provider.refresh();
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

  void reload();
}

export function deactivate(): void {}
