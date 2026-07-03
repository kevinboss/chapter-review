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
import { allEntries, entryKeys, Hunk, parseManifest } from "./model";
import { checkSkill, installSkill } from "./skillInstaller";
import {
  ChapterTreeProvider,
  FileNode,
  HunkNode,
  IssueNode,
  Node,
  nodeKeys,
  ViewMode,
} from "./tree";

interface Focus {
  path?: string;
  line?: number;
  chapterId?: string;
  issueId?: string;
}

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const MANIFEST_PATH = "chapter-review/chapters.json";
// The extension writes what the user is looking at here; the chapter-review
// skill reads it to resolve "this file/issue" in follow-up questions.
const FOCUS_PATH = "chapter-review/focus.json";
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
  const gitDirUri = vscode.Uri.file(gitDir);
  const manifestUri = vscode.Uri.joinPath(gitDirUri, MANIFEST_PATH);
  const focusUri = vscode.Uri.joinPath(gitDirUri, FOCUS_PATH);
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

  async function openEntry(
    ownerId: string,
    entry: FileNode["entry"],
    focusHunk?: Hunk
  ): Promise<void> {
    const m = provider.manifest;
    if (!m) {
      return;
    }
    const headRef = m.headSha ?? m.head;
    const oldName = entry.oldPath ?? entry.path;

    const owner =
      ownerId === "unassigned"
        ? "Unassigned"
        : m.chapters.find((c) => c.id === ownerId)?.title ?? ownerId;
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
      right = patchedUri(ownerId, entry.path);
      patchedDocs.set(right, patch.text);

      const focus = focusHunk ?? entry.hunks[0];
      const line = Math.max(0, (patch.changeLines.get(focus) ?? 1) - 1);
      options.selection = new vscode.Range(line, 0, line, 0);
    } else {
      right = entry.status === "deleted" ? gitUri("", entry.path) : gitUri(headRef, entry.path);
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
  }

  function openDiff(node: FileNode | HunkNode): Promise<void> {
    return openEntry(node.ownerId, node.entry, node.kind === "hunk" ? node.hunk : undefined);
  }

  async function openIssue(node: IssueNode): Promise<void> {
    const m = provider.manifest;
    if (!m) {
      return;
    }
    const { issue } = node;
    const entry = m.chapters
      .find((c) => c.id === issue.chapterId)
      ?.files.find((f) => f.path === issue.path);
    if (entry) {
      // Pass the entry's own hunk object so the scoped-diff line lookup matches.
      const focusHunk = issue.hunk
        ? entry.hunks?.find(
            (h) =>
              h.oldStart === issue.hunk!.oldStart &&
              h.oldLines === issue.hunk!.oldLines &&
              h.newStart === issue.hunk!.newStart &&
              h.newLines === issue.hunk!.newLines
          )
        : undefined;
      await openEntry(issue.chapterId!, entry, focusHunk);
    } else {
      // No owning chapter entry (e.g. orphaned issue): open the working file.
      try {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(folderUri, issue.path)
        );
        const line = Math.max(0, (issue.hunk?.newStart ?? 1) - 1);
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line, 0, line, 0),
        });
      } catch {
        void vscode.window.showWarningMessage(`Chapter Review: could not open ${issue.path}`);
      }
    }
    await writeFocus({
      path: issue.path,
      line: issue.hunk?.newStart,
      chapterId: issue.chapterId,
      issueId: issue.id,
    });
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

  // Written whenever the user's selection changes, so the skill can resolve
  // "this file/change/issue" in the terminal. Best-effort convenience channel.
  async function writeFocus(focus: Focus): Promise<void> {
    const data = Buffer.from(
      JSON.stringify({ ...focus, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
    try {
      await vscode.workspace.fs.writeFile(focusUri, data);
    } catch {
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(gitDirUri, "chapter-review")
        );
        await vscode.workspace.fs.writeFile(focusUri, data);
      } catch {
        /* focus is a convenience channel; ignore write failures */
      }
    }
  }

  function focusForNode(node: Node): Focus | undefined {
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
    view.onDidChangeSelection(async (e) => {
      const node = e.selection[0] as Node | undefined;
      if (node) {
        const focus = focusForNode(node);
        if (focus) {
          await writeFocus(focus);
        }
      }
    }),
    vscode.commands.registerCommand("chapterReview.refresh", reload),
    vscode.commands.registerCommand("chapterReview.viewAsTree", () => setViewMode("tree")),
    vscode.commands.registerCommand("chapterReview.viewAsList", () => setViewMode("list")),
    vscode.commands.registerCommand("chapterReview.openDiff", openDiff),
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
    new vscode.RelativePattern(vscode.Uri.file(gitDir), MANIFEST_PATH)
  );
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  void reload();
}

export function deactivate(): void {}
