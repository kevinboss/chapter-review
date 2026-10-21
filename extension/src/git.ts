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

/**
 * Tracked files with uncommitted changes, or undefined if the query can't run.
 * `--untracked-files=no`: a new file nobody staged is not part of the diff.
 */
export function gitDirtyCount(repoRoot: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? undefined : stdout.split("\n").filter((l) => l.trim() !== "").length);
      }
    );
  });
}

// Where the CLI pins the commits each round's diff is read from, per worktree.
const PIN_PREFIX = "refs/worktree/chapter-review/";

/**
 * Drop every pin the CLI made for this worktree's review, so a discarded review
 * leaves nothing behind for gc to keep. Failures are swallowed: an unreleased
 * pin keeps a commit alive, it breaks nothing.
 */
export function releasePins(repoRoot: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["for-each-ref", "--format=delete %(refname)", PIN_PREFIX],
      { cwd: repoRoot },
      (err, stdout) => {
        if (err || stdout.trim() === "") {
          resolve();
          return;
        }
        const child = execFile("git", ["update-ref", "--stdin"], { cwd: repoRoot }, () => {
          resolve();
        });
        child.stdin?.end(stdout);
      }
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
