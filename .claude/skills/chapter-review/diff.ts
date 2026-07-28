// Reading the branch diff, so `write` can check the one partition rule the
// structural validator cannot see: that every hunk is claimed exactly once.
//
// validate.ts works on the manifest alone, which catches double claims and
// overlaps but not a hunk nobody claimed — the failure that ships a review with
// changes missing from every chapter, looking complete the whole way.

import { execFileSync } from "node:child_process";
import type { FileEntry, FileStatus, Hunk, Manifest } from "./types.ts";
import { allEntries, hunksOverlap } from "./manifest.ts";

/**
 * A diff hunk plus the line numbers it actually changed.
 *
 * Coverage is judged on those lines, not on the hunk's outer span. Matching a
 * claimed range against the span by overlap tolerates a coordinate transcribed a
 * step out: it still lands inside the real hunk and reads as claimed, and the
 * wrong number goes into the manifest for the extension to render from. Changed
 * lines are exact, while still allowing one hunk to be split across chapters —
 * git merges edits within three lines of each other into a single hunk, so a
 * claimed range legitimately need not equal any `@@` header.
 */
export interface DiffHunk extends Hunk {
  changedOld: number[];
  changedNew: number[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: DiffHunk[];
}

/**
 * The diff `mergeBase..HEAD`, or undefined when git cannot answer (in which case
 * the caller skips the check rather than blocking the write).
 *
 * Flags match what SKILL.md tells the agent to run, so the hunk headers parsed
 * here are the ones it was told to copy into the draft. `--unified=3` in
 * particular decides where hunks split, and therefore what "claimed" means.
 */
export function branchDiff(mergeBase: string): string | undefined {
  try {
    return execFileSync(
      "git",
      ["diff", "-M", "--no-color", "--unified=3", `${mergeBase}..HEAD`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }
    );
  } catch {
    return undefined;
  }
}

/**
 * Which path the entry is keyed by. A deleted file takes its old path, matching
 * how the manifest names it; a rename takes the new one, with oldPath carrying
 * the origin so the move stays followable.
 */
function entryPaths(
  header: string[],
  aPath: string,
  bPath: string
): { path: string; oldPath?: string; status: FileStatus } {
  if (header.some((l) => l.startsWith("deleted file"))) return { path: aPath, status: "deleted" };
  if (header.some((l) => l.startsWith("new file"))) return { path: bPath, status: "added" };
  const from = header.find((l) => l.startsWith("rename from "));
  const to = header.find((l) => l.startsWith("rename to "));
  if (from !== undefined && to !== undefined) {
    return {
      path: to.slice("rename to ".length),
      oldPath: from.slice("rename from ".length),
      status: "renamed",
    };
  }
  return { path: bPath, status: "modified" };
}

// A hunk header's count is omitted when it is 1 (`@@ -3 +3,2 @@`). Read through
// .at(), which types the group as possibly-absent; indexing claims `string`.
const count = (v: string | undefined): number => (v === undefined ? 1 : Number(v));

/**
 * Hunks from the body of one file's diff section, each carrying the old- and
 * new-side line numbers it changed.
 *
 * Walks the body counting lines: a `-` consumes an old line, a `+` a new one,
 * context consumes both. `\ No newline at end of file` is a note about the line
 * before it, not a line, so it advances nothing.
 */
function parseHunks(body: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const at = { old: 0, new: 0 };
  for (const line of body) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hunks.push({
        oldStart: Number(h[1]),
        oldLines: count(h.at(2)),
        newStart: Number(h[3]),
        newLines: count(h.at(4)),
        changedOld: [],
        changedNew: [],
      });
      at.old = Number(h[1]);
      at.new = Number(h[3]);
      continue;
    }
    const current = hunks.at(-1);
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      current.changedOld.push(at.old);
      at.old += 1;
    } else if (line.startsWith("+")) {
      current.changedNew.push(at.new);
      at.new += 1;
    } else if (line.startsWith(" ")) {
      at.old += 1;
      at.new += 1;
    }
  }
  return hunks;
}

/** File entries and hunk ranges from unified diff text. */
export function parseDiff(text: string): DiffFile[] {
  return text
    .split(/^diff --git /m)
    .slice(1)
    .flatMap((section) => {
      const lines = section.split("\n");
      const paths = /^(?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(lines[0] ?? "");
      if (!paths) return [];
      const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
      const header = lines.slice(0, firstHunk === -1 ? lines.length : firstHunk);
      const { path, oldPath, status } = entryPaths(header, paths[1], paths[2]);

      const hunks = parseHunks(firstHunk === -1 ? [] : lines.slice(firstHunk));
      return [oldPath === undefined ? { path, status, hunks } : { path, oldPath, status, hunks }];
    });
}

const range = (h: Hunk): string =>
  `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

const within = (line: number, start: number, len: number): boolean =>
  len > 0 && line >= start && line < start + len;

/**
 * The first changed line of `h` that no claimed range covers, or undefined when
 * the hunk is fully accounted for. `all` distinguishes a hunk nobody claimed at
 * all from one claimed with the wrong coordinates, which read the same to a
 * caller but mean quite different things to whoever has to fix the draft.
 */
function uncoveredLines(
  h: DiffHunk,
  claimed: Hunk[]
): { line: number; side: "old" | "new"; all: boolean } | undefined {
  const missOld = h.changedOld.filter(
    (l) => !claimed.some((c) => within(l, c.oldStart, c.oldLines))
  );
  const missNew = h.changedNew.filter(
    (l) => !claimed.some((c) => within(l, c.newStart, c.newLines))
  );
  const total = h.changedOld.length + h.changedNew.length;
  const all = missOld.length + missNew.length === total;
  // .at(), not [0]: indexing is typed `number`, which would narrow the guards away.
  const line = missOld.at(0);
  if (line !== undefined) return { line, side: "old", all };
  const newLine = missNew.at(0);
  if (newLine !== undefined) return { line: newLine, side: "new", all };
  return undefined;
}

/**
 * Where the partition and the real diff disagree: hunks nobody claimed, claimed
 * ranges the diff does not have, and claimed paths absent from it entirely.
 *
 * Ranges are compared by overlap rather than equality, so a draft that merges
 * two adjacent hunks into one range still reads as covering both. Double claims
 * and overlaps between chapters are validate.ts's job and are not repeated here.
 */
export function coverageErrors(manifest: Manifest, diffText: string): string[] {
  const errors: string[] = [];
  const diff = parseDiff(diffText);
  const byPath = new Map(diff.map((f) => [f.path, f]));
  const entries = allEntries(manifest);

  const claimedFor = (path: string): FileEntry[] => entries.filter((e) => e.path === path);

  for (const e of entries) {
    if (byPath.has(e.path)) continue;
    errors.push(`${e.path} is claimed but does not appear in the diff`);
  }

  for (const file of diff) {
    const claims = claimedFor(file.path);
    if (claims.length === 0) {
      errors.push(`${file.path} is in the diff but no chapter or unassigned entry claims it`);
      continue;
    }
    // git already classified this file, and the extension renders from the
    // manifest's answer: an "added" entry gets an empty left-hand side, so a
    // modified file mislabelled that way hides its own before-diff. The
    // structural pass only compares one entry against another for the same
    // path, so a single mislabelled entry had nothing to disagree with.
    for (const c of claims) {
      if (c.status !== file.status) {
        errors.push(
          `${file.path} is claimed as "${c.status}" but the diff has it as "${file.status}"`
        );
      }
    }
    // A claim without `hunks` takes the file's whole diff, so nothing is left.
    if (claims.some((c) => c.hunks === undefined)) continue;
    const claimed = claims.flatMap((c) => c.hunks ?? []);
    for (const h of file.hunks) {
      const missed = uncoveredLines(h, claimed);
      if (missed === undefined) continue;
      errors.push(
        missed.all
          ? `${file.path} ${range(h)} is in the diff but unclaimed`
          : `${file.path} ${range(h)} is only partly claimed: ${missed.side} line ${missed.line} ` +
            `is changed here but falls in no claimed range`
      );
    }
    for (const c of claimed) {
      if (!file.hunks.some((h) => hunksOverlap(c, h))) {
        errors.push(`${file.path} claims ${range(c)}, which the diff does not have`);
      }
    }
  }
  return errors;
}
