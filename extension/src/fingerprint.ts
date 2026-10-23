import { createHash } from "node:crypto";
import { gitShowMany } from "./git";
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
 * Digests are a pure function of the manifest's pinned blobs (fromSha and
 * headSha), so they only need recomputing when those commits or the units cut
 * from them change (see DigestCache), not when the branch moves underneath a
 * stale manifest.
 *
 * Whole-file units hash both sides of the file; hunk units hash only that hunk's
 * old and new lines, so an edit to a sibling hunk leaves this one checked. Every
 * unit also carries its file's digest, which is what lets a whole-file checkmark
 * survive the partition re-cutting that file into hunks (see ReviewProgress).
 */
export async function computeDigests(repoRoot: string, manifest: Manifest): Promise<DigestMap> {
  const headRef = manifest.headSha;
  const fromRef = manifest.fromSha;
  const entries = allEntries(manifest);

  // Fetch each (ref, path) blob once; a hunk-split file appears under several
  // entries but its two blobs are read a single time.
  const blobs = new Map<string, { ref: string; path: string }>();
  const need = (ref: string, path: string): void => {
    blobs.set(`${ref}\0${path}`, { ref, path });
  };
  for (const e of entries) {
    need(fromRef, e.oldPath ?? e.path);
    need(headRef, e.path);
  }
  const contents = await gitShowMany(repoRoot, [...blobs.values()]);
  const text = new Map([...blobs.keys()].map((k, i) => [k, contents[i]]));
  const get = (ref: string, path: string): string => text.get(`${ref}\0${path}`) ?? "";

  const digests: DigestMap = new Map();
  for (const e of entries) {
    const oldText = get(fromRef, e.oldPath ?? e.path);
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

interface CachedDigests {
  inputs: string;
  digests: Promise<DigestMap>;
  /** Set once `digests` has resolved, so a reload can paint them without waiting. */
  ready?: DigestMap;
}

/**
 * Each round's digests as last computed, so a manifest write that leaves a
 * round's pinned commits and units alone (a finding added, say) reuses them
 * rather than reading every blob again. Holds the computation itself, so a
 * reload that supersedes another picks up the read already under way.
 */
export class DigestCache {
  private readonly rounds = new Map<number, CachedDigests>();

  constructor(private readonly compute: (manifest: Manifest) => Promise<DigestMap>) {}

  /** The round's digests, computed only if its inputs changed since the last call. */
  digestsFor(manifest: Manifest): Promise<DigestMap> {
    const inputs = digestInputs(manifest);
    const cached = this.rounds.get(manifest.round);
    if (cached?.inputs === inputs) {
      return cached.digests;
    }
    const entry: CachedDigests = {
      inputs,
      digests: this.compute(manifest),
    };
    void entry.digests.then((d) => {
      entry.ready = d;
    });
    this.rounds.set(manifest.round, entry);
    return entry.digests;
  }

  /** The round's digests if they are already computed for these inputs, else undefined. */
  known(manifest: Manifest): DigestMap | undefined {
    const cached = this.rounds.get(manifest.round);
    return cached?.inputs === digestInputs(manifest) ? cached.ready : undefined;
  }
}

/** Everything computeDigests reads from a manifest. */
function digestInputs(m: Manifest): string {
  return JSON.stringify([
    m.fromSha,
    m.headSha,
    allEntries(m).map((e) => [e.path, e.oldPath ?? null, e.hunks ?? null]),
  ]);
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}
