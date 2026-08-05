// focus.json is the extension's half of the follow-up protocol: it records what
// the reviewer clicked so the skill can resolve "this file" from the terminal.

import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FocusStore, focusForNode, Focus } from "../../focus";
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

  test("a file points at its first hunk's line", () => {
    const node: Node = { kind: "file", ownerId: "ch-1", entry: { ...entry, hunks: [hunk] } };
    assert.deepEqual(focusForNode(node), { path: "a.txt", line: 7, chapterId: "ch-1" });
  });

  test("a whole-file claim carries no line", () => {
    const node: Node = { kind: "file", ownerId: "ch-1", entry };
    assert.deepEqual(focusForNode(node), { path: "a.txt", line: undefined, chapterId: "ch-1" });
  });

  test("a quarantined file reports no chapter", () => {
    const node: Node = { kind: "file", ownerId: "unassigned", entry };
    assert.equal(focusForNode(node)?.chapterId, undefined);
  });

  test("a hunk points at its own line", () => {
    const node: Node = { kind: "hunk", ownerId: "ch-2", entry, hunk, index: 0 };
    assert.deepEqual(focusForNode(node), { path: "a.txt", line: 7, chapterId: "ch-2" });
  });

  test("an issue carries its id, so the skill can look the finding up", () => {
    const node: Node = {
      kind: "issue",
      issue: { id: "iss-2.3", path: "b.txt", chapterId: "ch-2", severity: "low", note: "x", hunk },
    };
    assert.deepEqual(focusForNode(node), {
      path: "b.txt",
      line: 7,
      chapterId: "ch-2",
      issueId: "iss-2.3",
    });
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
