import { allEntries, Hunk, Manifest, ReviewedUnit, reviewKey } from "./model";

/** A review unit paired with the digest of the content it stands for. */
export interface ReviewUnit {
  key: string;
  digest: string | undefined;
}

/**
 * The review units the reviewer has checked off, each with the content digest it
 * was checked against. Backed by the manifest's `reviewed` array, not the
 * extension's own storage, so the CLI can carry it across regeneration and clear
 * it; the host loads it on read and persists it on tick.
 */
export class ReviewProgress {
  private reviewed = new Map<string, string>();

  /** Reset the checked set from a manifest's `reviewed` array. */
  load(units: ReviewedUnit[] | undefined): void {
    this.reviewed = new Map((units ?? []).map((u) => [reviewKey(u.path, u.hunk), u.digest]));
  }

  /** Reviewed iff the digest recorded at tick time still matches current content. */
  isReviewedAt(key: string, currentDigest: string | undefined): boolean {
    const rec = this.reviewed.get(key);
    return rec !== undefined && currentDigest !== undefined && rec === currentDigest;
  }

  /** Tick or untick units in memory. The host then persists the result. */
  setReviewed(units: ReviewUnit[], reviewed: boolean): void {
    for (const { key, digest } of units) {
      if (reviewed && digest !== undefined) {
        this.reviewed.set(key, digest);
      } else {
        this.reviewed.delete(key);
      }
    }
  }

  clear(): void {
    this.reviewed.clear();
  }

  /**
   * Serialize back to a `reviewed` array, rebuilding each unit from the
   * manifest's own entries rather than by parsing a review key apart.
   */
  toReviewedUnits(manifest: Manifest): ReviewedUnit[] {
    const out: ReviewedUnit[] = [];
    for (const entry of allEntries(manifest)) {
      const units: { path: string; hunk?: Hunk }[] = entry.hunks
        ? entry.hunks.map((hunk) => ({ path: entry.path, hunk }))
        : [{ path: entry.path }];
      for (const u of units) {
        const digest = this.reviewed.get(reviewKey(u.path, u.hunk));
        if (digest === undefined) {
          continue;
        }
        out.push(u.hunk ? { path: u.path, hunk: u.hunk, digest } : { path: u.path, digest });
      }
    }
    return out;
  }
}
