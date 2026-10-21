// The pure helpers behind the tree and the scoped diff. No editor, no git.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { changeLineIn } from "../../changeLine";
import { applyHunks, scopedLine } from "../../diffScope";
import { buildFolderTree } from "../../tree/folderTree";
import type { FileNode, FolderNode, Node } from "../../tree/nodes";
import type { Hunk } from "../../model";

const file = (path: string): FileNode => ({
  kind: "file",
  round: 1,
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

describe("scopedLine", () => {
  // Line 2 replaced by two lines, line 5 deleted, a line inserted after line 7.
  const oldText = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const newText = "a\nB1\nB2\nc\nd\nf\ng\nG\nh\n";
  const top: Hunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2 };
  const gone: Hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 0 };
  const added: Hunk = { oldStart: 7, oldLines: 0, newStart: 8, newLines: 1 };
  const all = [top, gone, added];
  const newLines = newText.split("\n");

  for (const applied of [[top], [gone], [added], [top, added], all]) {
    const label = applied.map((h) => all.indexOf(h)).join("+");
    it(`every line the patch holds lands on the same text (${label})`, () => {
      const patched = applyHunks(oldText, newText, applied).text.split("\n");
      for (const at of [...newLines.keys()].map((k) => k + 1)) {
        const line = scopedLine(at, applied, all);
        if (line !== undefined) {
          assert.equal(patched[line - 1], newLines[at - 1], `head line ${at}`);
        }
      }
    });
  }

  it("is undefined for a line another chapter's hunk owns", () => {
    assert.equal(scopedLine(8, [top], all), undefined);
    assert.equal(scopedLine(3, [added], all), undefined);
  });

  it("places a line of an applied hunk and an untouched line", () => {
    assert.equal(scopedLine(3, [top, added], all), 3);
    assert.equal(scopedLine(9, [top, added], all), 10);
  });
});

describe("changeLineIn", () => {
  const oldText = "a\nb\nc\nd\ne\n";
  const newText = "a\nb\nc\nd\nE\n";

  it("skips the leading context a hunk's coordinates include", () => {
    // What `git diff --unified=3` emits for the edit on line 5: newStart is 2,
    // and a cursor put there sits three lines above the code.
    const h: Hunk = { oldStart: 2, oldLines: 4, newStart: 2, newLines: 4 };
    assert.equal(changeLineIn(oldText, newText, h), 5);
  });

  it("leaves a hunk with no context at its own start", () => {
    const h: Hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 };
    assert.equal(changeLineIn(oldText, newText, h), 5);
  });

  it("points an insertion at the inserted line", () => {
    const h: Hunk = { oldStart: 2, oldLines: 0, newStart: 3, newLines: 1 };
    assert.equal(changeLineIn("a\nb\nc\n", "a\nb\nX\nc\n", h), 3);
  });

  it("points a trailing insertion past the shared context", () => {
    // Three context lines, then a line appended: the first four lines match, so
    // the change is on the fourth line of the hunk.
    const h: Hunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 };
    assert.equal(changeLineIn("a\nb\nc\n", "a\nb\nc\nX\n", h), 4);
  });

  it("falls back to the hunk's start when a side is missing", () => {
    // A blob the manifest pins but git can no longer show yields "", and there is
    // nothing left to compare against.
    const h: Hunk = { oldStart: 2, oldLines: 4, newStart: 2, newLines: 4 };
    assert.equal(changeLineIn("", newText, h), 2);
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
    const nodes = buildFolderTree(1, "ch-1", [file("a.txt"), file("b.txt")]);
    assert.deepEqual(nodes.map((n) => n.kind), ["file", "file"]);
  });

  it("compresses a single-child chain into one folder row", () => {
    const folder = asFolder(buildFolderTree(1, "ch-1", [file("src/deep/nested/x.ts")])[0]);
    assert.equal(folder.label, "src/deep/nested");
    assert.deepEqual(folder.children.map((c) => c.kind), ["file"]);
  });

  it("stops compressing where a folder branches", () => {
    const folder = asFolder(
      buildFolderTree(1, "ch-1", [file("src/a/x.ts"), file("src/b/y.ts")])[0]
    );
    assert.equal(folder.label, "src");
    assert.deepEqual(labels(folder.children), ["a", "b"]);
  });

  it("stops compressing where a folder holds a file of its own", () => {
    const folder = asFolder(
      buildFolderTree(1, "ch-1", [file("src/top.ts"), file("src/deep/x.ts")])[0]
    );
    assert.equal(folder.label, "src");
    assert.deepEqual(
      folder.children.map((c) => c.kind),
      ["folder", "file"],
      "folders sort before files"
    );
  });

  it("sorts folders and files by name", () => {
    assert.deepEqual(labels(buildFolderTree(1, "ch-1", [file("z.ts"), file("a.ts")])), [
      "a.ts",
      "z.ts",
    ]);
  });
});

