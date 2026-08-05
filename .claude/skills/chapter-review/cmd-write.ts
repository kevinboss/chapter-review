import { existsSync, readFileSync } from "node:fs";
import { die, isArray, isRecord, tryReadJson } from "./util.ts";
import { gitOk, gitTry, manifestPath, sameCommit, short } from "./git.ts";
import {
  carryIssues,
  carryReviewed,
  installManifest,
  issuesOf,
  priorStateForCarry,
  readProgress,
  storedIssueSeq,
  writeProgress,
  withIssues,
} from "./manifest.ts";
import { isManifest, validateManifest } from "./validate.ts";
import { branchDiff, coverageErrors } from "./diff.ts";
import type { Issue, Manifest, ManifestStats, ReviewedUnit } from "./types.ts";

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
  // `head` is only validated on the fallback path, so when headSha already
  // matches HEAD a value like "@" or "HEAD" is installed verbatim and the
  // extension shows it as the branch name. Re-pin it to the real branch.
  const head = str(draft, "head");
  if (head === undefined || HEAD_RELATIVE.test(head)) {
    const branch = gitTry("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== undefined && branch !== "HEAD") {
      if (head !== undefined) notes.push(`head ${head}->${branch}`);
      draft.head = branch;
    }
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

// Same shape validate.ts enforces, checked here too because the belongs-here
// test runs before validation — that is the point, it guards what comes next.
const SHA = /^[0-9a-f]{7,40}$/i;

function assertDraftBelongsHere(draft: Draft): void {
  const problems: string[] = [];
  // Resolve the destination first. Outside a repo this dies with "not inside a
  // git repository"; leaving it to the reporting below printed a tree-mismatch
  // block first, which misdiagnoses the problem before the real message lands.
  manifestPath();
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
  //
  // Only a literal SHA counts. `headSha: "HEAD"` resolves to whatever tree you
  // are standing in, so it proves nothing and would vouch for a draft from any
  // repository — the same reasoning that rules HEAD-relative values out of
  // `head`, and the wrong-directory footgun this check exists to stop.
  const literalSha = headSha !== undefined && SHA.test(headSha);
  const headShaHere = literalSha
    ? gitTry("rev-parse", "--verify", "--quiet", `${headSha}^{commit}`)
    : undefined;
  if (literalSha && headShaHere === liveHead) {
    return;
  }
  // Vetoes. A SHA the draft carries that this repository has never contained is
  // objective proof the draft was generated somewhere else — it is not weighed
  // against the name below, it decides. Two unrelated projects are both very
  // often on `main`, so without this the name alone would admit a foreign draft.
  //
  // One line per headSha problem, not two: a non-SHA value is also, trivially,
  // "not a commit here", and reporting both read as two separate faults.
  if (headSha !== undefined && !literalSha) {
    problems.push(`headSha "${headSha}" is not a commit id, so it cannot identify this tree`);
  } else if (headSha !== undefined && headShaHere === undefined) {
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
 * Split `write`'s argv into its optional draft path and the --dry-run switch.
 * Strict: treating a mistyped `--dry-runn` as a filename would install the draft
 * it was meant to hold back.
 */
function parseWriteArgs(argv: string[]): { file?: string; dryRun: boolean } {
  const out: { file?: string; dryRun: boolean } = { dryRun: false };
  for (const tok of argv) {
    if (tok === "--dry-run") {
      out.dryRun = true;
    } else if (tok.startsWith("--")) {
      die(`chapter-review: unknown flag "${tok}" (write takes [file] [--dry-run])`);
    } else if (out.file === undefined) {
      out.file = tok;
    } else {
      die(`chapter-review: write takes one draft path (got "${out.file}" and "${tok}")`);
    }
  }
  return out;
}

/**
 * Install a partition draft (from a file or stdin): re-pin it to the working
 * tree, carry findings and checkmarks forward, validate, then write.
 *
 * With `--dry-run` every check runs and the same report prints, but nothing is
 * written — so the claim and carry counts can be seen before they land.
 */
export function cmdWrite(argv: string[] = []): void {
  const { file: arg, dryRun } = parseWriteArgs(argv);
  const src: string | number = arg ?? 0; // fd 0 = stdin
  const parsed = tryReadJson(() => readFileSync(src, "utf8"));
  if (!parsed.ok) {
    die(`chapter-review: could not read draft (${arg ?? "stdin"}): ${parsed.error}`);
  }
  if (!isRecord(parsed.value)) {
    die("chapter-review: the draft must be a JSON object.");
  }
  const draft: Draft = parsed.value;

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
  if (!draftCheck.ok || !isManifest(draft)) {
    console.error("chapter-review: change refused, the draft is not a valid partition:");
    for (const e of draftCheck.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const coverage = assertCoversDiff(draft);
  installDraft(draft, repinned, dryRun, coverage);
}

/**
 * Refuse a partition that does not account for the whole diff. The structural
 * pass works on the manifest alone, so it can see a hunk claimed twice but not
 * one claimed by nobody — and a review missing a hunk entirely looks complete in
 * the tree, which is the failure worth a git call to prevent.
 *
 * Skipped, with a warning, when git cannot produce the diff: a coverage check
 * that cannot run must not block a write that is otherwise valid. Returns whether
 * the check actually ran, so a --dry-run can say which of the two happened rather
 * than leaving the caller to read silence as success.
 */
function assertCoversDiff(manifest: Manifest): boolean {
  const diffText = branchDiff(manifest.mergeBase);
  if (diffText === undefined) {
    console.error(
      "chapter-review: could not read the diff, so coverage was not checked; " +
        "verify yourself that every hunk is claimed."
    );
    return false;
  }
  // Nothing to review is not a review. A branch level with its base produces an
  // empty partition that is technically valid, and installing it replaced a real
  // manifest with zero chapters — the destructive half of switching branches and
  // regenerating without noticing.
  if (diffText.trim() === "") {
    die(
      `chapter-review: ${manifest.head} has no changes against ${manifest.base}, ` +
        "so there is nothing to partition.\n" +
        "  Check you are on the branch you meant to review, and that the base is right."
    );
  }
  const errors = coverageErrors(manifest, diffText);
  if (errors.length === 0) return true;
  console.error("chapter-review: change refused, the partition does not match the diff:");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    "  Every hunk belongs to exactly one chapter, or to unassigned with a reason."
  );
  process.exit(1);
}

/** The read-modify-write half of `write`, run under the manifest lock. */
function installDraft(
  asManifest: Manifest,
  repinned: string[],
  dryRun: boolean,
  coverageChecked: boolean
): void {
  const priorExisted = existsSync(manifestPath());
  const { prior, fromBackup } = priorStateForCarry();
  if (priorExisted && fromBackup) {
    console.error(
      "chapter-review: the previous manifest was unreadable; carrying findings and " +
        `checkmarks forward from the backup (${manifestPath()}.bak) instead.`
    );
  } else if (priorExisted && !prior) {
    console.error(
      "chapter-review: the previous manifest was unreadable or invalid, and the backup " +
        "could not be used either; installing the new partition. Findings could not be " +
        "carried forward; checkmarks are read separately and may still survive."
    );
  }
  // One manifest per repository, so writing while standing on another branch
  // replaces that branch's review outright. Legitimate (you moved on), but it
  // took every chapter and finding with it and said nothing.
  if (prior && prior.head !== asManifest.head) {
    console.error(
      `chapter-review: this replaces the review of "${prior.head}" ` +
        `(${prior.chapters.length} chapters, ${issuesOf(prior).length} findings) ` +
        `with one for "${asManifest.head}". The previous one is only in ${manifestPath()}.bak.`
    );
  }
  const priorIssues: Issue[] = issuesOf(prior);
  const { kept, pruned, moved, renumbered } = carryIssues(priorIssues, asManifest, prior);

  // From the issues as they were *before* pruning, so an id regeneration drops
  // is retired rather than handed out again. A draft carries no mark of its own.
  const seq = storedIssueSeq(prior, priorIssues);
  if (seq) asManifest.issueSeq = seq;

  // Carry the checkmarks forward too, pruning units whose path left the diff.
  // They live in progress.json; the manifest never carries them again.
  const priorReviewed: ReviewedUnit[] = readProgress();
  const {
    kept: carriedReviewed,
    gone: reviewedGone,
    merged: reviewedMerged,
  } = carryReviewed(priorReviewed, asManifest, prior);

  // Report how many chapter ids carried over, so an accidental full rebuild
  // (which churns ids and checkmarks) is visible rather than silent.
  const priorChapterIds = new Set((prior?.chapters ?? []).map((c) => c.id));

  const report = (stats: ManifestStats, dest: string): void => {
    const { chapters } = asManifest;
    const keptCh = chapters.filter((c) => priorChapterIds.has(c.id)).length;
    // A whole chapter disappearing was only visible by diffing two `show`s: the
    // "N/M kept" ratio moves, but nothing named the chapter that went.
    const goneChapters = [...priorChapterIds].filter(
      (id) => !chapters.some((c) => c.id === id)
    );
    // Each clause is appended only when non-zero, so a first write prints the
    // opening sentence alone. "carried", not "kept": these are rows that survived
    // path-pruning, and whether one still reads as reviewed is decided against
    // content by the extension, so "kept" would promise a check the CLI does not do.
    const clauses = [
      priorChapterIds.size > 0 && `${keptCh}/${chapters.length} chapters kept from last run`,
      goneChapters.length > 0 && `dropped ${goneChapters.join(", ")}`,
      kept.length > 0 && `${kept.length} issues preserved`,
      pruned.length > 0 && `pruned ${pruned.length} (${pruned.join(", ")})`,
      carriedReviewed.length > 0 && `${carriedReviewed.length} checkmarks carried`,
      reviewedGone > 0 && `${reviewedGone} checkmarks dropped (path left the diff)`,
      reviewedMerged > 0 && `${reviewedMerged} checkmarks folded into a merged hunk`,
    ].filter((c): c is string => typeof c === "string");
    const opening = `${dryRun ? "Would write" : "Wrote"} ${stats.chapters} chapters across ${stats.files} files (${stats.hunks} claims)`;
    console.log(`${[opening, ...clauses].join(", ")}.`);
    console.log(dryRun ? `  would write ${dest} (--dry-run: nothing changed)` : `  wrote ${dest}`);
    // On both paths, so the dry run and the real write print the same report and
    // a missing verdict never reads as a skipped check.
    console.log(
      coverageChecked
        ? "  coverage: every hunk in the diff is claimed"
        : "  coverage: NOT checked (the diff could not be read)"
    );
    const { headSha, mergeBase } = asManifest;
    if (headSha) {
      console.log(`  pinned to HEAD ${short(headSha)} (mergeBase ${short(mergeBase)})`);
    }
    if (carriedReviewed.length > 0) {
      console.log(
        "  checkmarks carry by path; the extension re-checks content and re-opens any whose bytes moved"
      );
    }
    for (const m of moved) console.log(`  followed rename ${m}`);
    // Named one per line, not counted: the reviewer may have quoted the old id
    // in a PR comment, and the mapping is the only way back to it.
    for (const r of renumbered) console.log(`  renumbered ${r}`);
    if (repinned.length > 0) {
      console.log(`  re-pinned ${repinned.join(", ")} to match the working tree`);
    }
  };

  const finalManifest = withIssues(asManifest, kept);
  if (dryRun) {
    // The validation installManifest would run, so --dry-run refuses what a real
    // write refuses.
    const check = validateManifest(finalManifest);
    if (!check.ok) {
      console.error("chapter-review: change refused, the manifest would be invalid:");
      for (const e of check.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    report(check.stats, manifestPath());
    return;
  }
  installManifest(finalManifest, report);
  // After the manifest lands, so a refused install leaves progress untouched.
  if (carriedReviewed.length > 0 || priorReviewed.length > 0) {
    writeProgress(carriedReviewed);
  }
}
