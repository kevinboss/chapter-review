import * as path from "node:path";
import * as vscode from "vscode";
import { applyHunks } from "./diffScope";
import {
  GIT_SCHEME,
  GitContentProvider,
  gitShow,
  gitUri,
  PATCHED_SCHEME,
  PatchedContentProvider,
  patchedUri,
  resolveGitDir,
} from "./gitContent";
import { allEntries, entryKeys, Manifest, parseManifest } from "./model";
import { checkSkill, installSkill } from "./skillInstaller";
import {
  ChapterTreeProvider,
  FileNode,
  HunkNode,
  Node,
  nodeKeys,
  ViewMode,
} from "./tree";

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const MANIFEST_PATH = "chapter-review/chapters.json";
const PROGRESS_KEY = "chapterReview.reviewed";
const VIEW_MODE_KEY = "chapterReview.viewMode";

class ReviewProgress {
  private reviewed: Set<string>;

  constructor(private readonly state: vscode.Memento) {
    this.reviewed = new Set(state.get<string[]>(PROGRESS_KEY, []));
  }

  isReviewed(key: string): boolean {
    return this.reviewed.has(key);
  }

  setReviewed(keys: string[], reviewed: boolean): Thenable<void> {
    for (const key of keys) {
      reviewed ? this.reviewed.add(key) : this.reviewed.delete(key);
    }
    return this.state.update(PROGRESS_KEY, [...this.reviewed]);
  }

  clear(): Thenable<void> {
    this.reviewed.clear();
    return this.state.update(PROGRESS_KEY, []);
  }
}

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
  const manifestUri = vscode.Uri.joinPath(vscode.Uri.file(gitDir), MANIFEST_PATH);
  const progress = new ReviewProgress(context.workspaceState);

  const viewMode = context.workspaceState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  const provider = new ChapterTreeProvider(folder.uri, progress, undefined, viewMode);
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  const view = vscode.window.createTreeView("chapterReview", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

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

  async function openDiff(node: FileNode | HunkNode): Promise<void> {
    const m = provider.manifest;
    if (!m) {
      return;
    }
    const entry = node.entry;
    const headRef = m.headSha ?? m.head;
    const oldName = entry.oldPath ?? entry.path;

    const owner =
      node.ownerId === "unassigned"
        ? "Unassigned"
        : m.chapters.find((c) => c.id === node.ownerId)?.title ?? node.ownerId;
    const title = `${path.posix.basename(entry.path)} (${owner})`;

    const left =
      entry.status === "added" ? gitUri("", entry.path) : gitUri(m.mergeBase, oldName);
    let right: vscode.Uri;
    const options: vscode.TextDocumentShowOptions = {};

    if (entry.hunks && entry.status !== "added" && entry.status !== "deleted") {
      // Chapter-scoped view: right side is merge-base content with only this
      // entry's hunks applied, so the diff shows nothing but this chapter.
      const [oldText, newText] = await Promise.all([
        gitShow(folderUri.fsPath, m.mergeBase, oldName),
        gitShow(folderUri.fsPath, headRef, entry.path),
      ]);
      const patch = applyHunks(oldText, newText, entry.hunks);
      right = patchedUri(node.ownerId, entry.path);
      patchedDocs.set(right, patch.text);

      const focus = node.kind === "hunk" ? node.hunk : entry.hunks[0];
      const line = Math.max(0, (patch.changeLines.get(focus) ?? 1) - 1);
      options.selection = new vscode.Range(line, 0, line, 0);
    } else {
      right = entry.status === "deleted" ? gitUri("", entry.path) : gitUri(headRef, entry.path);
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
  }

  const patchedDocs = new PatchedContentProvider();

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_SCHEME,
      new GitContentProvider(folder.uri.fsPath)
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
    vscode.commands.registerCommand("chapterReview.refresh", reload),
    vscode.commands.registerCommand("chapterReview.viewAsTree", () => setViewMode("tree")),
    vscode.commands.registerCommand("chapterReview.viewAsList", () => setViewMode("list")),
    vscode.commands.registerCommand("chapterReview.openDiff", openDiff),
    vscode.commands.registerCommand("chapterReview.resetProgress", async () => {
      await progress.clear();
      provider.refresh();
      updateSummary();
    })
  );

  // Base the watcher on the git dir, which may sit outside the workspace
  // folder (worktrees); RelativePattern with a Uri base handles that.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(gitDir), MANIFEST_PATH)
  );
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  void reload();
}

export function deactivate(): void {}
