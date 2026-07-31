import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { checkStaleness } from "../../staleness";
import { parseManifest } from "../../model";
import { withFixture } from "../fixture";

describe("staleness", () => {
  it("a manifest pinned to the checked-out commit is fresh", () =>
    withFixture(async (fx) => {
      assert.equal((await checkStaleness(fx.dir, fx.manifest)).stale, false);
    }));

  it("a new commit makes it stale, and re-pinning clears it", () =>
    withFixture(async (fx) => {
      writeFileSync(path.join(fx.dir, "b.txt"), "B1 again\n");
      fx.git("commit", "-am", "more work");

      const moved = await checkStaleness(fx.dir, fx.manifest);
      assert.equal(moved.stale, true);
      assert.ok(moved.summary, "a stale result needs a label for the warning row");

      const repinned = { ...fx.manifest, headSha: fx.git("rev-parse", "HEAD").trim() };
      assert.equal((await checkStaleness(fx.dir, repinned)).stale, false);
    }));

  it("uncommitted changes are reported without making the review stale", () =>
    withFixture(async (fx) => {
      assert.equal((await checkStaleness(fx.dir, fx.manifest)).dirty, undefined);

      writeFileSync(path.join(fx.dir, "b.txt"), "B1 uncommitted\n");
      const dirty = await checkStaleness(fx.dir, fx.manifest);
      assert.equal(dirty.dirty, 1, "one tracked file has uncommitted changes");
      assert.equal(dirty.stale, false, "HEAD has not moved, so the pin is still right");
    }));

  it("a base that no longer resolves is not reported as stale", () =>
    withFixture(async (fx) => {
      const noBase = { ...fx.manifest, base: "branch-that-does-not-exist" };
      assert.equal((await checkStaleness(fx.dir, noBase)).stale, false);
    }));
});

describe("manifest parsing", () => {
  it("a non-object document is refused", () => {
    assert.throws(() => parseManifest('"just a string"'), /must be an object/);
  });

  it("an unsupported version is refused", () => {
    assert.throws(() => parseManifest('{"version":2}'), /unsupported chapters.json version/);
  });

  it("malformed JSON names itself", () => {
    assert.throws(() => parseManifest("{{{"), /not valid JSON/);
  });
});
