import { die } from "./util.ts";
import { parseFlags, parseHunk } from "./flags.ts";
import { progressPath, roundProgressPath } from "./git.ts";
import { hunkEquals, readManifestOrDie, readProgress, writeProgress } from "./manifest.ts";
import { earlierRounds, roundHolding } from "./rounds.ts";

/**
 * Clear the reviewer's checkmark on a file (or one hunk) by removing the
 * matching unit from progress.json. Direct mutation, like `issue resolve`.
 */
export function cmdUncheck(rest: string[]): void {
  const flags = parseFlags(rest, ["path", "hunk"]);
  if (flags.path === undefined) die("chapter-review: uncheck needs --path");
  const hunk = flags.hunk !== undefined ? parseHunk(flags.hunk) : undefined;

  const manifest = readManifestOrDie();
  // The checkmark lives in the latest round whose diff holds the file.
  const round = roundHolding([...earlierRounds(), manifest], flags.path);
  // Refused, not warned: it exited 0 after printing this, so a typo read as
  // "already unreviewed" — the opposite of what happened. Same verdict as
  // `issue add` on a path the manifest does not hold.
  if (round === undefined) {
    die(
      `chapter-review: ${flags.path} is in no round's diff, so it has no checkmark to clear.\n` +
        "  Check the spelling; `chapter-review show` lists the paths."
    );
  }
  const progress = round.round === manifest.round ? progressPath() : roundProgressPath(round.round);

  const reviewed = readProgress(progress);
  // Keep all but the target: one hunk with --hunk, else every unit of the file.
  const keep = reviewed.filter((u) => {
    if (u.path !== flags.path) return true;
    return hunk ? !hunkEquals(u.hunk, hunk) : false;
  });
  const removed = reviewed.length - keep.length;
  if (removed === 0) {
    console.log(`Nothing to uncheck for ${flags.path} (not marked reviewed).`);
    return;
  }

  const scope = hunk
    ? `${flags.path} @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    : flags.path;
  writeProgress(keep, progress);
  const where = round.round === manifest.round ? "" : ` in round ${String(round.round)}`;
  console.log(`Unchecked ${scope}${where} (${removed} unit${removed > 1 ? "s" : ""}).`);
}
