import { die } from "./util.ts";
import { branchLeaf, gitDir, gitOk, gitTry, lsRemoteTip, resolveBase, sameCommit } from "./git.ts";

/**
 * base-check: is the review base fresh enough to diff against? Two ways it goes
 * stale: (1) a fresher copy of the same branch already sits in the repo (local
 * `main` behind `origin/main`, or the reverse), safe to switch to with no
 * network; (2) `origin/<branch>` hasn't been fetched and the real remote moved
 * on, so merge-base(base, HEAD) lands behind commits already merged to the base
 * and the review fills with already-merged work. Reports both as an `action` the
 * skill acts on: "switch" (auto), "fetch" (ask first), "ok", or "unresolved".
 * Read-only: it never fetches or writes; the skill owns those decisions.
 */
export function cmdBaseCheck(argBase?: string): void {
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
  // Values are strings, booleans, numbers or undefined — never `any`; the shape
  // is documented in SKILL.md's base-check bullet.
  const result: Record<string, string | number | boolean | null | undefined> = { base };
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
  emit();
}
