// Parking. A worktree review displaces the branch review installed in this
// checkout, so that review's state, its files and its pins, moves under a name
// taken from its branch. It comes back when the worktree review is discarded or
// a review of that branch is written again, and several can wait, one per branch.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { die, errorMessage } from "./util.ts";
import { currentBranch, gitOk, gitTry, PARKED_PIN_PREFIX, parkedRoot, PIN_PREFIX, protocolDir, short } from "./git.ts";
import { issuesOf, readManifestIfValid } from "./manifest.ts";
import type { Manifest } from "./types.ts";

/**
 * The name a review of `head` is parked under: the branch with `/` as `-`, as
 * worktree folders are named, or the commit when there is no usable branch name.
 */
export function parkName(head: string | undefined, headSha: string): string {
  const name = head?.replace(/[/\\:*?"<>|]/g, "-");
  return name !== undefined && name !== "HEAD" && gitOk("check-ref-format", `${PARKED_PIN_PREFIX}${name}/x`)
    ? name
    : (short(headSha) ?? headSha);
}

/** The name a review of what is checked out now is parked under. */
export function currentParkName(): string | undefined {
  const sha = gitTry("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  return sha === undefined ? undefined : parkName(currentBranch(), sha);
}

const parkedDir = (name: string): string => path.join(parkedRoot(), name);

/** The review parked under `name`, or null when none is or it cannot be read. */
export function parkedReview(name: string): Manifest | null {
  return readManifestIfValid(path.join(parkedDir(name), "chapters.json"));
}

/**
 * The review a branch write of `head` goes on with: the installed one when it is
 * a branch review of `head`, otherwise the one parked for `head`, which that
 * write brings back. `parkedAs` names it in the second case.
 */
export function continuedReview(
  installed: Manifest | null,
  head: string,
  headSha: string
): { prior: Manifest | null; parkedAs?: string } {
  if (installed !== null && installed.mode === undefined && installed.head === head) return { prior: installed };
  const name = parkName(head, headSha);
  const parked = parkedReview(name);
  return parked === null ? { prior: null } : { prior: parked, parkedAs: name };
}

/** Rounds folder of the review parked under `name`. */
export const parkedRoundsDir = (name: string): string => path.join(parkedDir(name), "rounds");
/** Checkmarks of the review parked under `name`. */
export const parkedProgressPath = (name: string): string => path.join(parkedDir(name), "progress.json");

/** Delete the installed review and its pins, for a worktree review nothing will bring back. */
export function discardActive(): void {
  const active = protocolDir();
  if (existsSync(active)) {
    for (const entry of readdirSync(active)) rmSync(path.join(active, entry), { recursive: true, force: true });
  }
  dropRefs(PIN_PREFIX);
}

/** Move `review`, installed now, out of the way under its branch's name. */
export function park(review: Manifest): string {
  const name = parkName(review.head, review.headSha);
  const dir = parkedDir(name);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    die(
      `chapter-review: a review is already parked as "${name}" (${dir}), so the review of ` +
        `${review.head} cannot be parked there too. Drop one with \`chapter-review parked drop ${name}\`.`
    );
  }
  moveContents(protocolDir(), dir);
  moveRefs(PIN_PREFIX, `${PARKED_PIN_PREFIX}${name}/`);
  return name;
}

/**
 * Put the review parked under `name` back in place of whatever is installed,
 * which is dropped. Null when nothing is parked under that name.
 */
export function restore(name: string): Manifest | null {
  const dir = parkedDir(name);
  if (!existsSync(dir)) return null;
  const review = parkedReview(name);
  discardActive();
  moveContents(dir, protocolDir());
  rmSync(dir, { recursive: true, force: true });
  moveRefs(`${PARKED_PIN_PREFIX}${name}/`, PIN_PREFIX);
  return review;
}

/** Delete the review parked under `name`, its pins included. */
export function drop(name: string): boolean {
  const dir = parkedDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  dropRefs(`${PARKED_PIN_PREFIX}${name}/`);
  return true;
}

export interface ParkedSummary {
  name: string;
  head?: string;
  round?: number;
  openFindings?: number;
  /** False when no branch of that name exists, so no write or discard will bring the review back. */
  branchExists: boolean;
}

/** Every parked review, by name. */
export function parkedReviews(): ParkedSummary[] {
  const root = parkedRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((name) => {
      const review = parkedReview(name);
      if (review === null) return { name, branchExists: false };
      return {
        name,
        head: review.head,
        round: review.round,
        openFindings: issuesOf(review).filter((i) => i.status !== "resolved").length,
        branchExists: gitOk("rev-parse", "--verify", "--quiet", `refs/heads/${review.head}`),
      };
    });
}

function moveContents(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    try {
      rmSync(dst, { recursive: true, force: true });
      try {
        renameSync(src, dst);
      } catch {
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      }
    } catch (e) {
      die(`chapter-review: could not move ${src} to ${dst}: ${errorMessage(e)}`);
    }
  }
}

function refsUnder(prefix: string): { ref: string; sha: string }[] {
  const listed = gitTry("for-each-ref", "--format=%(refname) %(objectname)", prefix) ?? "";
  return listed.split("\n").flatMap((line) => {
    const m = /^(\S+) ([0-9a-f]+)$/.exec(line);
    return m?.[1].startsWith(prefix) === true ? [{ ref: m[1], sha: m[2] }] : [];
  });
}

function updateRefs(ops: string[]): void {
  if (ops.length === 0) return;
  try {
    execFileSync("git", ["update-ref", "--stdin"], {
      input: ops.join("\n") + "\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    console.error("chapter-review: could not move the pins that keep a review's commits.");
  }
}

function moveRefs(fromPrefix: string, toPrefix: string): void {
  updateRefs(
    refsUnder(fromPrefix).flatMap(({ ref, sha }) => [
      `update ${toPrefix}${ref.slice(fromPrefix.length)} ${sha}`,
      `delete ${ref}`,
    ])
  );
}

function dropRefs(prefix: string): void {
  updateRefs(refsUnder(prefix).map(({ ref }) => `delete ${ref}`));
}
