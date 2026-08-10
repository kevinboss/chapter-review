// Where a hunk's change actually is. The diff is generated with `--unified=3`,
// so a hunk's newStart sits up to three identical context lines above the first
// line that differs: jumping to newStart puts the cursor above the code the hunk
// (or a finding pinned to it) is about. Every consumer that needs a line rather
// than a range resolves it here.
//
// Free of the vscode API, so the pure half is testable under plain node.

import { gitShow } from "./git";
import { Hunk, Manifest } from "./model";

/**
 * Offset in lines from a hunk's start to its first real change: the count of
 * leading lines that are identical on both sides.
 */
export function changeOffset(oldLines: string[], newLines: string[], h: Hunk): number {
  const shared = Math.min(h.oldLines, h.newLines);
  const differs = Array.from({ length: shared }, (_, k) => k).find(
    (k) => oldLines[h.oldStart - 1 + k] !== newLines[h.newStart - 1 + k]
  );
  if (differs !== undefined) return differs;
  // Pure insertion or deletion after fully shared context.
  return Math.min(shared, Math.max(h.newLines - 1, 0));
}

/** 1-based line in `newText` where the hunk's first real change lands. */
export function changeLineIn(oldText: string, newText: string, h: Hunk): number {
  // One side absent (an added file, or a manifest whose blobs no longer resolve)
  // leaves nothing to compare, so the hunk's own start is the only answer left.
  if (!oldText || !newText) return h.newStart;
  return h.newStart + changeOffset(oldText.split("\n"), newText.split("\n"), h);
}

/**
 * The same line, reading both sides of the file out of the manifest's pinned
 * commits. An unreadable blob yields "" from gitShow, so a stale manifest
 * degrades to the hunk's start rather than failing the click.
 */
export async function changeLineFor(
  repoRoot: string,
  m: Manifest,
  target: { path: string; oldPath?: string },
  h: Hunk
): Promise<number> {
  const [oldText, newText] = await Promise.all([
    gitShow(repoRoot, m.mergeBase, target.oldPath ?? target.path),
    gitShow(repoRoot, m.headSha ?? m.head, target.path),
  ]);
  return changeLineIn(oldText, newText, h);
}
