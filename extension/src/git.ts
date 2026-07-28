// Git queries the review logic needs. Deliberately free of the vscode API, so
// the modules built on it (fingerprint, staleness) can be exercised under plain
// node without launching an editor.

import { execFile } from "node:child_process";

/** Absolute git dir of the repo at cwd (worktree-safe); undefined if not a repo. */
export function resolveGitDir(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd },
      (err, stdout) => { resolve(err ? undefined : stdout.trim()); }
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
      (err, stdout) => { resolve(err ? "" : stdout); }
    );
  });
}

/** `git rev-parse <ref>` → full SHA, or undefined if it can't be resolved. */
export function gitRevParse(repoRoot: string, ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", ref], { cwd: repoRoot }, (err, stdout) =>
      { resolve(err ? undefined : stdout.trim() || undefined); }
    );
  });
}

/** `git merge-base <a> <b>` → SHA, or undefined if there is no common ancestor. */
export function gitMergeBase(
  repoRoot: string,
  a: string,
  b: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["merge-base", a, b], { cwd: repoRoot }, (err, stdout) =>
      { resolve(err ? undefined : stdout.trim() || undefined); }
    );
  });
}
