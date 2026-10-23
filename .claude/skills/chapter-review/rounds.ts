// Review rounds. The first write on a branch partitions the whole branch; once
// the author pushes and the head moves, the next write starts a new round that
// partitions only what changed since the previous one. Earlier rounds stay
// readable under rounds/<n>/, each with the checkmarks made in it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorMessage, withoutUndefined } from "./util.ts";
import {
  GIT_MAX_BUFFER,
  gitTry,
  progressPath,
  roundManifestPath,
  roundProgressPath,
  roundsDir,
  sameCommit,
  short,
} from "./git.ts";
import { allEntries, readManifestIfValid, writeJsonFile } from "./manifest.ts";
import type { Manifest } from "./types.ts";

/** The round a write at the current head makes, and the diff it partitions. */
export interface RoundBase {
  round: number;
  /** True when this write starts the round rather than re-partitioning it. */
  fresh: boolean;
  fromSha: string;
  replayConflicts: string[];
}

/**
 * Which round a write of branch `head` at `headSha` makes, given the manifest
 * now installed. Same head as before: the same round, re-partitioned. Another
 * branch, or none yet: round 1 over the whole branch. Otherwise the next round,
 * diffed from the previous head, replayed onto the new merge base when the author
 * rebased, so the round holds the author's changes and not the base's.
 */
export function roundBase(
  prior: Manifest | null,
  head: string,
  headSha: string,
  mergeBase: string
): RoundBase {
  if (prior?.head !== head) {
    return { round: 1, fresh: true, fromSha: mergeBase, replayConflicts: [] };
  }
  if (sameCommit(prior.headSha, headSha)) {
    return prior.round === 1
      ? { round: 1, fresh: false, fromSha: mergeBase, replayConflicts: [] }
      : {
          round: prior.round,
          fresh: false,
          fromSha: prior.fromSha,
          replayConflicts: prior.replayConflicts ?? [],
        };
  }
  const round = prior.round + 1;
  if (sameCommit(prior.mergeBase, mergeBase)) {
    return { round, fresh: true, fromSha: prior.headSha, replayConflicts: [] };
  }
  return { round, fresh: true, ...replayOnto(prior.headSha, prior.mergeBase, mergeBase) };
}

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * `oldHead` replayed onto `newBase`: the previous round's tree with the base's
 * own changes merged in, committed so it can be diffed and pinned like any other
 * commit. A file the merge conflicts on keeps its `oldHead` version instead, so
 * its round diff also shows what the base changed; those paths are returned.
 *
 * The commit's identity and dates are fixed, so replaying the same heads again
 * yields the same id: `round` prints it before the partition is built and
 * `write` arrives at it again.
 */
function replayOnto(
  oldHead: string,
  oldBase: string,
  newBase: string
): { fromSha: string; replayConflicts: string[] } {
  const merged = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "--merge-base", oldBase, newBase, oldHead],
    { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }
  );
  if (merged.status !== 0 && merged.status !== 1) {
    console.error(
      `chapter-review: could not replay ${short(oldHead) ?? oldHead} onto the new merge base, ` +
        "so this round is diffed from the previous head as it was and also shows what the base changed."
    );
    return { fromSha: oldHead, replayConflicts: [] };
  }
  const [mergedTree, ...rest] = merged.stdout.trim().split("\n");
  const conflicts = merged.status === 1 ? rest.filter((p) => p !== "") : [];
  const tree = conflicts.length === 0 ? mergedTree : keepOldVersions(mergedTree, oldHead, conflicts);
  const when = git(["log", "-1", "--format=%cI", oldHead]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "chapter-review",
    GIT_AUTHOR_EMAIL: "chapter-review@localhost",
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: "chapter-review",
    GIT_COMMITTER_EMAIL: "chapter-review@localhost",
    GIT_COMMITTER_DATE: when,
  };
  const message = `chapter-review: ${oldHead} replayed onto ${newBase}`;
  const fromSha = git(["commit-tree", tree, "-p", newBase, "-m", message], env);
  return { fromSha, replayConflicts: conflicts };
}

/** `tree` with each of `paths` put back to its version in `oldHead`, or removed if it had none. */
function keepOldVersions(tree: string, oldHead: string, paths: string[]): string {
  const index = path.join(tmpdir(), `chapter-review-index-${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(["read-tree", tree], env);
    for (const p of paths) {
      const entry = gitTry("ls-tree", oldHead, "--", p);
      const m = entry === undefined ? null : /^(\d+) blob ([0-9a-f]+)\t/.exec(entry);
      git(
        m ? ["update-index", "--add", "--cacheinfo", `${m[1]},${m[2]},${p}`] : ["update-index", "--force-remove", "--", p],
        env
      );
    }
    return git(["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
  }
}

/** The archived rounds, oldest first; unreadable ones are skipped. */
export function earlierRounds(): Manifest[] {
  const dir = roundsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .map((name) => readManifestIfValid(roundManifestPath(Number(name))))
    .filter((m): m is Manifest => m !== null)
    .sort((a, b) => a.round - b.round);
}

/**
 * Keep `prior` as an earlier round: its partition without the findings, which
 * stay in the current manifest with their round recorded, and the checkmarks
 * made in it, which the extension goes on writing there.
 */
export function archiveRound(prior: Manifest): void {
  const partition = withoutUndefined({ ...prior, issues: undefined, issueSeq: undefined });
  writeJsonFile(roundManifestPath(prior.round), partition, `round ${String(prior.round)}`);
  const progress = progressPath();
  if (!existsSync(progress)) return;
  try {
    mkdirSync(path.dirname(roundProgressPath(prior.round)), { recursive: true });
    renameSync(progress, roundProgressPath(prior.round));
  } catch (e) {
    console.error(
      `chapter-review: could not keep round ${String(prior.round)}'s checkmarks: ${errorMessage(e)}`
    );
  }
}

/** Drop every earlier round: they belong to a review of another branch. */
export function clearRounds(): void {
  rmSync(roundsDir(), { recursive: true, force: true });
}

/** Every commit a round's diff is read from, which must stay reachable. */
export function roundCommits(rounds: Manifest[]): Set<string> {
  return new Set(rounds.flatMap((m) => [m.mergeBase, m.fromSha, m.headSha]));
}

/**
 * The chapters across all rounds, latest title first, with the files each has
 * held. What a new round's partition reuses ids from.
 */
export function knownChapters(rounds: Manifest[]): { id: string; title: string; rounds: number[]; files: string[] }[] {
  const byId = new Map<string, { id: string; title: string; rounds: number[]; files: Set<string> }>();
  for (const m of rounds) {
    for (const ch of m.chapters) {
      const known = byId.get(ch.id) ?? { id: ch.id, title: ch.title, rounds: [], files: new Set<string>() };
      known.title = ch.title;
      known.rounds.push(m.round);
      for (const f of ch.files) known.files.add(f.path);
      byId.set(ch.id, known);
    }
  }
  return [...byId.values()].map((c) => ({ ...c, files: [...c.files] }));
}

/** The latest round whose diff holds `p`, current one included. */
export function roundHolding(rounds: Manifest[], p: string): Manifest | undefined {
  return [...rounds].reverse().find((m) => allEntries(m).some((f) => f.path === p));
}
