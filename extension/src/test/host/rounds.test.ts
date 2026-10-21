// A review with more than one round: each round is a drawer of its own, reads
// its own diff, keeps its own checkmarks, and holds the findings anchored in it.

import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DiffViewer } from "../../diffViewer";
import { computeDigests } from "../../fingerprint";
import { GIT_SCHEME, PatchedContentProvider } from "../../gitContent";
import { ReviewProgress } from "../../progress";
import { ChapterTreeProvider, FileNode, Node, RoundView } from "../../tree";
import type { Manifest } from "../../model";
import { withFixture, Fixture } from "../fixture";

interface TwoRounds {
  provider: ChapterTreeProvider;
  round1: RoundView & { progress: ReviewProgress };
  round2: RoundView & { progress: ReviewProgress };
}

/** Round 1 is the fixture's; round 2 is a fix to b.txt committed on top. */
async function twoRounds(fx: Fixture): Promise<TwoRounds> {
  writeFileSync(path.join(fx.dir, "b.txt"), "B1 fixed\n");
  fx.git("commit", "-qam", "fix b");
  const manifest2: Manifest = {
    ...fx.manifest,
    round: 2,
    fromSha: fx.headSha,
    headSha: fx.git("rev-parse", "HEAD").trim(),
    chapters: [{ id: "ch-2", title: "fix b", files: [{ path: "b.txt", status: "modified" }] }],
    issues: [
      { id: "iss-1.1", round: 1, path: "a.txt", line: 2, chapterId: "ch-1", severity: "low", note: "stays in round 1" },
      { id: "iss-2.1", round: 2, path: "b.txt", line: 1, chapterId: "ch-2", severity: "low", note: "came along" },
    ],
  };
  const view = async (manifest: Manifest): Promise<RoundView & { progress: ReviewProgress }> => ({
    manifest,
    progress: new ReviewProgress(),
    digests: await computeDigests(fx.dir, manifest),
  });
  const round1 = await view(fx.manifest);
  const round2 = await view(manifest2);
  const provider = new ChapterTreeProvider(vscode.Uri.file(fx.dir), "tree");
  provider.rounds = [round1, round2];
  return { provider, round1, round2 };
}

const labelOf = (item: vscode.TreeItem): string =>
  typeof item.label === "string" ? item.label : (item.label?.label ?? "");

const labels = (p: ChapterTreeProvider, nodes: Node[]): string[] => nodes.map((n) => labelOf(p.getTreeItem(n)));

suite("review rounds", () => {
  teardown(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  test("each round is a drawer, the current one first and open", () =>
    withFixture(async (fx) => {
      const { provider } = await twoRounds(fx);
      const roots = provider.getChildren();
      assert.deepEqual(labels(provider, roots), ["Round 2", "Round 1"]);
      const [current, earlier] = roots.map((n) => provider.getTreeItem(n));
      assert.equal(current.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.equal(earlier.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.notEqual(current.id, earlier.id);
    }));

  test("a round holds its own chapters and the findings anchored in it", () =>
    withFixture(async (fx) => {
      const { provider } = await twoRounds(fx);
      const [r2, r1] = provider.getChildren();
      assert.deepEqual(labels(provider, provider.getChildren(r2)), ["2 · fix b"]);
      assert.deepEqual(labels(provider, provider.getChildren(r1)), ["1 · edit a top", "2 · edit a bottom and b"]);

      const [r2ch2] = provider.getChildren(r2);
      assert.ok(labels(provider, provider.getChildren(r2ch2)).includes("2.1 · came along"));
      const [r1ch1] = provider.getChildren(r1);
      assert.ok(labels(provider, provider.getChildren(r1ch1)).includes("1.1 · stays in round 1"));
    }));

  test("a tick in one round leaves the same file in another round unticked", () =>
    withFixture(async (fx) => {
      const { provider, round2 } = await twoRounds(fx);
      const [r2, r1] = provider.getChildren();
      const fileIn = (round: Node, chapter: number): Node => {
        const ch = provider.getChildren(round)[chapter];
        const node = provider.getChildren(ch).find((n) => n.kind === "file" && n.entry.path === "b.txt");
        assert.ok(node);
        return node;
      };
      const b2 = fileIn(r2, 0);
      round2.progress.setReviewed(provider.reviewUnitsFor(b2), true);
      assert.equal(provider.getTreeItem(b2).checkboxState, vscode.TreeItemCheckboxState.Checked);
      assert.equal(provider.getTreeItem(fileIn(r1, 1)).checkboxState, vscode.TreeItemCheckboxState.Unchecked);
    }));

  test("a later round's file diffs from the round before, and offers the whole branch", () =>
    withFixture(async (fx) => {
      const { provider, round2 } = await twoRounds(fx);
      const [r2] = provider.getChildren();
      const [ch] = provider.getChildren(r2);
      const file = provider.getChildren(ch).find((n): n is FileNode => n.kind === "file");
      assert.ok(file);
      assert.equal(provider.getTreeItem(file).contextValue, "laterRoundFile");

      const viewer = new DiffViewer(vscode.Uri.file(fx.dir), new PatchedContentProvider(), (n) => provider.roundView(n)?.manifest);
      await viewer.openDiff(file);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(tab instanceof vscode.TabInputTextDiff);
      assert.equal(tab.original.scheme, GIT_SCHEME);
      assert.match(tab.original.query, new RegExp(`"ref":"${round2.manifest.fromSha}"`), "round 2 starts at round 1's head");

      await viewer.openBranchDiff(file);
      const whole = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(whole instanceof vscode.TabInputTextDiff);
      assert.match(whole.original.query, new RegExp(`"ref":"${fx.mergeBase}"`), "the whole branch starts at the merge base");
    }));

  test("one round needs no drawer", () =>
    withFixture(async (fx) => {
      const provider = new ChapterTreeProvider(vscode.Uri.file(fx.dir), "tree");
      provider.rounds = [{ manifest: fx.manifest, progress: new ReviewProgress(), digests: await computeDigests(fx.dir, fx.manifest) }];
      assert.deepEqual(
        provider.getChildren().map((n) => n.kind),
        ["chapter", "chapter"]
      );
    }));
});
