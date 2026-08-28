// Row tooltips. The marker assertions are the point of this file: without it the
// tooltips still render correctly and silently go back to being dismissed the
// moment the pointer reaches them, which no other test would catch.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { Issue } from "../../model";
import { chapterTooltip, fileTooltip, issueTooltip, textTooltip } from "../../tooltips";

/**
 * The style regex VS Code's markdown sanitizer applies to a span, transcribed
 * from its hover renderer. A chip that fails it loses the whole attribute and
 * renders unstyled, which no other assertion here would notice.
 */
const SPAN_STYLE =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

/** What core looks for before it agrees to leave a hover open. */
const KEPT_OPEN = /(\]\(|<\/a>)/;

const FINDING: Issue = {
  id: "iss-1.1",
  path: "src/a.txt",
  chapterId: "ch-1",
  severity: "critical",
  note: "L2 loses the guard",
  confidence: "verified",
};

suite("row tooltips", () => {
  test("every kind survives the pointer entering it", () => {
    const all: vscode.MarkdownString[] = [
      issueTooltip(FINDING),
      chapterTooltip("ch-1", "edits a"),
      chapterTooltip("ch-1"),
      fileTooltip("old.txt", "renamed"),
      fileTooltip(undefined, "a note"),
      textTooltip("plain prose"),
    ];
    for (const md of all) {
      assert.match(md.value, KEPT_OPEN, `no keep-open marker in: ${md.value}`);
      assert.match(md.value, /<!-- \]\( -->$/, "the marker stays last");
    }
  });

  test("the severity chip survives the sanitizer", () => {
    const style = /<span style="([^"]+)"/.exec(issueTooltip(FINDING).value)?.[1];
    assert.ok(style, "the chip should carry an inline style");
    assert.match(style, SPAN_STYLE);
    assert.equal(issueTooltip(FINDING).supportHtml, true, "the chip is a span");
  });

  test("a finding tooltip carries the note and the path the row omits", () => {
    const { value } = issueTooltip(FINDING);
    assert.match(value, /L2 loses the guard/);
    assert.match(value, /`src\/a\.txt`/);
    assert.match(value, /CRITICAL/);
    assert.match(value, /verified/);
  });

  test("a resolved finding says so", () => {
    assert.match(issueTooltip({ ...FINDING, status: "resolved" }).value, /resolved/);
  });

  test("html in a note is escaped, not rendered", () => {
    assert.match(issueTooltip({ ...FINDING, note: "<img src=x>" }).value, /&lt;img src=x&gt;/);
  });

  test("nothing in a tooltip is clickable", () => {
    // The marker is a comment, not a link: no actions here, and no trust flag,
    // so a note that happens to contain a command URI cannot become one.
    const { value, isTrusted } = issueTooltip(FINDING);
    assert.ok(!value.includes("](command:"));
    assert.notEqual(isTrusted, true);
  });
});
