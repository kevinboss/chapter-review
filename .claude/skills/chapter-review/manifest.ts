// The manifest data model: read it, validate-and-install it, and the pure
// helpers that resolve issue ownership and carry findings and checkmarks
// forward across a regeneration.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { die, errorMessage, isArray, isRecord, tryReadJson, withoutUndefined } from "./util.ts";
import { manifestPath, progressPath } from "./git.ts";
import { isManifest, validateManifest } from "./validate.ts";
import type { FileEntry, Hunk, Issue, Manifest, ManifestStats, Progress, ReviewedUnit } from "./types.ts";
/**
 * Read the stored manifest if it is present, parseable and valid; null otherwise.
 *
 * The file is not trustworthy just because installManifest validated what it
 * wrote: the extension writes it too, a user can edit it, a partial write can
 * truncate it, and an older release may have left a different shape. Callers
 * that can carry on without it use this and treat null as "no prior state".
 */
export function readManifestIfValid(path = manifestPath()): Manifest | null {
  if (!existsSync(path)) return null;
  const parsed = tryReadJson(() => readFileSync(path, "utf8"));
  if (!parsed.ok) return null;
  return isManifest(parsed.value) ? parsed.value : null;
}

/**
 * The prior state to carry findings and checkmarks from: the manifest, or the
 * rolling backup when the manifest is unreadable.
 *
 * Preserving a good `.bak` and then not reading it threw away recoverable
 * findings with the backup sitting next to them, and the regenerating write is
 * exactly the moment they would have come back.
 */
export function priorStateForCarry(): { prior: Manifest | null; fromBackup: boolean } {
  const prior = readManifestIfValid();
  if (prior) return { prior, fromBackup: false };
  const fromBak = readManifestIfValid(`${manifestPath()}.bak`);
  return { prior: fromBak, fromBackup: fromBak !== null };
}

/**
 * Read the manifest for a command that cannot proceed without it, exiting with
 * an actionable message when it is missing, unparseable or invalid. Validating
 * here is what makes the returned `Manifest` type honest — without it the cast
 * would be a promise the file cannot keep, and corrupt state would surface as a
 * TypeError deep in a helper instead of a diagnosis.
 */
export function readManifestOrDie(): Manifest {
  const p = manifestPath();
  if (!existsSync(p)) {
    die(
      "chapter-review: no manifest yet; run `chapter-review write` first."
    );
  }
  const parsed = tryReadJson(() => readFileSync(p, "utf8"));
  if (!parsed.ok) {
    die(`chapter-review: existing manifest is not valid JSON: ${parsed.error}`);
  }
  const result = validateManifest(parsed.value);
  if (!result.ok || !isManifest(parsed.value)) {
    console.error(`chapter-review: the stored manifest is invalid (${p}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error("  Regenerate it with `chapter-review write`, or delete it to start over.");
    process.exit(1);
  }
  return parsed.value;
}

/**
 * Refresh the single rolling backup, immediately before the swap. Every install
 * is a whole-file replacement, so without this an overwrite is final.
 *
 * The old copy is removed rather than overwritten in place: copyFileSync follows
 * a symlink at the destination, so a `chapters.json.bak` pointing anywhere else
 * would write this manifest through it — over another repo's manifest, or over a
 * tracked worktree file.
 *
 * Failure is reported and swallowed. The backup is a convenience; a hostile or
 * unwritable one must not take the actual write down with it.
 *
 * A corrupt current file is left un-backed-up rather than copied over the last
 * good one. Otherwise the recovery path destroys itself: truncate chapters.json,
 * run `write` to rebuild, and that write first copies the truncated file over
 * the backup holding the findings you were about to restore.
 */
function backup(dest: string): void {
  if (!existsSync(dest)) return;
  const bak = `${dest}.bak`;
  if (!readManifestIfValid()) {
    console.error(
      `chapter-review: the manifest being replaced is unreadable; keeping the previous backup (${bak}).`
    );
    return;
  }
  try {
    rmSync(bak, { force: true, recursive: true });
    copyFileSync(dest, bak);
  } catch (e) {
    console.error(
      `chapter-review: could not refresh the backup (${bak}): ${errorMessage(e)}`
    );
  }
}

/**
 * Validate then write the manifest, via a temp file and rename so the
 * extension's watcher never sees a half-file. An invalid manifest is refused,
 * never written. `onOk` runs with the validator's stats and the written path.
 */
export function installManifest(
  manifest: Manifest,
  onOk: (stats: ManifestStats, dest: string) => void
): void {
  const result = validateManifest(manifest);
  if (!result.ok) {
    console.error("chapter-review: change refused, the manifest would be invalid:");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const dest = manifestPath();
  // Per-process temp name, not a fixed `${dest}.tmp`. With a shared name, two
  // concurrent invocations open the same inode; whichever renames first turns
  // that inode INTO chapters.json, so the other is still writing into the live
  // file — readers see truncated or zero-length JSON, and the loser's rename
  // fails with ENOENT. A unique name also means a pre-created symlink at the
  // predictable path can no longer redirect the write.
  const tmp = `${dest}.${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}.tmp`;
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    // "wx" refuses to follow or clobber anything already at the temp path.
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    backup(dest);
    renameSync(tmp, dest);
  } catch (e) {
    // Best-effort cleanup: if the temp path is itself the problem (its parent is
    // a file, say) rmSync throws, and an exception here would replace the real
    // diagnosis with a stack trace.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing useful to do */
    }
    die(`chapter-review: could not write the manifest (${dest}): ${errorMessage(e)}`);
  }
  onOk(result.stats, dest);
}

// ---- issue ownership / remapping -------------------------------------------

/** Do two spans [start, start+len) overlap? Zero-length spans never overlap. */
export function spansOverlap(startA: number, lenA: number, startB: number, lenB: number): boolean {
  if (lenA === 0 || lenB === 0) return false;
  return startA < startB + lenB && startB < startA + lenA;
}
/** Do two hunks overlap on either their old or their new line range? */
export function hunksOverlap(a: Hunk, b: Hunk): boolean {
  return (
    spansOverlap(a.newStart, a.newLines, b.newStart, b.newLines) ||
    spansOverlap(a.oldStart, a.oldLines, b.oldStart, b.oldLines)
  );
}
/** Are two hunks the same range? False if either is absent. */
export function hunkEquals(a?: Hunk, b?: Hunk): boolean {
  return (
    !!a &&
    !!b &&
    a.oldStart === b.oldStart &&
    a.oldLines === b.oldLines &&
    a.newStart === b.newStart &&
    a.newLines === b.newLines
  );
}

/** Every file entry, across chapters and unassigned. */
export function allEntries(manifest: Manifest): FileEntry[] {
  return [...manifest.chapters.flatMap((ch) => ch.files), ...manifest.unassigned];
}

/** Does `p` appear in any chapter or in unassigned? */
export function pathInManifest(manifest: Manifest, p: string): boolean {
  return allEntries(manifest).some((f) => f.path === p);
}

/**
 * What `p` was called at the merge base, according to `manifest`. A renamed
 * entry reports its `oldPath`; anything else is already merge-base-relative.
 */
function originOf(manifest: Manifest | null | undefined, p: string): string {
  if (!manifest) return p;
  const entry = allEntries(manifest).find((f) => f.path === p);
  return entry?.oldPath ?? p;
}

/**
 * Where `p` lives in this manifest now, following a rename through `oldPath`.
 * Undefined when the path is genuinely gone.
 *
 * Carry-forward matched on the path string alone, so a rename read as a
 * deletion: `git mv` destroyed the file's findings and every checkmark on it,
 * reported as "path left the diff". Recording `oldPath` is what makes the move
 * followable, and it is the whole reason the schema carries the field.
 *
 * `prior` is what makes a *second* rename work. Every diff is taken against the
 * merge base, so once a file has moved twice git reports the original name and
 * the newest one — the intermediate never appears, and matching the stored path
 * alone loses the file again. Resolving through the previous manifest recovers
 * the merge-base name the two generations have in common.
 */
export function currentPathFor(
  manifest: Manifest,
  p: string,
  prior?: Manifest | null
): string | undefined {
  const entries = allEntries(manifest);
  if (entries.some((f) => f.path === p)) return p;
  const direct = entries.find((f) => f.oldPath === p)?.path;
  if (direct !== undefined) return direct;
  const origin = originOf(prior, p);
  return origin === p ? undefined : entries.find((f) => f.oldPath === origin)?.path;
}

/**
 * Which chapter should own an issue on `path` (with optional `hunk`)? Prefer a
 * still-valid prior chapterId for stability; otherwise the sole owner; on a
 * split path, the chapter whose hunks overlap; else best-effort first owner.
 * Returns undefined when the path lives only in unassigned or nowhere.
 */
export function ownerChapterId(
  manifest: Manifest,
  p: string,
  hunk?: Hunk,
  prevChapterId?: string
): string | undefined {
  const owners = manifest.chapters.filter((ch) =>
    ch.files.some((f) => f.path === p)
  );
  if (owners.length === 0) return undefined;
  if (owners.length === 1) return owners[0].id;
  if (prevChapterId && owners.some((c) => c.id === prevChapterId)) {
    return prevChapterId;
  }
  if (hunk) {
    const match = owners.find((ch) =>
      ch.files.some(
        (f) => f.path === p && f.hunks?.some((h) => hunksOverlap(h, hunk))
      )
    );
    if (match) return match.id;
  }
  return owners[0].id;
}

/**
 * Carry issues from the old manifest into a freshly written partition: follow a
 * renamed path to where it landed, re-key the hunk onto the range that now
 * covers it, drop any whose path is genuinely gone, and re-point chapterId at
 * the new owner.
 *
 * Re-keying for the same reason checkmarks get it: an edit above a finding moves
 * the range it was anchored to, and a stale anchor sends the extension to the
 * wrong lines. Left alone it never self-corrects — a coordinate a couple of
 * lines out survives every later regeneration, since nothing else touches it.
 */
export function carryIssues(
  oldIssues: Issue[],
  newManifest: Manifest,
  prior?: Manifest | null
): { kept: Issue[]; pruned: string[]; moved: string[] } {
  const kept: Issue[] = [];
  const pruned: string[] = [];
  const moved: string[] = [];
  for (const issue of oldIssues) {
    const path = currentPathFor(newManifest, issue.path, prior);
    if (path === undefined) {
      pruned.push(issue.id);
      continue;
    }
    if (path !== issue.path) moved.push(`${issue.id}: ${issue.path} -> ${path}`);
    const hunk = issue.hunk === undefined ? undefined : rekey(newManifest, path, issue.hunk);
    const chapterId = ownerChapterId(newManifest, path, hunk, issue.chapterId);
    kept.push(withoutUndefined({ ...issue, path, hunk, chapterId }));
  }
  return { kept, pruned, moved };
}

/**
 * The highest `iss-N` ever allocated: the recorded mark, or the largest live id
 * if that is higher (a manifest predating issueSeq). Deriving it from the live
 * ids alone would recycle the number of a removed finding.
 */
export function issueHighWater(
  manifest: Manifest | null | undefined,
  issues: Issue[]
): number {
  const recorded = typeof manifest?.issueSeq === "number" ? manifest.issueSeq : 0;
  return issues.reduce((m, i) => {
    const n = Number((/^iss-(\d+)$/.exec(i.id) ?? [])[1]);
    return Number.isInteger(n) && n > m ? n : m;
  }, recorded);
}

/** The next free `iss-N` id, one past the highest number ever allocated. */
export function nextIssueId(manifest: Manifest | undefined, issues: Issue[]): string {
  return `iss-${issueHighWater(manifest, issues) + 1}`;
}

/** Read the reviewer's checkmarks from progress.json. */
export function readProgress(): ReviewedUnit[] {
  const p = progressPath();
  if (!existsSync(p)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (isRecord(parsed) && parsed.version === 1 && isArray(parsed.reviewed)) {
      return parsed.reviewed.filter(isReviewedUnit);
    }
    console.error(`chapter-review: ${p} is not review progress this version understands; replacing it.`);
  } catch {
    // The count cannot be reported: unreadable is exactly what happened.
    console.error(
      `chapter-review: ${p} is unreadable, so every checkmark it held is lost; replacing it.`
    );
  }
  // Replaced rather than left in place: reporting the loss and leaving the bad
  // bytes there makes every later run repeat the warning.
  writeProgress([]);
  return [];
}

const isReviewedUnit = (u: unknown): u is ReviewedUnit =>
  isRecord(u) && typeof u.path === "string" && typeof u.digest === "string";

/**
 * Write the checkmarks. Same temp-then-rename as the manifest, so a reader never
 * sees a half-file; no lock, because nothing else writes this document.
 */
export function writeProgress(reviewed: ReviewedUnit[]): void {
  const dest = progressPath();
  const doc: Progress = { version: 1, reviewed };
  const tmp = `${dest}.${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}.tmp`;
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    renameSync(tmp, dest);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing useful to do */
    }
    die(`chapter-review: could not write review progress (${dest}): ${errorMessage(e)}`);
  }
}

/**
 * The range in the new partition that covers `stored`, or `stored` unchanged.
 *
 * Matched on the **old** side first, because that is the one an edit elsewhere
 * does not move: inserting lines above renumbers the new side only, so a stale
 * new-span can collide with a neighbouring range and re-key onto the wrong
 * chapter's hunk. The new side is the fallback for a unit that has no old side
 * at all, which is every hunk of an added file.
 */
function rekey(manifest: Manifest, path: string, stored: Hunk): Hunk {
  const ranges = allEntries(manifest)
    .filter((e) => e.path === path)
    .flatMap((e) => e.hunks ?? []);
  const byOld = ranges.find((r) =>
    spansOverlap(r.oldStart, r.oldLines, stored.oldStart, stored.oldLines)
  );
  const byNew = ranges.find((r) =>
    spansOverlap(r.newStart, r.newLines, stored.newStart, stored.newLines)
  );
  return byOld ?? byNew ?? stored;
}

/**
 * Carry checkmarks into a freshly written partition: follow a rename to the path
 * the file landed on, re-key a hunk onto the range that now covers it, and drop
 * units whose path is genuinely gone.
 *
 * Re-keying matters because the extension looks a unit up by path *and* hunk. A
 * checkmark whose coordinates shifted (an edit above it, or a neighbouring hunk
 * merging into it) no longer matches any range in the new manifest, so it went
 * unreviewed even with its content untouched — the opposite of what keying
 * progress by content digest is for. The digest itself travels unchanged and
 * still decides the outcome: identical content stays ticked, changed content
 * re-opens.
 */
export function carryReviewed(
  oldReviewed: ReviewedUnit[],
  newManifest: Manifest,
  prior?: Manifest | null
): { kept: ReviewedUnit[]; gone: number; merged: number } {
  const out: ReviewedUnit[] = [];
  const taken = new Set<string>();
  // Two ways a checkmark stops existing, reported apart: its path really left
  // the diff, or two hunks merged and its row now names the same unit as
  // another. Counting both as "path left the diff" said something untrue.
  const counts = { gone: 0, merged: 0 };
  for (const u of oldReviewed) {
    if (typeof u.path !== "string") continue;
    const path = currentPathFor(newManifest, u.path, prior);
    if (path === undefined) {
      counts.gone += 1;
      continue;
    }
    const hunk = u.hunk === undefined ? undefined : rekey(newManifest, path, u.hunk);
    // Two old ranges can land on one new range when hunks merge; the first wins.
    const key = `${path}\0${hunk ? `${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}` : ""}`;
    if (taken.has(key)) {
      counts.merged += 1;
      continue;
    }
    taken.add(key);
    out.push(hunk ? { ...u, path, hunk } : { ...u, path });
  }
  return { kept: out, ...counts };
}

/**
 * Drop optional fields already at their default, so one state has one stored
 * form. `resolve`/`reopen` and `verify`/`unverify` assign unconditionally, which
 * otherwise leaves a round-tripped finding spelled differently from an untouched
 * one. Every reader already treats absence as the default.
 */
function canonicalIssue(issue: Issue): Issue {
  return withoutUndefined({
    ...issue,
    status: issue.status === "open" ? undefined : issue.status,
    confidence: issue.confidence === "suspected" ? undefined : issue.confidence,
  });
}

/**
 * Assemble a manifest for output with a stable key order and issues last,
 * preserving any review checkmarks through the write.
 */
export function withIssues(manifest: Manifest, issues: Issue[]): Manifest {
  const out: Manifest = {
    version: manifest.version,
    base: manifest.base,
    head: manifest.head,
    mergeBase: manifest.mergeBase,
    ...(manifest.headSha !== undefined ? { headSha: manifest.headSha } : {}),
    generatedAt: manifest.generatedAt,
    ...(manifest.summary !== undefined ? { summary: manifest.summary } : {}),
    chapters: manifest.chapters,
    unassigned: manifest.unassigned,
  };
  if (issues.length > 0) out.issues = issues.map(canonicalIssue);
  // Persisted so the mark survives removal of the finding that set it.
  const seq = issueHighWater(manifest, issues);
  if (seq > 0) out.issueSeq = seq;
  // `reviewed` is deliberately not carried through: it lives in progress.json,
  // and re-emitting it here would recreate the shared-document race.
  return out;
}
