import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { checkStaleness } from "../../staleness";
import { OutdatedManifestError, parseManifest } from "../../model";
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

  it("a worktree review is never stale, and counts the files edited since its snapshot", () =>
    withFixture(async (fx) => {
      const worktree = { ...fx.manifest, mode: "worktree" as const };
      assert.deepEqual(await checkStaleness(fx.dir, worktree), { stale: false, snapshot: { edited: 0 } });

      writeFileSync(path.join(fx.dir, "b.txt"), "B1 fixed\n");
      fx.git("commit", "-am", "fix");
      writeFileSync(path.join(fx.dir, "a.txt"), "a fixed too\n");
      assert.deepEqual(
        await checkStaleness(fx.dir, worktree),
        { stale: false, snapshot: { edited: 2 } },
        "a fix committed since counts too, and HEAD moving is no reason to regenerate"
      );
    }));

  it("a file untracked when the snapshot was taken counts only once it is edited", () =>
    withFixture(async (fx) => {
      writeFileSync(path.join(fx.dir, "c.txt"), "new\n");
      fx.git("add", "c.txt");
      fx.git("commit", "-m", "snapshot");
      const snapshot = { ...fx.manifest, mode: "worktree" as const, headSha: fx.git("rev-parse", "HEAD").trim() };
      fx.git("reset", "HEAD~1");
      assert.deepEqual(await checkStaleness(fx.dir, snapshot), { stale: false, snapshot: { edited: 0 } });

      writeFileSync(path.join(fx.dir, "c.txt"), "new, edited\n");
      assert.deepEqual(await checkStaleness(fx.dir, snapshot), { stale: false, snapshot: { edited: 1 } });
      assert.equal(fx.git("status", "--porcelain").trim(), "?? c.txt", "the real index is left alone");
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
    assert.throws(() => parseManifest('{"version":3}'), /unsupported chapters.json version/);
  });

  it("an older format is refused as outdated rather than broken", () => {
    assert.throws(() => parseManifest('{"version":1}'), OutdatedManifestError);
  });

  it("reads a worktree review and refuses any other mode", () =>
    withFixture((fx) => {
      assert.equal(parseManifest(JSON.stringify({ ...fx.manifest, mode: "worktree" })).mode, "worktree");
      assert.throws(() => parseManifest(JSON.stringify({ ...fx.manifest, mode: "stash" })), /mode "worktree" when present/);
    }));

  it("malformed JSON names itself", () => {
    assert.throws(() => parseManifest("{{{"), /not valid JSON/);
  });
});
