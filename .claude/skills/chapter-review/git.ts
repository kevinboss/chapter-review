// Git queries and the two paths derived from the repo's git dir. The git dir is
// resolved the same way the extension resolves it, so both sides operate on the
// same chapter-review/ folder.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { die, errorMessage } from "./util.ts";

/**
 * Room for git output that grows with the repository, a file or a diff. Node's
 * default of 1 MiB fails on a single large generated file.
 */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Worktree-safe absolute git dir, matching how the extension resolves it, so
 * both sides land on the same chapter-review/ folder. Exits if git can't answer
 * (not a repository).
 */
export function gitDir(): string {
  try {
    return execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      // Silence git's own "fatal:" line so the not-a-repo path prints only our
      // message, matching gitTry/lsRemoteTip.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    die("chapter-review: not inside a git repository (git rev-parse failed).", 2);
  }
}

/**
 * The protocol directory: `<git-dir>/chapter-review/`.
 *
 * Refuses to hand back a path that resolves outside the git dir. Everything here
 * is tool state living inside `.git` on purpose — a symlink standing in for this
 * directory would send every write somewhere else while the command still
 * reported the in-repo path, which is both an escape and a lie.
 */
export function protocolDir(): string {
  return toolDir("chapter-review");
}

/** Where displaced branch reviews wait, one folder each: `<git-dir>/chapter-review-parked/`. */
export function parkedRoot(): string {
  return toolDir("chapter-review-parked");
}

function toolDir(name: string): string {
  const dir = path.join(gitDir(), name);
  if (existsSync(dir)) {
    const real = realpathSync(dir);
    const inside = realpathSync(gitDir()) + path.sep;
    if (!(real + path.sep).startsWith(inside)) {
      die(
        `chapter-review: ${dir} resolves to ${real}, outside the git dir. ` +
          "Remove it; this directory is tool state and must live inside .git.",
        2
      );
    }
  }
  return dir;
}

/** Absolute path to this repo's chapter-review manifest, inside the git dir. */
export const manifestPath = (): string => path.join(protocolDir(), "chapters.json");
/** Absolute path to the reviewer's checkmarks, written by the extension. */
export const progressPath = (): string => path.join(protocolDir(), "progress.json");
/** Absolute path to the extension's focus pointer file, inside the git dir. */
export const focusPath = (): string => path.join(protocolDir(), "focus.json");
/** Where earlier rounds are kept, one directory per round number. */
export const roundsDir = (): string => path.join(protocolDir(), "rounds");
/** An earlier round's manifest, read-only once archived. */
export const roundManifestPath = (round: number): string =>
  path.join(roundsDir(), String(round), "chapters.json");
/** An earlier round's checkmarks, still written by the extension. */
export const roundProgressPath = (round: number): string =>
  path.join(roundsDir(), String(round), "progress.json");

// Per worktree: gc in any worktree honours these refs, and two worktrees
// reviewing different branches cannot release each other's.
export const PIN_PREFIX = "refs/worktree/chapter-review/";
/** A parked review's pins, under `<prefix><name>/`. */
export const PARKED_PIN_PREFIX = "refs/worktree/chapter-review-parked/";

/**
 * Keep exactly `commits` reachable through pin refs. A round's head stops being
 * referenced once the author force-pushes a fixup, and a replayed base never was,
 * so without a pin gc deletes the commits an earlier round's diff is read from.
 * A commit this repo does not have is skipped.
 */
export function syncPins(commits: ReadonlySet<string>): void {
  const listed = gitTry("for-each-ref", "--format=%(refname)", PIN_PREFIX) ?? "";
  const have = new Set(
    listed
      .split("\n")
      .filter((ref) => ref.startsWith(PIN_PREFIX))
      .map((ref) => ref.slice(PIN_PREFIX.length))
  );
  const ops = [...have].filter((sha) => !commits.has(sha)).map((sha) => `delete ${PIN_PREFIX}${sha}`);
  for (const sha of commits) {
    if (!have.has(sha) && gitOk("cat-file", "-e", `${sha}^{commit}`)) {
      ops.push(`create ${PIN_PREFIX}${sha} ${sha}`);
    }
  }
  if (ops.length === 0) return;
  try {
    execFileSync("git", ["update-ref", "--stdin"], {
      input: ops.join("\n") + "\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    console.error("chapter-review: could not update the pins that keep earlier rounds' commits.");
  }
}

/**
 * Soft git query for the commit pin: trimmed stdout, or undefined when git
 * can't answer. Unlike gitDir() this never dies; write must still install a
 * manifest on a detached HEAD or a repo whose base ref has gone missing; it
 * just keeps the draft's value for whichever pin git couldn't recompute.
 */
export function gitTry(...args: string[]): string | undefined {
  try {
    // stderr silenced: a failed soft query is an expected fallback (missing base
    // ref, detached HEAD), not something to print git's "fatal:" line about.
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_MAX_BUFFER,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file `p` at `commit`, exactly as committed, or undefined when that commit
 * has no file there. Dies when git cannot answer for any other reason, since a
 * caller reading undefined as "no such file" would otherwise misreport it.
 */
export function fileAt(commit: string, p: string): string | undefined {
  if (!gitOk("cat-file", "-e", `${commit}^{commit}`)) {
    die(`chapter-review: ${short(commit) ?? commit} is not a commit in this repository, so ${p} cannot be read at it.`);
  }
  if (gitTry("cat-file", "-t", `${commit}:${p}`) !== "blob") return undefined;
  try {
    return execFileSync("git", ["cat-file", "blob", `${commit}:${p}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (e) {
    die(`chapter-review: could not read ${p} at ${short(commit) ?? commit}: ${errorMessage(e)}`);
  }
}

/**
 * The working tree as a commit on top of HEAD: staged, unstaged and untracked
 * files, minus what .gitignore excludes. Built in a copy of the index, so the
 * real one and the files are untouched. Identity and dates are fixed, so the
 * same tree on the same HEAD yields the same id: `base-check --worktree` prints
 * it before the partition is built and `write` arrives at it again.
 */
export function snapshotWorktree(): string | undefined {
  const head = gitTry("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  const top = gitTry("rev-parse", "--show-toplevel");
  if (head === undefined || top === undefined) return undefined;
  const realIndex = path.resolve(top, gitTry("rev-parse", "--git-path", "index") ?? "");
  const index = path.join(tmpdir(), `chapter-review-snapshot-${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[], extra: NodeJS.ProcessEnv = env): string =>
    execFileSync("git", args, {
      cwd: top,
      encoding: "utf8",
      env: extra,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_MAX_BUFFER,
    }).trim();
  try {
    // A copy keeps the real index's stat cache, so only edited files are hashed.
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    else run(["read-tree", head]);
    run(["add", "--all"]);
    const tree = run(["write-tree"]);
    const when = run(["log", "-1", "--format=%cI", head]);
    return run(["commit-tree", tree, "-p", head, "-m", `chapter-review: working tree on ${head}`], {
      ...env,
      GIT_AUTHOR_NAME: "chapter-review",
      GIT_AUTHOR_EMAIL: "chapter-review@localhost",
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: "chapter-review",
      GIT_COMMITTER_EMAIL: "chapter-review@localhost",
      GIT_COMMITTER_DATE: when,
    });
  } catch {
    return undefined;
  } finally {
    rmSync(index, { force: true });
  }
}

/** Files with changes git has not committed, untracked ones included and ignored ones not. */
export function openChangeCount(): number {
  const out = gitTry("status", "--porcelain=v1", "--untracked-files=all") ?? "";
  return out === "" ? 0 : out.split("\n").length;
}

/** The checked-out branch, or undefined on a detached HEAD. */
export function currentBranch(): string | undefined {
  const name = gitTry("rev-parse", "--abbrev-ref", "HEAD");
  return name === "HEAD" ? undefined : name;
}

/**
 * Two hex refs name the same commit when one is a prefix of the other (>= 7
 * chars), matching the extension's staleness comparison so a short SHA the
 * draft carried is not reported as a correction against its own full form.
 */
export function sameCommit(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/** First 7 characters of a sha for display. Non-strings pass through unchanged. */
export const short = (sha: string | undefined): string | undefined =>
  typeof sha === "string" ? sha.slice(0, 7) : sha;

/**
 * Non-throwing boolean git query: true when the command exits 0. Needed for
 * `merge-base --is-ancestor`, which signals via exit code with empty stdout
 * (so gitTry, which returns undefined on empty output, can't tell it apart).
 */
export function gitOk(...args: string[]): boolean {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the review base the same way the skill's step 1 does, so base-check
 * judges the ref the skill will actually diff against: origin's default branch,
 * else a local main, else master. Undefined when none resolve.
 */
export function resolveBase(): string | undefined {
  const head = gitTry("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (head) return head.replace(/^refs\/remotes\//, ""); // -> "origin/main"
  if (gitOk("rev-parse", "--verify", "--quiet", "refs/heads/main")) return "main";
  if (gitOk("rev-parse", "--verify", "--quiet", "refs/heads/master")) return "master";
  return undefined;
}

/**
 * The branch name behind a base ref: strip refs/heads|remotes and a leading
 * origin/. "origin/main" -> "main", "refs/heads/release/x" -> "release/x".
 */
export function branchLeaf(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
}

/**
 * Best-effort remote tip for `leaf` without fetching. Never prompts for
 * credentials (GIT_TERMINAL_PROMPT=0) and bails after a short timeout, so an
 * unreachable or slow remote degrades to {reachable:false} instead of hanging
 * the whole review generation on a network stall.
 */
export function lsRemoteTip(leaf: string): { reachable: boolean; tip: string | undefined } {
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin", leaf], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 6000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    const tip = out ? out.split(/\s+/)[0] : undefined;
    return { reachable: true, tip };
  } catch {
    return { reachable: false, tip: undefined };
  }
}
