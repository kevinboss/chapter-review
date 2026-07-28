// The read-only printers: `focus` (what the reviewer last clicked) and `show`
// (the current manifest), each printed straight to stdout.

import { existsSync, readFileSync } from "node:fs";
import { die, errorMessage, isRecord, tryReadJson } from "./util.ts";
import { focusPath, manifestPath } from "./git.ts";

/**
 * Read a protocol document, or exit with a one-line reason. Reading can fail for
 * reasons unrelated to the contents — the path is a directory, the mode is 000 —
 * and letting readFileSync throw turns those into a stack trace naming an
 * internal Node frame.
 */
function readOrDie(p: string, label: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    die(`chapter-review: cannot read ${label} (${p}): ${errorMessage(e)}`);
  }
}

/**
 * Print `text` only if it parses as JSON. These printers are the agent's window
 * onto the review state — the regeneration step reads chapter ids straight out
 * of `show` — so passing a corrupt document through unremarked invites it to be
 * parsed downstream and misread. Every mutating command already refuses the same
 * file; the printers should not be the one way junk gets out.
 */
function printJsonOrDie(text: string, p: string, label: string): void {
  try {
    JSON.parse(text);
  } catch (e) {
    die(`chapter-review: ${label} is not valid JSON (${p}): ${errorMessage(e)}`);
  }
  process.stdout.write(text);
}

const NO_FOCUS = "No focus yet; the reviewer hasn't selected anything in the extension.";

/** Print the reviewer's current focus pointer, or a note when nothing is selected. */
export function cmdFocus(): void {
  const p = focusPath();
  if (!existsSync(p)) {
    console.log(NO_FOCUS);
    return;
  }
  const text = readOrDie(p, "the focus pointer");
  // An empty file means the same thing as no file: nothing is selected. Erroring
  // on one and not the other made an agent handle two spellings of "no focus".
  if (text.trim() === "") {
    console.log(NO_FOCUS);
    return;
  }
  const parsed = tryReadJson(() => text);
  if (!parsed.ok) {
    die(`chapter-review: the focus pointer is not valid JSON (${p}): ${parsed.error}`);
  }
  // Shape-checked, not just parsed: `[]` is valid JSON and was printed straight
  // through, leaving the caller to resolve a pointer with no path in it.
  if (!isRecord(parsed.value) || typeof parsed.value.path !== "string") {
    die(
      `chapter-review: the focus pointer has no "path" (${p}); ` +
        "the extension writes it, so this file has been edited or truncated."
    );
  }
  process.stdout.write(text);
}

/** Print the current manifest, or a note when none has been written for this branch. */
export function cmdShow(): void {
  const p = manifestPath();
  if (!existsSync(p)) {
    die("chapter-review: no manifest yet; nothing has been written for this branch.", 0);
  }
  printJsonOrDie(readOrDie(p, "the manifest"), p, "the manifest");
}
