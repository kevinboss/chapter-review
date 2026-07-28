import { existsSync, readFileSync } from "node:fs";
import { die, isArray, isRecord } from "./util.ts";
import { gitOk, gitTry, manifestPath, sameCommit, short } from "./git.ts";
import {
  carryIssues,
  carryReviewed,
  installManifest,
  readManifestIfValid,
  readProgress,
  writeProgress,
  withIssues,
} from "./manifest.ts";
import { validateManifest } from "./validate.ts";
import type { Issue, Manifest, ReviewedUnit } from "./types.ts";

/** A draft as it arrives from outside: a JSON object whose shape is unverified. */
type Draft = Record<string, unknown>;

/** The draft's value for a key, when it is a string. */
const str = (draft: Draft, key: string): string | undefined =>
  typeof draft[key] === "string" ? draft[key] : undefined;

/**
 * Re-pin the manifest to the commit `write` observes. The extension decides
 * staleness by comparing manifest.headSha against `git rev-parse HEAD` and
 * manifest.mergeBase against `git merge-base <base> HEAD`, and it reconstructs
 * every chapter diff (and the review-progress digests) from those same two
 * refs. Deriving both here from live git (mergeBase from the draft's own base,
 * so both sides run the identical merge-base) means a regeneration lands pinned
 * to the current commit: the "out of date" banner clears and the diffs render
 * against the blobs the hunks describe. Live git wins over whatever the draft
 * carried; a query that can't run (detached HEAD, base ref gone, git absent)
 * falls back to the draft value so the pin is never dropped. generatedAt is
 * stamped to now. Returns notes for any pin git moved off the draft's value.
 */
export function repinCommits(draft: unknown): string[] {
  if (!isRecord(draft)) return [];
  const notes: string[] = [];
  const liveHead = gitTry("rev-parse", "HEAD");
  if (liveHead) {
    const drafted = str(draft, "headSha");
    if (drafted && !sameCommit(drafted, liveHead)) {
      notes.push(`headSha ${short(drafted)}->${short(liveHead)}`);
    }
    draft.headSha = liveHead;
  }
  const base = str(draft, "base");
  const liveMergeBase = base ? gitTry("merge-base", base, "HEAD") : undefined;
  if (liveMergeBase) {
    const drafted = str(draft, "mergeBase");
    if (drafted && !sameCommit(drafted, liveMergeBase)) {
      notes.push(`mergeBase ${short(drafted)}->${short(liveMergeBase)}`);
    }
    draft.mergeBase = liveMergeBase;
  }
  draft.generatedAt = new Date().toISOString();
  return notes;
}

/**
 * Refuse a draft that describes a different repository than the one we are about
 * to write into.
 *
 * The manifest destination comes from the cwd, not from where this command
 * lives, so running it one directory too high installs a partition over another
 * repo's review state — atomically, with its findings pruned and no way back.
 * Three signals catch that without parsing the diff: the draft's `head` naming
 * no ref here, its `mergeBase` naming no commit here, and its `base` not
 * resolving. Checked before re-pinning, because re-pinning overwrites exactly
 * the values that carry the evidence.
 *
 * Skipped in a repo with no commits, where nothing resolves for honest reasons.
 */
// HEAD, @, HEAD^0, @{0}, HEAD~0, HEAD^{commit} … all resolve to whatever tree
// you are standing in, so they can never testify that a draft belongs here.
const HEAD_RELATIVE = /^(HEAD|@)([\^~]|@\{|$)/;

function assertDraftBelongsHere(draft: Draft): void {
  const problems: string[] = [];
  const liveHead = gitTry("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  const head = str(draft, "head");
  const headSha = str(draft, "headSha");
  const mergeBase = str(draft, "mergeBase");

  if (liveHead === undefined) {
    // No checked-out commit: an empty repo, an unborn branch, or a HEAD left
    // pointing at a deleted ref. Nothing here is reviewable and nothing can
    // vouch for the draft, so there is no safe way to proceed.
    console.error("chapter-review: this draft does not describe the tree you are in.");
    console.error("  HEAD does not resolve here, so there is nothing to review against");
    console.error(`  cwd            ${process.cwd()}`);
    console.error(`  would write to ${manifestPath()}`);
    process.exit(1);
  }

  // Does the draft's headSha name the commit checked out here? This is the
  // strongest possible evidence, and it settles the case on its own: a draft
  // whose headSha *is* this commit belongs here even if its branch was since
  // renamed, or its merge base has since been pruned.
  const headShaHere =
    headSha === undefined
      ? undefined
      : gitTry("rev-parse", "--verify", "--quiet", `${headSha}^{commit}`);
  if (headSha !== undefined && headShaHere === liveHead) {
    return;
  }

  // Vetoes. A SHA the draft carries that this repository has never contained is
  // objective proof the draft was generated somewhere else — it is not weighed
  // against the name below, it decides. Two unrelated projects are both very
  // often on `main`, so without this the name alone would admit a foreign draft.
  if (headSha !== undefined && headShaHere === undefined) {
    problems.push(`headSha ${short(headSha) ?? "?"} is not a commit here`);
  }
  if (mergeBase !== undefined && !gitOk("cat-file", "-e", `${mergeBase}^{commit}`)) {
    problems.push(`mergeBase ${short(mergeBase) ?? "?"} is not a commit here`);
  }

  // Otherwise the draft's `head` has to name the checked-out commit. Only a real
  // ref counts: resolved refs/heads-first, because a bare lookup prefers a tag
  // and would report a same-named branch as pointing at the tag's commit.
  if (problems.length === 0) {
    if (head === undefined || HEAD_RELATIVE.test(head)) {
      problems.push(
        `the draft's head "${head ?? "?"}" does not identify a commit, and its headSha does not match this tree`
      );
    } else {
      const ref =
        gitTry("rev-parse", "--symbolic-full-name", "--verify", "--quiet", `refs/heads/${head}`) ??
        gitTry("rev-parse", "--symbolic-full-name", "--verify", "--quiet", head);
      const at = ref?.startsWith("refs/")
        ? gitTry("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
        : undefined;
      if (at === liveHead) {
        return;
      }
      problems.push(
        at === undefined
          ? `head "${head}" does not name a ref in this repo`
          : `the draft's head "${head}" is ${short(at) ?? "?"}, but this tree is checked out at ${short(liveHead) ?? "?"}`
      );
    }
  }

  const base = str(draft, "base");
  if (base !== undefined && !gitOk("rev-parse", "--verify", "--quiet", base)) {
    problems.push(`base "${base}" does not resolve here`);
  }
  console.error("chapter-review: this draft does not describe the tree you are in.");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`  cwd            ${process.cwd()}`);
  console.error(`  would write to ${manifestPath()}`);
  console.error(
    "  Regenerate the draft here, or re-run from the tree it describes. " +
      "Mid-rebase or mid-bisect, finish or abort that first."
  );
  process.exit(1);
}

/**
 * Install a partition draft (from a file or stdin): re-pin it to the working
 * tree, carry findings and checkmarks forward, validate, then write.
 */
export function cmdWrite(arg?: string): void {
  const src: string | number = arg ?? 0; // fd 0 = stdin
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(src, "utf8")) as unknown;
  } catch (e) {
    die(`chapter-review: could not read draft (${arg ?? "stdin"}): ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) {
    die("chapter-review: the draft must be a JSON object.");
  }
  const draft: Draft = parsed;

  const draftIssues = draft.issues;
  if (isArray(draftIssues) && draftIssues.length > 0) {
    die(
      "chapter-review: `write` takes the partition only. Record findings with " +
        "`chapter-review issue add`; existing issues are preserved."
    );
  }
  const draftReviewed = draft.reviewed;
  if (isArray(draftReviewed) && draftReviewed.length > 0) {
    die(
      "chapter-review: `write` takes the partition only. Review checkmarks are " +
        "carried forward; don't put a `reviewed` array in the draft."
    );
  }

  assertDraftBelongsHere(draft);

  // Pin to the working tree before validating/installing, so the manifest that
  // lands matches what the extension will compare it against.
  const repinned = repinCommits(draft);

  // Refuse an invalid draft here rather than leaning on installManifest to catch
  // it later. Carrying walks the draft's chapters and file entries, so it needs a
  // sound shape; but skipping the carry and letting the install refuse does not
  // work, because withIssues() rebuilds the manifest from a fixed key list and
  // normalises away exactly the errors that would have triggered the refusal —
  // an unknown top-level key, say. The write would then succeed having silently
  // dropped every finding and checkmark.
  const draftCheck = validateManifest(draft);
  if (!draftCheck.ok) {
    console.error("chapter-review: change refused, the draft is not a valid partition:");
    for (const e of draftCheck.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  installDraft(draft, repinned);
}

/** The read-modify-write half of `write`, run under the manifest lock. */
function installDraft(draft: Draft, repinned: string[]): void {
  const asManifest = draft as unknown as Manifest;
  const priorExisted = existsSync(manifestPath());
  const prior = readManifestIfValid();
  if (priorExisted && !prior) {
    console.error(
      "chapter-review: the previous manifest was unreadable or invalid; " +
        "installing the new partition, but no findings or checkmarks could be carried forward."
    );
  }
  const priorIssues: Issue[] = prior?.issues ?? [];
  const { kept, pruned } = carryIssues(priorIssues, asManifest);

  // Carry the checkmarks forward too, pruning units whose path left the diff.
  // They live in progress.json; the manifest never carries them again.
  const priorReviewed: ReviewedUnit[] = readProgress(prior);
  const carriedReviewed = carryReviewed(priorReviewed, asManifest);
  delete draft.reviewed;

  // Report how many chapter ids carried over, so an accidental full rebuild
  // (which churns ids and checkmarks) is visible rather than silent.
  const priorChapterIds = new Set((prior?.chapters ?? []).map((c) => c.id));

  installManifest(withIssues(asManifest, kept), (stats, dest) => {
    let line = `Wrote ${stats.chapters} chapters across ${stats.files} files (${stats.hunks} claims)`;
    if (priorChapterIds.size > 0) {
      const { chapters } = asManifest;
      const keptCh = chapters.filter((c) => priorChapterIds.has(c.id)).length;
      line += `, ${keptCh}/${chapters.length} chapters kept from last run`;
    }
    if (kept.length > 0) line += `, ${kept.length} issues preserved`;
    if (pruned.length > 0) line += `, pruned ${pruned.length} (${pruned.join(", ")})`;
    if (carriedReviewed.length > 0) line += `, ${carriedReviewed.length} checkmarks kept`;
    console.log(`${line}.`);
    console.log(`  wrote ${dest}`);
    const { headSha, mergeBase } = asManifest;
    if (headSha) {
      console.log(`  pinned to HEAD ${short(headSha)} (mergeBase ${short(mergeBase)})`);
    }
    if (repinned.length > 0) {
      console.log(`  re-pinned ${repinned.join(", ")} to match the working tree`);
    }
  });
  // After the manifest lands, so a refused install leaves progress untouched.
  if (carriedReviewed.length > 0 || priorReviewed.length > 0) {
    writeProgress(carriedReviewed);
  }
}
