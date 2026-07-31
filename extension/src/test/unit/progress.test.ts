// The contract between the CLI and this extension: a checkmark is tied to the
// content it was ticked against, not to where that content sits. The CLI carries
// rows forward by path; deciding whether one still counts happens here.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { computeDigests } from "../../fingerprint";
import { allEntries, reviewKey } from "../../model";
import { ReviewProgress } from "../../progress";
import { withFixture, Fixture } from "../fixture";

async function tickEverything(fx: Fixture): Promise<ReviewProgress> {
  const digests = await computeDigests(fx.dir, fx.manifest);
  const progress = new ReviewProgress();
  const units = allEntries(fx.manifest).flatMap((e) =>
    (e.hunks ?? [undefined]).map((hunk) => {
      const key = reviewKey(e.path, hunk);
      return { key, digest: digests.get(key)?.unit };
    })
  );
  progress.setReviewed(units, true);
  return progress;
}

describe("review progress", () => {
  it("a ticked unit reads as reviewed against the same content", () =>
    withFixture(async (fx) => {
      const progress = await tickEverything(fx);
      const digests = await computeDigests(fx.dir, fx.manifest);
      for (const [key, digest] of digests) {
        assert.ok(progress.isReviewedAt(key, digest.unit), `${key} should still be reviewed`);
      }
    }));

  it("a unit whose content changed re-opens; its siblings do not", () =>
    withFixture(async (fx) => {
      const progress = await tickEverything(fx);

      // b.txt changes, a.txt does not.
      writeFileSync(path.join(fx.dir, "b.txt"), "B1 edited\n");
      fx.git("commit", "-am", "edit b again");
      const moved = { ...fx.manifest, headSha: fx.git("rev-parse", "HEAD").trim() };

      const after = await computeDigests(fx.dir, moved);
      assert.equal(
        progress.isReviewedAt(reviewKey("b.txt"), after.get(reviewKey("b.txt"))?.unit),
        false,
        "b.txt changed, so its checkmark must not count"
      );
      const aKey = reviewKey("a.txt", moved.chapters[0].files[0].hunks?.[0]);
      assert.ok(progress.isReviewedAt(aKey, after.get(aKey)?.unit), "a.txt did not change");
    }));

  it("content that only shifted position keeps its checkmark", () =>
    withFixture(async (fx) => {
      const progress = await tickEverything(fx);
      const before = await computeDigests(fx.dir, fx.manifest);
      const bDigest = before.get(reviewKey("b.txt"))?.unit;

      // Two lines above a.txt's edits; b.txt's content is untouched.
      writeFileSync(path.join(fx.dir, "a.txt"), "top1\ntop2\nl1\nL2\nl3\nl4\nL5\nl6\n");
      fx.git("commit", "-am", "prepend to a");
      const moved = {
        ...fx.manifest,
        headSha: fx.git("rev-parse", "HEAD").trim(),
        chapters: [
          {
            ...fx.manifest.chapters[0],
            files: [
              {
                path: "a.txt",
                status: "modified" as const,
                hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }],
              },
            ],
          },
          fx.manifest.chapters[1],
        ],
      };

      const after = await computeDigests(fx.dir, moved);
      assert.equal(after.get(reviewKey("b.txt"))?.unit, bDigest, "b.txt's digest is content-only");
      assert.ok(progress.isReviewedAt(reviewKey("b.txt"), after.get(reviewKey("b.txt"))?.unit));
    }));

  it("serializing round-trips through the manifest's own entries", () =>
    withFixture(async (fx) => {
      const progress = await tickEverything(fx);
      const units = progress.toReviewedUnits(fx.manifest);
      assert.equal(units.length, 3, "two a.txt hunks and one whole-file b.txt");

      const reloaded = new ReviewProgress();
      reloaded.load(units);
      const digests = await computeDigests(fx.dir, fx.manifest);
      for (const [key, digest] of digests) {
        assert.ok(reloaded.isReviewedAt(key, digest.unit), `${key} should survive a round trip`);
      }
    }));

  it("re-cutting an unchanged file into hunks keeps its checkmark", () =>
    withFixture(async (fx) => {
      const progress = await tickEverything(fx);

      // Same commit, same bytes: only the partition's granularity changed.
      const bHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };
      const split = {
        ...fx.manifest,
        chapters: [
          fx.manifest.chapters[0],
          {
            ...fx.manifest.chapters[1],
            files: [
              fx.manifest.chapters[1].files[0],
              { path: "b.txt", status: "modified" as const, hunks: [bHunk] },
            ],
          },
        ],
      };

      const after = await computeDigests(fx.dir, split);
      const hunkKey = reviewKey("b.txt", bHunk);
      assert.equal(
        progress.isReviewedAt(hunkKey, after.get(hunkKey)?.unit),
        false,
        "the hunk key cannot match a whole-file digest on its own"
      );

      assert.equal(progress.adoptWholeFileMarks(after), true, "the mark should be re-keyed");
      assert.ok(
        progress.isReviewedAt(hunkKey, after.get(hunkKey)?.unit),
        "b.txt did not change, so re-cutting it must not discard the review"
      );
      const aKey = reviewKey("a.txt", fx.manifest.chapters[0].files[0].hunks?.[0]);
      assert.ok(progress.isReviewedAt(aKey, after.get(aKey)?.unit), "a.txt is untouched");

      // Retired, so a later persist cannot silently drop the adopted mark.
      assert.deepEqual(
        progress.toReviewedUnits(split).filter((u) => u.path === "b.txt"),
        [{ path: "b.txt", hunk: bHunk, digest: after.get(hunkKey)?.unit }]
      );
    }));

  it("merging hunks back into a whole file does not claim the file was reviewed", () =>
    withFixture(async (fx) => {
      // Only a.txt's first hunk is ticked, so the file must re-open.
      const digests = await computeDigests(fx.dir, fx.manifest);
      const firstHunk = fx.manifest.chapters[0].files[0].hunks?.[0];
      const tickedKey = reviewKey("a.txt", firstHunk);
      const progress = new ReviewProgress();
      progress.setReviewed([{ key: tickedKey, digest: digests.get(tickedKey)?.unit }], true);

      const merged = {
        ...fx.manifest,
        chapters: [
          { ...fx.manifest.chapters[0], files: [{ path: "a.txt", status: "modified" as const }] },
          { ...fx.manifest.chapters[1], files: [fx.manifest.chapters[1].files[1]] },
        ],
      };

      const after = await computeDigests(fx.dir, merged);
      assert.equal(progress.adoptWholeFileMarks(after), false, "nothing to adopt upwards");
      assert.equal(
        progress.isReviewedAt(reviewKey("a.txt"), after.get(reviewKey("a.txt"))?.unit),
        false,
        "a partial tick must never read as a reviewed whole file"
      );
    }));

  it("a unit with no digest never counts as reviewed", () => {
    const progress = new ReviewProgress();
    progress.setReviewed([{ key: reviewKey("a.txt"), digest: undefined }], true);
    assert.equal(progress.isReviewedAt(reviewKey("a.txt"), undefined), false);
  });
});
