import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { computeDigests } from "../../fingerprint";
import { ChapterTreeProvider, Node } from "../../tree";
import { ReviewProgress } from "../../progress";
import { withFixture, Fixture } from "../fixture";
import type { Manifest } from "../../model";

suite("activation", () => {
  test("the extension activates against a real review workspace", async () => {
    const ext = vscode.extensions.getExtension("kevinboss.chapter-review");
    assert.ok(ext, "the extension under test should be present");
    await ext.activate();
    assert.ok(ext.isActive);

    // The skill commands register before activate()'s `if (!folder)` guard, so
    // on their own they prove nothing about the review path.
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "chapterReview.installSkill",
      "chapterReview.openFile",
      "chapterReview.viewAsTree",
      "chapterReview.viewAsList",
    ]) {
      assert.ok(commands.includes(id), `${id} should be registered`);
    }

    // Past the guard: the workspace is a git repo with a manifest, so the view
    // is populated rather than showing its welcome content.
    assert.ok(
      vscode.workspace.workspaceFolders?.[0],
      "the host tests need a workspace folder to activate against"
    );
  });
});

interface Wired {
  provider: ChapterTreeProvider;
  progress: ReviewProgress;
}

/** A provider wired to a fresh fixture, with digests computed. */
async function wire(fx: Fixture, manifest: Manifest = fx.manifest): Promise<Wired> {
  const progress = new ReviewProgress();
  const provider = new ChapterTreeProvider(vscode.Uri.file(fx.dir), progress, manifest, "tree");
  provider.digests = await computeDigests(fx.dir, manifest);
  return { provider, progress };
}

const kinds = (nodes: Node[]): string[] => nodes.map((n) => n.kind);

// TreeItem.label is a string or a TreeItemLabel; String() on the latter gives
// "[object Object]".
const labelOf = (item: vscode.TreeItem): string =>
  typeof item.label === "string" ? item.label : (item.label?.label ?? "");

suite("chapter tree", () => {
  test("the roots are the chapters, in manifest order", () =>
    withFixture(async (fx) => {
      const { provider } = await wire(fx);
      const roots = provider.getChildren();
      assert.deepEqual(kinds(roots), ["chapter", "chapter"]);
      // Numbered, so the reviewer can name a chapter to the agent as "chapter 2".
      assert.deepEqual(
        roots.map((n) => labelOf(provider.getTreeItem(n))),
        ["1 · edit a top", "2 · edit a bottom and b"]
      );
    }));

  test("a chapter lists its files; only a multi-hunk file expands", () =>
    withFixture(async (fx) => {
      const { provider } = await wire(fx);
      const files = provider.getChildren(provider.getChildren()[1]);
      assert.deepEqual(
        files.map((f) => (f.kind === "file" ? f.entry.path : f.kind)),
        ["a.txt", "b.txt"]
      );

      // One hunk, and a whole-file claim, both stay leaves: a lone hunk row
      // would just repeat its file.
      assert.deepEqual(provider.getChildren(files[0]), []);
      assert.deepEqual(provider.getChildren(files[1]), []);

      const split: Manifest = {
        ...fx.manifest,
        chapters: [
          {
            id: "ch-1",
            title: "both edits",
            files: [
              {
                path: "a.txt",
                status: "modified",
                hunks: [
                  { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
                  { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
                ],
              },
            ],
          },
        ],
      };
      const wired = await wire(fx, split);
      const [only] = wired.provider.getChildren(wired.provider.getChildren()[0]);
      assert.deepEqual(kinds(wired.provider.getChildren(only)), ["hunk", "hunk"]);
    }));

  test("a file carries its status letter", () =>
    withFixture(async (fx) => {
      const { provider } = await wire(fx);
      const [file] = provider.getChildren(provider.getChildren()[0]);
      assert.match(String(provider.getTreeItem(file).description ?? ""), /M/);
    }));

  test("ticking a file's units makes the tree report it reviewed", () =>
    withFixture(async (fx) => {
      const { provider, progress } = await wire(fx);
      const files = provider.getChildren(provider.getChildren()[1]);
      const bTxt = files[1];

      assert.equal(
        provider.getTreeItem(bTxt).checkboxState,
        vscode.TreeItemCheckboxState.Unchecked
      );
      progress.setReviewed(provider.reviewUnitsFor(bTxt), true);
      assert.equal(
        provider.getTreeItem(bTxt).checkboxState,
        vscode.TreeItemCheckboxState.Checked
      );
    }));

  test("findings appear under their chapter, numbered within it", () =>
    withFixture(async (fx) => {
      const withIssue: Manifest = {
        ...fx.manifest,
        issues: [
          // Out of order on purpose: the rows sort by number, not by array order,
          // because a re-homed finding keeps its place but takes a new number.
          { id: "iss-2.2", path: "b.txt", chapterId: "ch-2", severity: "low", note: "second" },
          { id: "iss-2.1", path: "b.txt", chapterId: "ch-2", severity: "high", note: "no guard" },
        ],
      };
      const { provider } = await wire(fx, withIssue);
      const children = provider.getChildren(provider.getChildren()[1]);
      const issues = children.filter((n) => n.kind === "issue");
      assert.deepEqual(
        issues.map((n) => labelOf(provider.getTreeItem(n))),
        ["2.1 · no guard", "2.2 · second"],
        `expected two findings among ${kinds(children).join(", ")}`
      );
    }));

  test("a finding no chapter owns sits in the chapter-0 row", () =>
    withFixture(async (fx) => {
      const orphaned: Manifest = {
        ...fx.manifest,
        // No chapterId: the path is quarantined, or its chapter is gone.
        issues: [{ id: "iss-0.1", path: "b.txt", severity: "low", note: "on noise" }],
      };
      const { provider } = await wire(fx, orphaned);
      const root = provider.getChildren().find((n) => n.kind === "issuesRoot");
      assert.ok(root, "expected an issues root");
      // The row itself stays unnumbered: there is no ch-0 for a number to name.
      assert.equal(labelOf(provider.getTreeItem(root)), "Issues");
      // The finding's own number is a working handle, so it does show.
      assert.deepEqual(
        provider.getChildren(root).map((n) => labelOf(provider.getTreeItem(n))),
        ["0.1 · on noise"]
      );
    }));

  test("a stale manifest surfaces a warning row", () =>
    withFixture(async (fx) => {
      const { provider } = await wire(fx);
      provider.staleness = { stale: true, summary: "Review may be out of date", detail: "d" };
      assert.equal(provider.getChildren()[0].kind, "staleWarning");
    }));
});
