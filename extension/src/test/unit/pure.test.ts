// The pure helpers behind the tree and the scoped diff. No editor, no git.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyHunks } from "../../diffScope";
import { buildFolderTree } from "../../tree/folderTree";
import type { FileNode, FolderNode, Node } from "../../tree/nodes";
import type { Hunk } from "../../model";

const file = (path: string): FileNode => ({
  kind: "file",
  ownerId: "ch-1",
  entry: { path, status: "modified" },
});

describe("applyHunks", () => {
  const oldText = "a\nb\nc\nd\ne\n";
  const newText = "a\nB\nc\nd\nE\n";

  it("applies one hunk and leaves the rest at merge-base content", () => {
    const h: Hunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 };
    const { text } = applyHunks(oldText, newText, [h]);
    assert.equal(text, "a\nB\nc\nd\ne\n", "only line 2 should come from the new side");
  });

  it("applies several hunks, and order of input does not matter", () => {
    const top: Hunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 };
    const bottom: Hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 };
    const inOrder = applyHunks(oldText, newText, [top, bottom]).text;
    const reversed = applyHunks(oldText, newText, [bottom, top]).text;
    assert.equal(inOrder, "a\nB\nc\nd\nE\n");
    assert.equal(reversed, inOrder, "hunks are sorted before they are applied");
  });

  it("reports the line each hunk's first change lands on", () => {
    const bottom: Hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 };
    const { text, changeLines } = applyHunks(oldText, newText, [bottom]);
    const line = changeLines.get(bottom);
    assert.ok(line !== undefined, "every applied hunk needs a line to jump to");
    assert.equal(text.split("\n")[line - 1], "E", "the reported line holds the change");
  });

  it("skips leading context when locating the change", () => {
    // The hunk spans lines 1-3 but only line 2 differs.
    const withContext: Hunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 };
    const { text, changeLines } = applyHunks(oldText, newText, [withContext]);
    const line = changeLines.get(withContext);
    assert.ok(line !== undefined);
    assert.equal(text.split("\n")[line - 1], "B", "should point at the edit, not the context");
  });

  it("treats oldLines 0 as an insertion after that line", () => {
    const inserted: Hunk = { oldStart: 2, oldLines: 0, newStart: 3, newLines: 1 };
    const { text } = applyHunks("a\nb\nc\n", "a\nb\nX\nc\n", [inserted]);
    assert.equal(text, "a\nb\nX\nc\n");
  });

  it("no hunks yields the merge-base content untouched", () => {
    assert.equal(applyHunks(oldText, newText, []).text, oldText);
  });
});

/** Narrows, so the assertions below read the folder's own fields directly. */
function asFolder(n: Node): FolderNode {
  if (n.kind !== "folder") {
    throw new Error(`expected a folder node, got ${n.kind}`);
  }
  return n;
}

const labels = (nodes: Node[]): string[] =>
  nodes.map((n) => (n.kind === "folder" ? n.label : n.kind === "file" ? n.entry.path : n.kind));

describe("buildFolderTree", () => {
  it("keeps files at the root as files", () => {
    const nodes = buildFolderTree("ch-1", [file("a.txt"), file("b.txt")]);
    assert.deepEqual(nodes.map((n) => n.kind), ["file", "file"]);
  });

  it("compresses a single-child chain into one folder row", () => {
    const folder = asFolder(buildFolderTree("ch-1", [file("src/deep/nested/x.ts")])[0]);
    assert.equal(folder.label, "src/deep/nested");
    assert.deepEqual(folder.children.map((c) => c.kind), ["file"]);
  });

  it("stops compressing where a folder branches", () => {
    const folder = asFolder(
      buildFolderTree("ch-1", [file("src/a/x.ts"), file("src/b/y.ts")])[0]
    );
    assert.equal(folder.label, "src");
    assert.deepEqual(labels(folder.children), ["a", "b"]);
  });

  it("stops compressing where a folder holds a file of its own", () => {
    const folder = asFolder(
      buildFolderTree("ch-1", [file("src/top.ts"), file("src/deep/x.ts")])[0]
    );
    assert.equal(folder.label, "src");
    assert.deepEqual(
      folder.children.map((c) => c.kind),
      ["folder", "file"],
      "folders sort before files"
    );
  });

  it("sorts folders and files by name", () => {
    assert.deepEqual(labels(buildFolderTree("ch-1", [file("z.ts"), file("a.ts")])), [
      "a.ts",
      "z.ts",
    ]);
  });
});

