import { die } from "./util.ts";
import {
  branchLeaf,
  gitDir,
  gitOk,
  gitTry,
  lsRemoteTip,
  openChangeCount,
  resolveBase,
  sameCommit,
  snapshotWorktree,
  syncPins,
} from "./git.ts";
import { priorStateForCarry } from "./manifest.ts";
import { continuedReview, parkedReviews, parkedRoundsDir } from "./park.ts";
import { earlierRounds, knownChapters, roundBase, roundCommits } from "./rounds.ts";
import type { ParkedSummary } from "./park.ts";

/** What a worktree review covers: the open changes alone, or the branch with them. */
type WorktreeScope = "open" | "all";

function parseBaseCheckArgs(argv: string[]): { base?: string; worktree?: WorktreeScope } {
  const toks = argv.flatMap((t) => (t.startsWith("--worktree=") ? ["--worktree", t.slice("--worktree=".length)] : [t]));
  const at = toks.indexOf("--worktree");
  const scope = at === -1 ? undefined : toks[at + 1];
  if (at !== -1 && scope !== "open" && scope !== "all") {
    die(`chapter-review: --worktree takes "open" or "all" (got ${JSON.stringify(scope)})`, 2);
  }
  const rest = at === -1 ? toks : [...toks.slice(0, at), ...toks.slice(at + 2)];
  if (rest.length > 1) {
    die(`chapter-review: base-check takes one base (got ${rest.map((t) => `"${t}"`).join(", ")})`, 2);
  }
  return {
    ...(rest.length === 1 ? { base: rest[0] } : {}),
    ...(scope === "open" || scope === "all" ? { worktree: scope } : {}),
  };
}

/**
 * base-check: is the review base fresh enough to diff against? Two ways it goes
 * stale: (1) a fresher copy of the same branch already sits in the repo (local
 * `main` behind `origin/main`, or the reverse), safe to switch to with no
 * network; (2) `origin/<branch>` hasn't been fetched and the real remote moved
 * on, so merge-base(base, HEAD) lands behind commits already merged to the base
 * and the review fills with already-merged work. Reports both as an `action` the
 * skill acts on: "switch" (auto), "fetch" (ask first), "ok", or "unresolved".
 * It never fetches or touches the worktree; the skill owns those decisions.
 *
 * On "ok" it also reports the round the next `write` makes, since only then is
 * the merge base that round's diff depends on settled. When the merge base moved
 * since the last round, that means replaying the previous head onto it, which
 * creates and pins a commit inside .git.
 *
 * With `--worktree` the round is a review of the working tree instead, taken as
 * a snapshot commit inside .git. Its open-changes scope does not depend on the
 * base, so that round is reported whatever the action.
 */
export function cmdBaseCheck(argv: string[] = []): void {
  const { base: argBase, worktree } = parseBaseCheckArgs(argv);
  // A base starting with "-" would reach git as an option rather than a rev:
  // `base-check --help` otherwise renders a man page into baseSha and still
  // reports action "ok".
  if (argBase?.startsWith("-")) {
    die(`chapter-review: "${argBase}" is not a valid base ref (leading dash).`, 2);
  }
  // Every other command reports "not inside a git repository" and exits 2. Without
  // this, base-check answers "no base ref resolved", which sends the caller
  // hunting for a branch in a directory that has no repo at all.
  gitDir();
  const base = argBase ?? resolveBase();
  // Values are strings, booleans, numbers or undefined — never `any` — plus the
  // round object; the shape is documented in SKILL.md's base-check bullet.
  const result: Record<string, string | number | boolean | null | undefined | NextRound | ParkedSummary[]> = { base };
  const installed = priorStateForCarry().prior;
  result.installed = installed === null ? undefined : (installed.mode ?? "branch");
  result.openChanges = openChangeCount();
  const parked = parkedReviews();
  if (parked.length > 0) result.parked = parked;
  const emit = (): void => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  };
  if (!base) {
    result.action = "unresolved";
    result.message = "No base ref resolved (no origin/HEAD, main, or master).";
    emit(); return;
  }
  const baseSha = gitTry("rev-parse", base);
  if (!baseSha) {
    result.action = "unresolved";
    result.message = `Base ref "${base}" does not resolve.`;
    emit(); return;
  }
  result.baseSha = baseSha;
  const mergeBase = gitTry("merge-base", base, "HEAD");
  result.mergeBase = mergeBase;
  if (mergeBase !== undefined) {
    result.branchCommits = Number(gitTry("rev-list", "--count", `${mergeBase}..HEAD`)) || 0;
  }

  const leaf = branchLeaf(base);

  // (1) Local check: a counterpart ref (the local branch and the origin tracking
  // ref, minus whichever one `base` already is) whose fork point sits strictly
  // ahead of the base's. Strictly ahead = base's merge-base is an ancestor of
  // the candidate's; a candidate that's behind or diverged is not a fix.
  const candidates = [`origin/${leaf}`, leaf].filter(
    (c) => c !== base && gitOk("rev-parse", "--verify", "--quiet", c)
  );
  const fresher = candidates
    .flatMap((c) => {
      const cmb = gitTry("merge-base", c, "HEAD");
      if (!cmb || !mergeBase) return [];
      if (sameCommit(cmb, mergeBase) || !gitOk("merge-base", "--is-ancestor", mergeBase, cmb)) {
        return [];
      }
      const ahead = Number(gitTry("rev-list", "--count", `${mergeBase}..${cmb}`)) || 0;
      return [{ base: c, mergeBase: cmb, ahead }];
    })
    .reduce<{ base: string; mergeBase: string; ahead: number } | undefined>(
      (best, c) => (best === undefined || c.ahead > best.ahead ? c : best),
      undefined
    );

  // (2) Network check: does the real remote disagree with our tracking ref? A
  // differing tip means origin/<leaf> is unfetched; only a fetch moves the fork
  // point forward. Best-effort, skipped when there's no origin or it's offline.
  // Only a tracking ref that exists AND disagrees means "unfetched". A repo with
  // no refs/remotes/origin/<leaf> at all — a bare or mirror clone, or a branch
  // fetched by refspec — has nothing to compare, and calling that "unfetched"
  // makes the caller stop and prompt on an up-to-date repo.
  const remote = gitTry("remote", "get-url", "origin") ? lsRemoteTip(leaf) : undefined;
  const trackingSha = gitTry("rev-parse", `origin/${leaf}`);
  const unfetched =
    remote?.reachable === true &&
    remote.tip !== undefined &&
    trackingSha !== undefined &&
    !sameCommit(remote.tip, trackingSha);
  if (remote?.reachable === true && remote.tip !== undefined) result.remoteTip = remote.tip;
  result.remoteReachable = remote === undefined ? null : remote.reachable;

  if (fresher) {
    result.suggestedBase = fresher.base;
    result.suggestedMergeBase = fresher.mergeBase;
    result.ahead = fresher.ahead;
  }
  result.unfetched = unfetched;

  // A fetch also refreshes the tracking ref a local switch would target, so when
  // both fire prefer the fetch. `stale` is anything that isn't a clean "ok".
  if (unfetched) {
    result.action = "fetch";
    result.message =
      `origin/${leaf} differs from the remote tip (not fetched), so ` +
      `merge-base(${base}, HEAD) may sit behind commits already merged to ${leaf}. ` +
      "Fetch and regenerate against the fresh fork point, or proceed against the stale base.";
  } else if (fresher) {
    result.action = "switch";
    result.message =
      `${fresher.base} forks ${fresher.ahead} commit(s) ahead of ${base}; ` +
      "use it as the base to avoid reviewing already-merged work.";
  } else {
    result.action = "ok";
    result.message =
      remote?.reachable === false
        ? `Base ${base} looks current locally; the remote check was skipped (unreachable).`
        : `Base ${base} is current.`;
  }
  result.stale = result.action !== "ok";
  if (mergeBase !== undefined && worktree !== undefined && (result.action === "ok" || worktree === "open")) {
    result.round = worktreeRound(worktree, mergeBase);
  } else if (mergeBase !== undefined && worktree === undefined && result.action === "ok") {
    result.round = nextRound(mergeBase);
  }
  emit();
}

interface NextRound {
  number: number;
  /** False when the head has not moved, so `write` re-partitions this round. */
  new: boolean;
  /** Present on a worktree round, which the draft carries as its mode. */
  mode?: "worktree";
  fromSha: string;
  /** The snapshot a worktree round reviews, which the draft carries as its headSha. */
  headSha?: string;
  diff: string;
  replayConflicts?: string[];
  chapters: { id: string; title: string; rounds: number[]; files: string[] }[];
}

/**
 * The round a `write` at this HEAD makes, and what it partitions. When the
 * installed review is a worktree review or another branch's, the review this
 * branch goes on with is the one parked for it, which the write brings back.
 */
function nextRound(mergeBase: string): NextRound {
  const headSha = gitTry("rev-parse", "HEAD") ?? "";
  const head = gitTry("rev-parse", "--abbrev-ref", "HEAD") ?? "";
  const { prior: installed } = priorStateForCarry();
  const { prior, parkedAs } = continuedReview(installed, head, headSha);
  const { round, fresh, fromSha, replayConflicts } = roundBase(prior, head, headSha, mergeBase);
  const rounds = prior === null ? [] : [...earlierRounds(parkedAs === undefined ? undefined : parkedRoundsDir(parkedAs)), prior];
  // The installed review keeps its pins until the write parks or drops it.
  const keep = prior === installed ? rounds : installed === null ? [] : [...earlierRounds(), installed];
  syncPins(new Set([...roundCommits(keep), fromSha]));
  return {
    number: round,
    new: fresh,
    fromSha,
    diff: `git diff -M --unified=3 ${fromSha}..HEAD`,
    ...(replayConflicts.length > 0 ? { replayConflicts } : {}),
    chapters: knownChapters(rounds),
  };
}

/**
 * The worktree round a `write` makes now: one round over a snapshot of the
 * working tree, from HEAD for the open changes alone or from the merge base for
 * the branch with them. Re-running over an installed worktree review
 * re-partitions it against a fresh snapshot.
 */
function worktreeRound(scope: WorktreeScope, mergeBase: string): NextRound {
  const snapshot = snapshotWorktree();
  if (snapshot === undefined) {
    die("chapter-review: could not take a snapshot of the working tree (git add or commit-tree failed).");
  }
  const head = gitTry("rev-parse", "--abbrev-ref", "HEAD") ?? "";
  const fromSha = scope === "open" ? (gitTry("rev-parse", "HEAD") ?? "") : mergeBase;
  const { prior } = priorStateForCarry();
  const same = prior?.mode === "worktree" && prior.head === head ? prior : null;
  return {
    number: 1,
    new: !(same !== null && sameCommit(same.headSha, snapshot) && sameCommit(same.fromSha, fromSha)),
    mode: "worktree",
    fromSha,
    headSha: snapshot,
    diff: `git diff -M --unified=3 ${fromSha}..${snapshot}`,
    chapters: knownChapters(same === null ? [] : [same]),
  };
}
