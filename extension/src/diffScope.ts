import { Hunk } from "./model";

export interface ScopedPatch {
  /** Merge-base content with only the given hunks applied. */
  text: string;
  /** Per hunk: 1-based line in `text` where its first real change lands. */
  changeLines: Map<Hunk, number>;
}

/**
 * Rebuilds "the file as if only these hunks had happened" from the two full
 * versions plus hunk coordinates. Diffing merge-base content against this
 * yields exactly the chapter's changes, nothing else.
 */
export function applyHunks(oldText: string, newText: string, hunks: Hunk[]): ScopedPatch {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const out: string[] = [];
  const changeLines = new Map<Hunk, number>();

  let cursor = 0; // 0-based index into oldLines
  for (const h of sorted) {
    // oldLines === 0 marks an insertion after line oldStart (git convention);
    // otherwise oldStart is the first replaced line.
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    out.push(...oldLines.slice(cursor, start));
    changeLines.set(h, out.length + firstChangeOffset(oldLines, newLines, h) + 1);
    out.push(...newLines.slice(h.newStart - 1, h.newStart - 1 + h.newLines));
    cursor = start + h.oldLines;
  }
  out.push(...oldLines.slice(cursor));

  return { text: out.join("\n"), changeLines };
}

// Hunk coordinates include unified-diff context lines; skip past the leading
// lines that are identical on both sides.
function firstChangeOffset(oldLines: string[], newLines: string[], h: Hunk): number {
  const shared = Math.min(h.oldLines, h.newLines);
  for (let k = 0; k < shared; k++) {
    if (oldLines[h.oldStart - 1 + k] !== newLines[h.newStart - 1 + k]) {
      return k;
    }
  }
  // Pure insertion or deletion after fully shared context.
  return Math.min(shared, Math.max(h.newLines - 1, 0));
}
