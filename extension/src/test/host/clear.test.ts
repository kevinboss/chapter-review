// Clearing is the only place the extension deletes rather than writes, so what
// it leaves behind is the whole of the behaviour: nothing, backup included.

import * as assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { clearDetail, clearReviewState, hasReviewState } from "../../clear";
import type { Issue } from "../../model";
import { withFixture, Fixture } from "../fixture";

const protocolDir = (fx: Fixture): string => path.join(fx.gitDir, "chapter-review");
const protocolUri = (fx: Fixture): vscode.Uri => vscode.Uri.file(protocolDir(fx));

/** The rest of the protocol directory, which the fixture does not write. */
function writeCompanions(fx: Fixture): void {
  const dir = protocolDir(fx);
  writeFileSync(path.join(dir, "chapters.json.bak"), JSON.stringify(fx.manifest, null, 2) + "\n");
  writeFileSync(
    path.join(dir, "progress.json"),
    JSON.stringify({ version: 1, reviewed: [{ path: "b.txt", digest: "abc" }] }, null, 2) + "\n"
  );
  writeFileSync(path.join(dir, "focus.json"), JSON.stringify({ path: "b.txt" }) + "\n");
}

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "iss-1.1",
  path: "a.txt",
  chapterId: "ch-1",
  severity: "high",
  note: "n",
  ...over,
});

suite("clearing a review", () => {
  test("takes the manifest, the backup, the checkmarks and the focus pointer", () =>
    withFixture(async (fx) => {
      writeCompanions(fx);
      assert.ok(existsSync(path.join(protocolDir(fx), "chapters.json.bak")));

      await clearReviewState(protocolUri(fx));

      // The directory itself, not a file at a time: a surviving .bak is what the
      // next `chapter-review write` carries every finding back out of.
      assert.equal(existsSync(protocolDir(fx)), false);
      // The repository is untouched, since all of this lived inside .git.
      assert.ok(existsSync(path.join(fx.dir, "a.txt")));
      assert.equal(fx.git("status", "--porcelain").trim(), "");
    }));

  test("is reachable under the id the palette and the menu name", async () => {
    // The id is written three times — the registration, the command
    // contribution, and the menu's `when` — and a typo in any of them shows up
    // as a menu entry that does nothing rather than as an error.
    const ext = vscode.extensions.getExtension("kevinboss.chapter-review");
    assert.ok(ext);
    await ext.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes("chapterReview.clearReview"));
  });

  test("reports no state in a repository the skill has never run in", () =>
    withFixture(async (fx) => {
      const never = vscode.Uri.file(path.join(fx.dir, "elsewhere", "chapter-review"));
      assert.equal(await hasReviewState(never), false);
      assert.equal(await hasReviewState(protocolUri(fx)), true);

      await clearReviewState(protocolUri(fx));
      assert.equal(await hasReviewState(protocolUri(fx)), false);
    }));
});

suite("what the confirm dialog says is at stake", () => {
  test("names the branch and counts a split file once", () =>
    withFixture((fx) => {
      // The fixture splits a.txt across both chapters, so entries outnumber files.
      const detail = clearDetail({ ...fx.manifest, issues: [issue()] });
      assert.match(detail, /^feat: 2 chapters, 2 files and 1 open finding\./);
      assert.match(detail, /checkmarks go with it/);
    }));

  test("leaves findings out of it when none are open", () =>
    withFixture((fx) => {
      const detail = clearDetail({ ...fx.manifest, issues: [issue({ status: "resolved" })] });
      assert.match(detail, /^feat: 2 chapters and 2 files\./);
      // The clause is dropped, not zeroed. "The findings … go with it" stays,
      // since a resolved one is still discarded.
      assert.doesNotMatch(detail, /open finding/);
    }));

  test("still reads when the manifest could not be parsed", () => {
    const detail = clearDetail(undefined);
    assert.match(detail, /No manifest is loaded/);
    assert.match(detail, /checkmarks go with it/);
  });
});
