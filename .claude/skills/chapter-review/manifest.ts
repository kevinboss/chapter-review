// The manifest data model: read it, validate-and-install it, and the pure
// helpers that resolve issue ownership and carry findings and checkmarks
// forward across a regeneration.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { die, isArray, isRecord } from "./util.ts";
import { manifestPath, progressPath } from "./git.ts";
import { validateManifest } from "./validate.ts";
import type { Hunk, Issue, Manifest, ManifestStats, Progress, ReviewedUnit } from "./types.ts";
/**
 * Read the stored manifest if it is present, parseable and valid; null otherwise.
 *
 * The file is not trustworthy just because installManifest validated what it
 * wrote: the extension writes it too, a user can edit it, a partial write can
 * truncate it, and an older release may have left a different shape. Callers
 * that can carry on without it use this and treat null as "no prior state".
 */
export function readManifestIfValid(): Manifest | null {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  return validateManifest(parsed).ok ? (parsed as Manifest) : null;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    die(`chapter-review: existing manifest is not valid JSON: ${(e as Error).message}`);
  }
  const result = validateManifest(parsed);
  if (!result.ok) {
    console.error(`chapter-review: the stored manifest is invalid (${p}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error("  Regenerate it with `chapter-review write`, or delete it to start over.");
    process.exit(1);
  }
  return parsed as Manifest;
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
 */
function backup(dest: string): void {
  if (!existsSync(dest)) return;
  const bak = `${dest}.bak`;
  try {
    rmSync(bak, { force: true, recursive: true });
    copyFileSync(dest, bak);
  } catch (e) {
    console.error(
      `chapter-review: could not refresh the backup (${bak}): ${(e as Error).message}`
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
  rescueLegacyProgress();
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
    die(`chapter-review: could not write the manifest (${dest}): ${(e as Error).message}`);
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

/** Does `p` appear in any chapter or in unassigned? */
export function pathInManifest(manifest: Manifest, p: string): boolean {
  return (
    manifest.chapters.some((ch) => ch.files.some((f) => f.path === p)) ||
    manifest.unassigned.some((f) => f.path === p)
  );
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
 * Carry issues from the old manifest into a freshly written partition: drop any
 * whose path no longer appears at all, and re-point chapterId at the new owner.
 */
export function carryIssues(
  oldIssues: Issue[],
  newManifest: Manifest
): { kept: Issue[]; pruned: string[] } {
  const kept: Issue[] = [];
  const pruned: string[] = [];
  for (const issue of oldIssues) {
    if (!pathInManifest(newManifest, issue.path)) {
      pruned.push(issue.id);
      continue;
    }
    const chapterId = ownerChapterId(
      newManifest,
      issue.path,
      issue.hunk,
      issue.chapterId
    );
    const next = { ...issue };
    if (chapterId) next.chapterId = chapterId;
    else delete next.chapterId;
    kept.push(next);
  }
  return { kept, pruned };
}

/** The next free `iss-N` id, one past the highest number already in use. */
export function nextIssueId(issues: Issue[]): string {
  const max = issues.reduce((m, i) => {
    const n = Number((/^iss-(\d+)$/.exec(i.id) ?? [])[1]);
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return `iss-${max + 1}`;
}

/**
 * Carry review checkmarks forward across regeneration (they live in the
 * manifest, so a rebuild would drop them); keep units whose path still appears.
 */
/**
 * Read the reviewer's checkmarks.
 *
 * Migration: older versions kept them in the manifest, and an older extension
 * still writes them there. progress.json wins when present; otherwise the
 * manifest's legacy `reviewed` is adopted, and the next write drops it.
 */
export function readProgress(manifest: Manifest | null): ReviewedUnit[] {
  const p = progressPath();
  if (existsSync(p)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (isRecord(parsed) && parsed.version === 1 && isArray(parsed.reviewed)) {
        return parsed.reviewed.filter(isReviewedUnit);
      }
      console.error(`chapter-review: ${p} is not review progress this version understands; ignoring it.`);
    } catch {
      console.error(`chapter-review: ${p} is unreadable; ignoring it.`);
    }
    // Fall through to the legacy array rather than giving up: a file that exists
    // but cannot be used must not outrank readable checkmarks in the manifest.
  }
  return legacyProgress(manifest);
}

/** Checkmarks an extension older than the split left inside the manifest. */
function legacyProgress(manifest: Manifest | null): ReviewedUnit[] {
  // The one intentional read of the legacy field — that is what migration means.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return manifest?.reviewed?.filter(isReviewedUnit) ?? [];
}

/**
 * Move checkmarks out of a legacy manifest before it is replaced.
 *
 * withIssues() no longer emits `reviewed`, so *any* command that rewrites the
 * manifest drops it. `write` and `uncheck` handle progress explicitly; the
 * `issue` family does not, and without this a single `issue resolve` against a
 * manifest written by an older extension deletes the reviewer's progress.
 */
function rescueLegacyProgress(): void {
  if (existsSync(progressPath())) return;
  const units = legacyProgress(readManifestIfValid());
  if (units.length > 0) {
    writeProgress(units);
    console.error(
      `chapter-review: moved ${units.length} checkmark(s) out of the manifest into ${progressPath()}.`
    );
  }
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
    die(`chapter-review: could not write review progress (${dest}): ${(e as Error).message}`);
  }
}

export function carryReviewed(oldReviewed: ReviewedUnit[], newManifest: Manifest): ReviewedUnit[] {
  return oldReviewed.filter(
    (u) => typeof u.path === "string" && pathInManifest(newManifest, u.path)
  );
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
  if (issues.length > 0) out.issues = issues;
  // `reviewed` is deliberately not carried through: it lives in progress.json,
  // and re-emitting it here would recreate the shared-document race.
  return out;
}
