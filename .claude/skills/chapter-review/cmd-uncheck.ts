import { die } from "./util.ts";
import { parseFlags, parseHunk } from "./flags.ts";
import {
  hunkEquals,
  pathInManifest,
  readManifestOrDie,
  readProgress,
  writeProgress,
} from "./manifest.ts";

/**
 * Clear the reviewer's checkmark on a file (or one hunk) by removing the
 * matching unit from progress.json. Direct mutation, like `issue resolve`.
 */
export function cmdUncheck(rest: string[]): void {
  const flags = parseFlags(rest, ["path", "hunk"]);
  if (flags.path === undefined) die("chapter-review: uncheck needs --path");
  const hunk = flags.hunk !== undefined ? parseHunk(flags.hunk) : undefined;

  const manifest = readManifestOrDie();
  // Refused, not warned: it exited 0 after printing this, so a typo read as
  // "already unreviewed" — the opposite of what happened. Same verdict as
  // `issue add` on a path the manifest does not hold.
  if (!pathInManifest(manifest, flags.path)) {
    die(
      `chapter-review: ${flags.path} is not in the current manifest, so it has no checkmark to clear.\n` +
        "  Check the spelling; `chapter-review show` lists the paths."
    );
  }

  const reviewed = readProgress();
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
  writeProgress(keep);
  console.log(`Unchecked ${scope} (${removed} unit${removed > 1 ? "s" : ""}).`);
}
