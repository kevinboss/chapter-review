// focus.json is the extension's half of the follow-up protocol: it records what
// the reviewer clicked so the skill can resolve "this file" from the terminal.

import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FocusStore, focusForNode, resolveFocus, Focus } from "../../focus";
import { withFixture, Fixture } from "../fixture";
import type { Node } from "../../tree";

const readFocus = (fx: Fixture): Focus & { updatedAt?: string } => {
  const raw = readFileSync(path.join(fx.gitDir, "chapter-review", "focus.json"), "utf8");
  const doc: unknown = JSON.parse(raw);
  if (typeof doc !== "object" || doc === null) {
    throw new Error("focus.json is not an object");
  }
  return doc;
};

suite("focus store", () => {
  test("writes the pointer the skill reads", () =>
    withFixture(async (fx) => {
      const store = new FocusStore(vscode.Uri.file(fx.gitDir));
      await store.write({ path: "a.txt", line: 2, chapterId: "ch-1" });

      const written = readFocus(fx);
      assert.equal(written.path, "a.txt");
      assert.equal(written.line, 2);
      assert.equal(written.chapterId, "ch-1");
      assert.ok(written.updatedAt, "the skill shows the reviewer when this was clicked");
    }));

  test("creates chapter-review/ when the manifest has not been written yet", () =>
    withFixture(async (fx) => {
      // A repo where the agent has never run: the directory does not exist, and
      // the first write has to make it rather than silently doing nothing.
      const bare = vscode.Uri.file(path.join(fx.dir, "unwritten"));
      const store = new FocusStore(bare);
      await store.write({ path: "b.txt" });

      const raw = readFileSync(path.join(fx.dir, "unwritten", "chapter-review", "focus.json"), "utf8");
      const doc: unknown = JSON.parse(raw);
      assert.ok(typeof doc === "object" && doc !== null && "path" in doc && doc.path === "b.txt");
    }));

  test("a write it cannot perform is swallowed, not thrown", () =>
    withFixture(async (fx) => {
      // A convenience channel: a failure here must never break the click that
      // triggered it. The path is a file, so neither write nor mkdir can work.
      const blocked = vscode.Uri.file(path.join(fx.dir, "a.txt"));
      await new FocusStore(blocked).write({ path: "a.txt" });
    }));

  test("the last write wins", () =>
    withFixture(async (fx) => {
      const store = new FocusStore(vscode.Uri.file(fx.gitDir));
      await store.write({ path: "a.txt", chapterId: "ch-1" });
      await store.write({ path: "b.txt", issueId: "iss-2.1" });

      const written = readFocus(fx);
      assert.equal(written.path, "b.txt");
      assert.equal(written.issueId, "iss-2.1");
      assert.equal(written.chapterId, undefined, "a fresh click replaces the pointer");
    }));
});

suite("focusForNode", () => {
  const entry = { path: "a.txt", status: "modified" as const };
  const hunk = { oldStart: 5, oldLines: 1, newStart: 7, newLines: 1 };

  test("a file anchors to its first hunk", () => {
    const node: Node = { kind: "file", ownerId: "ch-1", entry: { ...entry, hunks: [hunk] } };
    assert.deepEqual(focusForNode(node), {
      path: "a.txt",
      oldPath: undefined,
      hunk,
      chapterId: "ch-1",
    });
  });

  test("a whole-file claim carries no hunk", () => {
    const node: Node = { kind: "file", ownerId: "ch-1", entry };
    assert.equal(focusForNode(node)?.hunk, undefined);
  });

  test("a quarantined file reports no chapter", () => {
    const node: Node = { kind: "file", ownerId: "unassigned", entry };
    assert.equal(focusForNode(node)?.chapterId, undefined);
  });

  test("a hunk anchors to itself", () => {
    const node: Node = { kind: "hunk", ownerId: "ch-2", entry, hunk, index: 0 };
    assert.equal(focusForNode(node)?.hunk, hunk);
  });

  test("an issue carries its id, so the skill can look the finding up", () => {
    const node: Node = {
      kind: "issue",
      issue: { id: "iss-2.3", path: "b.txt", chapterId: "ch-2", severity: "low", note: "x", hunk },
    };
    assert.deepEqual(focusForNode(node), {
      path: "b.txt",
      oldPath: undefined,
      hunk,
      chapterId: "ch-2",
      issueId: "iss-2.3",
    });
  });

  test("a renamed entry carries the pre-rename path, so the before side resolves", () => {
    const node: Node = {
      kind: "file",
      ownerId: "ch-1",
      entry: { path: "c.txt", oldPath: "b.txt", status: "renamed", hunks: [hunk] },
    };
    assert.equal(focusForNode(node)?.oldPath, "b.txt");
  });

  test("a chapter carries only its id", () => {
    const node: Node = {
      kind: "chapter",
      chapter: { id: "ch-1", title: "t", files: [entry] },
    };
    assert.deepEqual(focusForNode(node), { chapterId: "ch-1" });
  });

  test("a node with nothing to point at yields no focus", () => {
    const node: Node = { kind: "staleWarning" };
    assert.equal(focusForNode(node), undefined);
  });
});

suite("resolveFocus", () => {
  // a.txt is "l1 L2 l3 l4 L5 l6" against a base of "l1 l2 l3 l4 l5 l6", so the
  // edits are on lines 2 and 5.
  const anchor = (hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number }) =>
    ({ path: "a.txt", hunk, chapterId: "ch-1" });

  test("reports the changed line, not the top of the hunk's context", () =>
    withFixture(async (fx) => {
      // A hunk spanning lines 3-5, where the edit is on 5: the two lines above it
      // are identical on both sides, which is what unified context looks like.
      const focus = await resolveFocus(
        fx.dir,
        fx.manifest,
        anchor({ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 })
      );
      assert.equal(focus.line, 5, "the first line that differs, not newStart");
    }));

  test("a hunk with no leading context keeps its own start", () =>
    withFixture(async (fx) => {
      const focus = await resolveFocus(
        fx.dir,
        fx.manifest,
        anchor({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 })
      );
      assert.equal(focus.line, 5);
    }));

  test("drops the hunk from what it writes, and keeps the ids", () =>
    withFixture(async (fx) => {
      const focus = await resolveFocus(fx.dir, fx.manifest, {
        path: "a.txt",
        hunk: { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
        chapterId: "ch-2",
        issueId: "iss-2.1",
      });
      assert.deepEqual(focus, {
        path: "a.txt",
        line: 5,
        chapterId: "ch-2",
        issueId: "iss-2.1",
      });
    }));

  test("an anchor with no hunk carries no line", () =>
    withFixture(async (fx) => {
      const focus = await resolveFocus(fx.dir, fx.manifest, { path: "a.txt", chapterId: "ch-1" });
      assert.equal(focus.line, undefined);
    }));

  test("without a manifest the hunk's own start is all there is", async () => {
    const focus = await resolveFocus("", undefined, {
      path: "a.txt",
      hunk: { oldStart: 2, oldLines: 5, newStart: 2, newLines: 5 },
    });
    assert.equal(focus.line, 2);
  });
});
