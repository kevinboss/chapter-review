// What actually opens when the reviewer clicks a row. The command really runs,
// so these assert on the tabs VS Code ends up showing rather than on a spy.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { DiffViewer } from "../../diffViewer";
import { GIT_SCHEME, PATCHED_SCHEME, PatchedContentProvider } from "../../gitContent";
import { withFixture, Fixture } from "../fixture";
import type { FileEntry, Manifest } from "../../model";

interface OpenTab {
  left?: vscode.Uri;
  right?: vscode.Uri;
  single?: vscode.Uri;
}

/** The tab VS Code is showing, reduced to the URIs behind it. */
function activeTab(): OpenTab {
  const { input } = vscode.window.tabGroups.activeTabGroup.activeTab ?? {};
  if (input instanceof vscode.TabInputTextDiff) {
    return { left: input.original, right: input.modified };
  }
  if (input instanceof vscode.TabInputText) {
    return { single: input.uri };
  }
  return {};
}

async function closeEverything(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

function viewerFor(fx: Fixture, manifest: Manifest): DiffViewer {
  return new DiffViewer(vscode.Uri.file(fx.dir), new PatchedContentProvider(), () => manifest);
}

suite("diff viewer", () => {
  teardown(closeEverything);

  test("a hunk-split entry opens against a chapter-scoped right-hand side", () =>
    withFixture(async (fx) => {
      const entry = fx.manifest.chapters[0].files[0];
      await viewerFor(fx, fx.manifest).openDiff({ kind: "file", ownerId: "ch-1", entry });

      const { left, right } = activeTab();
      assert.equal(left?.scheme, GIT_SCHEME, "the left side is merge-base content");
      // Only this chapter's hunks are applied, so the right side is synthesised
      // rather than the real head file.
      assert.equal(right?.scheme, PATCHED_SCHEME);
    }));

  test("a whole-file claim opens the real head file, not a patch", () =>
    withFixture(async (fx) => {
      const entry = fx.manifest.chapters[1].files[1];
      assert.equal(entry.path, "b.txt");
      await viewerFor(fx, fx.manifest).openDiff({ kind: "file", ownerId: "ch-2", entry });

      const { left, right } = activeTab();
      assert.equal(left?.scheme, GIT_SCHEME);
      assert.equal(right?.scheme, GIT_SCHEME, "nothing to scope, so no patched document");
    }));

  test("an added file has an empty left-hand side", () =>
    withFixture(async (fx) => {
      const added: FileEntry = { path: "added.txt", status: "added" };
      const manifest: Manifest = {
        ...fx.manifest,
        chapters: [{ id: "ch-1", title: "adds", files: [added] }],
      };
      await viewerFor(fx, manifest).openDiff({ kind: "file", ownerId: "ch-1", entry: added });

      const { left } = activeTab();
      // An empty ref is what gitContent serves as "".  Mislabelling a modified
      // file as added therefore hides its real before-side, which is why write
      // now refuses a status the diff contradicts.
      assert.match(left?.query ?? "", /"ref":""/);
    }));

  test("a deleted file has an empty right-hand side", () =>
    withFixture(async (fx) => {
      const deleted: FileEntry = { path: "gone.txt", status: "deleted" };
      const manifest: Manifest = {
        ...fx.manifest,
        chapters: [{ id: "ch-1", title: "removes", files: [deleted] }],
      };
      await viewerFor(fx, manifest).openDiff({ kind: "file", ownerId: "ch-1", entry: deleted });

      const { right } = activeTab();
      assert.match(right?.query ?? "", /"ref":""/);
    }));

  test("a renamed entry reads its left side from the old path", () =>
    withFixture(async (fx) => {
      const renamed: FileEntry = { path: "c.txt", status: "renamed", oldPath: "b.txt" };
      const manifest: Manifest = {
        ...fx.manifest,
        chapters: [{ id: "ch-1", title: "renames", files: [renamed] }],
      };
      await viewerFor(fx, manifest).openDiff({ kind: "file", ownerId: "ch-1", entry: renamed });

      const { left, right } = activeTab();
      assert.match(left?.query ?? "", /b\.txt/, "the before side is the pre-rename path");
      assert.match(right?.query ?? "", /c\.txt/);
    }));

  test("an orphaned finding falls back to the working file", () =>
    withFixture(async (fx) => {
      // No chapter owns this path, so there is no diff to scope it to.
      await viewerFor(fx, fx.manifest).openIssue({
        kind: "issue",
        issue: { id: "iss-1", path: "a.txt", severity: "low", note: "orphan" },
      });

      const { single } = activeTab();
      assert.ok(single, "an orphaned finding should still open something");
      assert.equal(single.scheme, "file", "a plain editor, not a diff");
      assert.match(single.path, /a\.txt$/);
    }));
});
