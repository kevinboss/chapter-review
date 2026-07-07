import { gitMergeBase, gitRevParse } from "./gitContent";
import { Manifest } from "./model";

export interface Staleness {
  /** True when the reviewed diff (mergeBase..head) no longer matches the branch. */
  stale: boolean;
  /** Short label for the warning node. */
  summary?: string;
  /** Full explanation for the node tooltip: the reason and the fix. */
  detail?: string;
}

const FRESH: Staleness = { stale: false };

/** Two hex refs name the same commit if one is a prefix of the other. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/**
 * Level-0 staleness check: compares the commit the manifest was generated
 * against (headSha) and the fork point it partitioned (mergeBase) to the live
 * repo. Any divergence means the diff on disk is no longer the diff the
 * chapters describe, so recorded review progress may point at code that moved.
 *
 * Conservative by design: when a git query can't run (detached HEAD, a base ref
 * that no longer exists, git absent) that signal is skipped rather than
 * reported as stale, so the warning never fires on a false positive. A manifest
 * without headSha degrades to the merge-base check alone.
 */
export async function checkStaleness(repoRoot: string, manifest: Manifest): Promise<Staleness> {
  const liveHead = await gitRevParse(repoRoot, "HEAD");
  const liveMergeBase = await gitMergeBase(repoRoot, manifest.base, "HEAD");

  const headMoved =
    !!manifest.headSha && !!liveHead && !sameCommit(manifest.headSha, liveHead);
  const baseMoved = !!liveMergeBase && !sameCommit(manifest.mergeBase, liveMergeBase);

  if (!headMoved && !baseMoved) {
    return FRESH;
  }

  const reason =
    headMoved && baseMoved
      ? "the branch was rebased"
      : headMoved
        ? "the branch has new or amended commits"
        : "the review base has moved";

  return {
    stale: true,
    summary: "Review may be out of date",
    detail:
      `This branch changed after the chapters were generated (${reason}). ` +
      "Reviewed checkmarks may no longer match the code. " +
      "Re-run the chapter-review skill to regenerate.",
  };
}
