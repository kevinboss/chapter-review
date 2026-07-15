import { createHash } from "node:crypto";
import { gitShow } from "./gitContent";
import { allEntries, Manifest, reviewKey } from "./model";

/** Current content digest per review key (model.reviewKey), for one manifest. */
export type DigestMap = Map<string, string>;

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
 * old and new lines, so an edit to a sibling hunk leaves this one checked.
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
    if (!e.hunks) {
      digests.set(reviewKey(e.path), sha(`${oldText}\0${newText}`));
      continue;
    }
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    for (const h of e.hunks) {
      const oldChunk = oldLines.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines).join("\n");
      const newChunk = newLines.slice(h.newStart - 1, h.newStart - 1 + h.newLines).join("\n");
      digests.set(reviewKey(e.path, h), sha(`${oldChunk}\0${newChunk}`));
    }
  }
  return digests;
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}
