import { changeOffset } from "./changeLine";
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

  // The fold carries the read position (0-based into oldLines) from one hunk to
  // the next, and returns where the last one left off.
  const cursor = sorted.reduce((read, h) => {
    // oldLines === 0 marks an insertion after line oldStart (git convention);
    // otherwise oldStart is the first replaced line.
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    out.push(...oldLines.slice(read, start));
    changeLines.set(h, out.length + changeOffset(oldLines, newLines, h) + 1);
    out.push(...newLines.slice(h.newStart - 1, h.newStart - 1 + h.newLines));
    return start + h.oldLines;
  }, 0);
  out.push(...oldLines.slice(cursor));

  return { text: out.join("\n"), changeLines };
}

/** Does a hunk's span on one side end before 1-based `line` on that side? */
function endsBefore(start: number, count: number, line: number): boolean {
  // An empty span sits *after* line `start`, so it is behind `line` once past it.
  return count === 0 ? start < line : start + count <= line;
}

const growth = (h: Hunk): number => h.newLines - h.oldLines;

/**
 * Where 1-based line `at` of the head file lands in the patch `applyHunks`
 * builds from `applied`, given every hunk the file has in the diff.
 * Undefined when the line belongs to a hunk the patch leaves out, since that
 * line does not exist in the scoped document.
 */
export function scopedLine(at: number, applied: Hunk[], fileHunks: Hunk[]): number | undefined {
  const inNew = (h: Hunk): boolean => at >= h.newStart && at < h.newStart + h.newLines;
  const own = applied.find(inNew);
  if (own) {
    const start = own.oldLines === 0 ? own.oldStart + 1 : own.oldStart;
    const shift = applied
      .filter((h) => h !== own && endsBefore(h.oldStart, h.oldLines, start))
      .reduce((n, h) => n + growth(h), 0);
    return start + shift + (at - own.newStart);
  }
  if (fileHunks.some(inNew)) {
    return undefined;
  }
  const base =
    at - fileHunks.filter((h) => endsBefore(h.newStart, h.newLines, at)).reduce((n, h) => n + growth(h), 0);
  return base + applied.filter((h) => endsBefore(h.oldStart, h.oldLines, base)).reduce((n, h) => n + growth(h), 0);
}
