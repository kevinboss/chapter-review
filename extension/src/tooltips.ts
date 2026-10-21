import * as vscode from "vscode";
import { isOpen, Issue, IssueSeverity } from "./model";

/**
 * Tooltips for the tree rows.
 *
 * They are markdown, not strings, for one reason: core dismisses a row's hover
 * as soon as the pointer enters it unless the tooltip is a MarkdownString whose
 * value contains `](` or `</a>`. It tests the raw markdown rather than the
 * rendered result, so the trailing comment below is enough and no link has to be
 * offered. Drop it and every tooltip here goes back to vanishing when you reach
 * for it.
 *
 * The severity chip is constrained by the markdown sanitizer: a `style`
 * attribute survives only on a `<span>`, and only as `color`, then
 * `background-color`, then `border-radius`, each with a hex or `var(--vscode-*)`
 * value and no whitespace anywhere in the string.
 */

const KEEP_OPEN = "<!-- ]( -->";

const SEVERITY_BACKGROUND: Record<IssueSeverity, string> = {
  critical: "--vscode-inputValidation-errorBackground",
  high: "--vscode-inputValidation-warningBackground",
  low: "--vscode-inputValidation-infoBackground",
};

/**
 * Finding row: severity, id, the full note, and the path the row omits, with its
 * line when it has one. A finding outside the diff adds the change that caused it.
 */
export function issueTooltip(issue: Issue, outside: boolean): vscode.MarkdownString {
  const at = issue.line === undefined ? issue.path : `${issue.path}:${String(issue.line)}`;
  const where = `\`${escapeHtml(at)}\`${outside ? " · outside the diff" : ""}`;
  const cause = issue.cause && `caused by \`${escapeHtml(issue.cause.path)}\``;
  return tooltip([header(issue), escapeHtml(issue.note), where, cause]);
}

/** Chapter row: the id the CLI takes, then the chapter's own summary. */
export function chapterTooltip(id: string, description?: string): vscode.MarkdownString {
  return tooltip([`\`${escapeHtml(id)}\``, description && escapeHtml(description)]);
}

/** File row: where it came from, and whatever the skill noted about it. */
export function fileTooltip(oldPath?: string, note?: string): vscode.MarkdownString {
  return tooltip([oldPath && `was \`${escapeHtml(oldPath)}\``, note && escapeHtml(note)]);
}

/** Plain prose that still has to survive the pointer reaching for it. */
export function textTooltip(text: string): vscode.MarkdownString {
  return tooltip([escapeHtml(text)]);
}

/** Paragraphs, then the marker, which stays last so nothing renders after it. */
function tooltip(paragraphs: (string | undefined | false)[]): vscode.MarkdownString {
  const body = paragraphs.filter(Boolean).join("\n\n");
  const md = new vscode.MarkdownString(`${body}\n\n${KEEP_OPEN}`, true);
  md.supportHtml = true;
  return md;
}

function header(issue: Issue): string {
  const parts = [
    chip(issue.severity.toUpperCase(), SEVERITY_BACKGROUND[issue.severity]),
    issue.confidence === "verified" ? "verified" : "suspected",
    `\`${escapeHtml(issue.id)}\``,
  ];
  if (!isOpen(issue)) {
    parts.push("resolved");
  }
  return parts.join(" · ");
}

function chip(text: string, background: string): string {
  return `<span style="color:var(--vscode-foreground);background-color:var(${background});border-radius:3px;">&nbsp;${text}&nbsp;</span>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
