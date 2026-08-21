// Discarding a review. The whole protocol directory goes, not just the manifest,
// because either leftover is worse than both states. `chapters.json.bak` is
// where the next generation carries findings back from (the CLI reads it
// whenever the manifest is missing), so a review cleared with its backup intact
// returns in full on the next write. And `progress.json` outlives the manifest
// that gave its rows meaning, so checkmarks from an abandoned review land on
// whatever paths the next one happens to claim.

import * as vscode from "vscode";
import { allEntries, isOpen, type Manifest } from "./model";

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The confirm dialog's detail line: what this clear is about to throw away.
 * Files are counted as distinct paths rather than entries, since a file split
 * across two chapters is still one file to the reviewer.
 *
 * The manifest can be undefined here — an unreadable chapters.json leaves the
 * view empty and clearing is the way out of that — so the text has to work
 * without one.
 */
export function clearDetail(manifest: Manifest | undefined): string {
  const tail =
    "The findings and your review checkmarks go with it. " +
    "Generating again with the chapter-review skill starts a fresh review.";
  if (!manifest) {
    return `No manifest is loaded, so its contents cannot be listed. ${tail}`;
  }
  const files = new Set(allEntries(manifest).map((e) => e.path)).size;
  const open = (manifest.issues ?? []).filter(isOpen).length;
  // Always at least two entries, so the join below never opens on a comma.
  const counts = [plural(manifest.chapters.length, "chapter"), plural(files, "file")];
  if (open > 0) {
    counts.push(plural(open, "open finding"));
  }
  const last = counts.pop();
  return `${manifest.head}: ${counts.join(", ")} and ${last}. ${tail}`;
}

/** Is there review state in this repository at all? */
export async function hasReviewState(dir: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(dir);
    return true;
  } catch {
    return false; // never generated here, or already cleared
  }
}

/** Ask before discarding. True when the reviewer confirmed. */
export async function confirmClear(manifest: Manifest | undefined): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "Discard this chapter review?",
    { modal: true, detail: clearDetail(manifest) },
    "Discard"
  );
  return choice === "Discard";
}

/**
 * Remove the protocol directory `<git-dir>/chapter-review/` and everything in
 * it. Not sent to the trash: this is tool state inside `.git` rather than
 * anything the user wrote, and a recoverable copy is what the note at the top
 * of this file rules out on purpose.
 */
export async function clearReviewState(dir: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
}
