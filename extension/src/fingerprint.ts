import { createHash } from "node:crypto";
import { gitShow } from "./git";
import { allEntries, Manifest, reviewKey } from "./model";

/**
 * What one review unit currently hashes to, plus the file-level context needed to
 * match a checkmark that was recorded at a different granularity.
 */
export interface UnitDigest {
  /** Digest of this unit alone: the hunk's lines, or the whole file. */
  unit: string;
  /** Digest of the entire file both sides, regardless of this unit's granularity. */
  file: string;
  /** The review key a whole-file checkmark on this path uses. */
  wholeKey: string;
}

/** Current digests per review key (model.reviewKey), for one manifest. */
export type DigestMap = Map<string, UnitDigest>;

/**
 * Fingerprints the reviewed content of every unit in the manifest, so a checkmark
 * can be tied to *what* was reviewed rather than to a hunk's coordinates. When the
 * author pushes a fix and the chapters are regenerated, a unit whose content moved
 * gets a new digest and reads as unreviewed; a unit that only shifted position
 * (identical content, new line numbers) keeps its digest and stays reviewed.
 *
 * Digests are a pure function of the manifest's pinned blobs (mergeBase and
 * headSha), so they only need recomputing when the manifest itself changes, not
 * when the branch moves underneath a stale manifest.
 *
 * Whole-file units hash both sides of the file; hunk units hash only that hunk's
 * old and new lines, so an edit to a sibling hunk leaves this one checked. Every
 * unit also carries its file's digest, which is what lets a whole-file checkmark
 * survive the partition re-cutting that file into hunks (see ReviewProgress).
 */
export async function computeDigests(repoRoot: string, manifest: Manifest): Promise<DigestMap> {
  const headRef = manifest.headSha ?? manifest.head;
  const entries = allEntries(manifest);

  // Fetch each (ref, path) blob once, in parallel; a hunk-split file appears
  // under several entries but its two blobs are read a single time.
  const blobs = new Map<string, Promise<string>>();
  const need = (ref: string, path: string): void => {
    const k = `${ref}\0${path}`;
    if (!blobs.has(k)) {
      blobs.set(k, gitShow(repoRoot, ref, path));
    }
  };
  for (const e of entries) {
    need(manifest.mergeBase, e.oldPath ?? e.path);
    need(headRef, e.path);
  }
  const text = new Map<string, string>();
  await Promise.all(
    [...blobs].map(async ([k, pr]) => {
      text.set(k, await pr);
    })
  );
  const get = (ref: string, path: string): string => text.get(`${ref}\0${path}`) ?? "";

  const digests: DigestMap = new Map();
  for (const e of entries) {
    const oldText = get(manifest.mergeBase, e.oldPath ?? e.path);
    const newText = get(headRef, e.path);
    const file = sha(`${oldText}\0${newText}`);
    const wholeKey = reviewKey(e.path);
    if (!e.hunks) {
      digests.set(wholeKey, { unit: file, file, wholeKey });
      continue;
    }
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    for (const h of e.hunks) {
      const oldChunk = oldLines.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines).join("\n");
      const newChunk = newLines.slice(h.newStart - 1, h.newStart - 1 + h.newLines).join("\n");
      digests.set(reviewKey(e.path, h), {
        unit: sha(`${oldChunk}\0${newChunk}`),
        file,
        wholeKey,
      });
    }
  }
  return digests;
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}
