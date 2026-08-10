// changeLineFor against a real repo: the coordinates come from a manifest, the
// content from its pinned commits. The pure half is in pure.test.ts.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { changeLineFor } from "../../changeLine";
import { withFixture } from "../fixture";

// a.txt is "l1 L2 l3 l4 L5 l6" over a base of "l1 l2 l3 l4 l5 l6": edits on 2 and 5.
const target = { path: "a.txt" };

describe("changeLineFor", () => {
  it("resolves a hunk to the line its change is on", () =>
    withFixture(async (fx) => {
      // Two identical lines above the edit, as unified context puts them.
      const at = await changeLineFor(fx.dir, fx.manifest, target, {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 3,
      });
      assert.equal(at, 5);
    }));

  it("reads the head side from the pinned sha, not the branch tip", () =>
    withFixture(async (fx) => {
      // A later commit reverts the edit the finding was recorded against. The
      // manifest still pins the sha that has it, so the line must not move.
      writeFileSync(path.join(fx.dir, "a.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
      fx.git("commit", "-am", "revert it");

      const at = await changeLineFor(fx.dir, fx.manifest, target, {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 3,
      });
      assert.equal(at, 5);
    }));

  it("falls back to the hunk's start when the path is not in either commit", () =>
    withFixture(async (fx) => {
      const at = await changeLineFor(
        fx.dir,
        fx.manifest,
        { path: "never-existed.txt" },
        { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 }
      );
      assert.equal(at, 3, "an unreadable blob leaves nothing to compare");
    }));

  it("reads the before side from a renamed entry's old path", () =>
    withFixture(async (fx) => {
      fx.git("mv", "a.txt", "renamed.txt");
      fx.git("commit", "-m", "rename it");
      const manifest = { ...fx.manifest, headSha: fx.git("rev-parse", "HEAD").trim() };

      const at = await changeLineFor(
        fx.dir,
        manifest,
        { path: "renamed.txt", oldPath: "a.txt" },
        { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 }
      );
      assert.equal(at, 5, "without oldPath the before side is empty and this is 3");
    }));
});
