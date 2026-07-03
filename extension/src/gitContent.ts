import { execFile } from "node:child_process";
import * as vscode from "vscode";

export const GIT_SCHEME = "chapter-review-git";
export const PATCHED_SCHEME = "chapter-review-patched";

/** Absolute git dir of the repo at cwd (worktree-safe); undefined if not a repo. */
export function resolveGitDir(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd },
      (err, stdout) => resolve(err ? undefined : stdout.trim())
    );
  });
}

/** `git show <ref>:<path>`; empty ref or a missing file yields "". */
export function gitShow(repoRoot: string, ref: string, path: string): Promise<string> {
  if (!ref) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["show", `${ref}:${path}`],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      // File absent at ref (e.g. stale manifest): empty side beats an error.
      (err, stdout) => resolve(err ? "" : stdout)
    );
  });
}

/**
 * Serves file content at a fixed ref, so diffs against the merge base need no
 * coupling to the built-in git extension. URI form:
 * chapter-review-git:/<path>?<JSON {ref, path}> — an empty ref yields empty
 * content (the left side of an added file's diff).
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repoRoot: string) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref, path } = JSON.parse(uri.query) as { ref: string; path: string };
    return gitShow(this.repoRoot, ref, path);
  }
}

export function gitUri(ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${path}`,
    query: JSON.stringify({ ref, path }),
  });
}

/**
 * Holds the chapter-scoped virtual documents built by openDiff (merge-base
 * content plus only the chapter's hunks). Keyed by URI; re-opening a diff
 * overwrites the entry and fires a change so an open editor refreshes.
 */
export class PatchedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

export function patchedUri(ownerId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PATCHED_SCHEME, path: `/${ownerId}/${path}` });
}
