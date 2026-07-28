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
  if (!pathInManifest(manifest, flags.path)) {
    console.error(
      `chapter-review: ${flags.path} isn't in the current manifest; check the path.`
    );
  }

  const reviewed = readProgress(manifest);
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
