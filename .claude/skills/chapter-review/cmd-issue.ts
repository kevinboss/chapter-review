import { die } from "./util.ts";
import { branchDiff, parseDiff } from "./diff.ts";
import { issueFieldsFromFlags, parseFlags } from "./flags.ts";
import {
  allEntries,
  hunkEquals,
  installManifest,
  issueBucket,
  issuesOf,
  nextIssueId,
  ownerChapterId,
  pathInManifest,
  readManifestOrDie,
  storedIssueSeq,
  withIssues,
} from "./manifest.ts";
import type { Hunk, Issue, Manifest, ManifestStats } from "./types.ts";

/**
 * Reject a --chapter naming a chapter the manifest does not have. The id format
 * alone is not enough: a typo'd ch-N is well-formed, so the finding is written
 * pointing at nothing and the extension groups it under no chapter. The command
 * already warns when it merely *guesses* an owner, so accepting a provably wrong
 * one in silence is the inconsistency.
 */
function requireRealChapter(manifest: Manifest, chapterId: string | undefined): void {
  if (chapterId === undefined) return;
  if (manifest.chapters.some((ch) => ch.id === chapterId)) return;
  const known = manifest.chapters.map((ch) => ch.id).join(", ");
  die(
    `chapter-review: no chapter "${chapterId}" in the manifest` +
      (known ? ` (have ${known})` : "") +
      "."
  );
}

/**
 * Reject a --chapter that does not hold the path the finding anchors to. The
 * pairing cannot survive: `chapterId` is read back off path(+hunk) on every
 * `write`, so the finding is moved to the chapter that actually owns the file and
 * renumbered, in a report line indistinguishable from one the branch caused. That
 * makes it worse than the typo requireRealChapter already refuses, which at least
 * stayed put.
 *
 * A path split across several chapters is what --chapter is *for*, so any one of
 * its owners is accepted; only a chapter owning none of it is refused.
 */
function requireChapterOwnsPath(
  manifest: Manifest,
  p: string,
  chapterId: string | undefined
): void {
  if (chapterId === undefined) return;
  const chapter = manifest.chapters.find((ch) => ch.id === chapterId);
  // A chapter no manifest has is requireRealChapter's error to report, not this one.
  if (!chapter || chapter.files.some((f) => f.path === p)) return;
  const owners = manifest.chapters.filter((c) => c.files.some((f) => f.path === p));
  die(
    `chapter-review: ${chapterId} does not hold ${p}, so a finding filed there would ` +
      "not stay: `write` reads the owner back off the path and moves it, renumbering it.\n" +
      (owners.length > 0
        ? `  ${p} is in ${owners.map((o) => o.id).join(", ")}. Name one of those, ` +
          "or pass --hunk to pin a range one of them owns."
        : `  ${p} is quarantined in unassigned, so no chapter can own a finding on it. ` +
          "Drop --chapter, or re-partition so a chapter holds the file.")
  );
}

/**
 * Reject a --path the manifest does not hold, in a chapter or in unassigned.
 * Such a finding lands with no chapterId, which is indistinguishable from a
 * legitimately quarantined path, so a typo reads as intentional.
 */
function requireRealPath(manifest: Manifest, p: string | undefined): void {
  if (p === undefined) return;
  if (pathInManifest(manifest, p)) return;
  die(
    `chapter-review: "${p}" is not in the current manifest, so a finding on it ` +
      "would anchor to nothing.\n" +
      "  Check the spelling, or use the path as the diff records it " +
      "(repo-relative, forward slashes). `chapter-review show` lists them."
  );
}

/**
 * Reject an --old-path that disagrees with the rename the partition records.
 * The value was stored unchecked, so a typo'd or invented origin sat in the
 * finding looking like the file's history, and the manifest right beside it
 * says otherwise.
 */
function requireRealOldPath(
  manifest: Manifest,
  p: string | undefined,
  oldPath: string | undefined
): void {
  if (oldPath === undefined || p === undefined) return;
  const recorded = allEntries(manifest)
    .filter((f) => f.path === p)
    .map((f) => f.oldPath)
    .find((o) => o !== undefined);
  if (recorded === oldPath) return;
  die(
    recorded === undefined
      ? `chapter-review: ${p} is not recorded as renamed, so --old-path does not apply.`
      : `chapter-review: ${p} was renamed from "${recorded}", not "${oldPath}".`
  );
}

const rangeList = (hs: Hunk[]): string =>
  hs.map((h) => `-${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`).join("  ");

/**
 * Reject a --chapter that holds the path but not the range the finding pins to.
 * requireRealHunk accepts any range the partition claims *somewhere*, so a finding
 * could be filed in ch-1 pinned to a range ch-2 owns. It does not survive: `write`
 * reads the owner back off path+hunk and moves it. Until then it is worse than
 * mis-filed, because the extension looks the range up among that chapter's own
 * claims, finds nothing, and cannot place the finding at all.
 *
 * A chapter claiming the path whole has no ranges of its own, and pinning to one of
 * the file's diff hunks is legitimate there.
 */
function requireChapterOwnsHunk(
  manifest: Manifest,
  p: string,
  hunk: Hunk | undefined,
  chapterId: string | undefined
): void {
  if (chapterId === undefined || hunk === undefined) return;
  const chapter = manifest.chapters.find((ch) => ch.id === chapterId);
  // Neither a missing chapter nor one that does not hold the path is this
  // check's error to report; both die earlier.
  if (!chapter) return;
  const claimed = chapter.files.filter((f) => f.path === p).flatMap((f) => f.hunks ?? []);
  if (claimed.length === 0 || claimed.some((h) => hunkEquals(h, hunk))) return;
  const owner = manifest.chapters.find((c) =>
    c.files.some((f) => f.path === p && (f.hunks ?? []).some((h) => hunkEquals(h, hunk)))
  );
  die(
    `chapter-review: ${chapterId} does not claim that range of ${p}, so a finding pinned ` +
      "there would not stay: `write` reads the owner back off path+hunk and moves it.\n" +
      `  ${chapterId} claims: ${rangeList(claimed)}\n` +
      (owner
        ? `  That range belongs to ${owner.id}. Name it instead, or pick one of the above.`
        : "  No chapter claims that range. Pick one of the above.")
  );
}

/**
 * Reject a --hunk pinning the finding to a range that does not exist. The range
 * is stored as the anchor, so a typo'd one sends the extension to lines the diff
 * does not have.
 *
 * Which ranges are legal depends on how the path is claimed. A hunk-split path
 * must name one of the partition's own ranges. A path claimed whole has no such
 * ranges, but its file still has hunks in the diff, and pinning to one is the
 * only way two findings about different parts of that file stay distinguishable
 * — so those are checked against the diff instead.
 */
function requireRealHunk(manifest: Manifest, p: string, hunk: Hunk | undefined): void {
  if (hunk === undefined) return;
  const claimed = allEntries(manifest)
    .filter((f) => f.path === p)
    .flatMap((f) => f.hunks ?? []);
  // Equality, not overlap, in both cases. Overlap let a wildly wrong range
  // through, since `1,999999999,1,999999999` touches every hunk in the file.
  if (claimed.length > 0) {
    if (!claimed.some((h) => hunkEquals(h, hunk))) {
      die(
        `chapter-review: --hunk is not a range claimed for ${p}.\n` +
          `  claimed: ${rangeList(claimed)}\n  Pass one of these exactly; a finding pins to a hunk the partition owns.`
      );
    }
    return;
  }
  const diffText = branchDiff(manifest.mergeBase);
  // Unreadable diff: accept rather than block, as the coverage check does.
  if (diffText === undefined) return;
  const real = parseDiff(diffText).find((f) => f.path === p)?.hunks ?? [];
  if (!real.some((h) => hunkEquals(h, hunk))) {
    die(
      `chapter-review: --hunk is not a hunk of ${p} in this diff.\n` +
        `  hunks: ${rangeList(real)}\n` +
        "  Pass one exactly, or drop --hunk to anchor the finding to the whole file."
    );
  }
}

function findIssue(manifest: Manifest, id: string): { issues: Issue[]; issue: Issue } {
  const issues = issuesOf(manifest);
  const issue = issues.find((i) => i.id === id);
  if (!issue) die(`chapter-review: no issue "${id}" in the manifest.`);
  return { issues, issue };
}

function saveIssues(
  manifest: Manifest,
  issues: Issue[],
  onOk: (stats: ManifestStats, dest: string) => void
): void {
  installManifest(withIssues(manifest, issues), onOk);
}

/** Per-subcommand usage. The top-level help lists `add`'s flags only. */
function issueUsage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out(
    [
      "usage: chapter-review issue <subcommand>",
      "",
      "  add    <flags>       record a finding (--path --severity --note required)",
      "  set    <id> <flags>  revise a finding; takes the same flags as `add`",
      "  resolve <id>         mark a finding resolved",
      "  reopen  <id>         reopen a resolved finding",
      "  verify  <id>         mark the premise confirmed outside the diff",
      "  unverify <id>        mark the premise unchecked (suspected)",
      "  rm     <id>          drop a finding; its id is retired, not reused",
      "  list                 list findings",
      "",
      "flags for add and set:",
      "  --path P             file the finding is about; must be in the diff",
      "  --old-path P         pre-rename path, for a renamed file",
      "  --severity S         critical | high | low",
      "  --note \"…\"           one line: what is wrong",
      "  --confidence C       suspected (default) | verified",
      "  --chapter ch-N       owning chapter; inferred from --path when omitted",
      "  --hunk o,ol,n,nl     oldStart,oldLines,newStart,newLines; pins the finding",
      "                       to that range, and picks the owner on a split path",
      "  --status S           open | resolved",
    ].join("\n")
  );
  process.exit(code);
}

/**
 * Dispatch an `issue` subcommand (add, set, resolve, reopen, verify, unverify,
 * rm, list) against the current manifest.
 */
export function cmdIssue(sub: string | undefined, rest: string[]): void {
  // Before readManifestOrDie: the flags are worth reading in a repo that has no
  // review yet.
  if (sub === "help" || sub === "--help" || sub === "-h") issueUsage(0);
  const manifest = readManifestOrDie();
  const issues = issuesOf(manifest);

  switch (sub) {
    case "add": {
      const flags = parseFlags(rest, [
        "path",
        "oldPath",
        "note",
        "severity",
        "confidence",
        "chapterId",
        "status",
        "hunk",
      ]);
      const fields = issueFieldsFromFlags(flags);
      requireRealChapter(manifest, fields.chapterId);
      for (const req of ["path", "severity", "note"] as const) {
        if (fields[req] === undefined) {
          die(`chapter-review: issue add needs --${req}`);
        }
      }
      // The loop above exits the process unless all three are set.
      const { path: fieldPath } = fields;
      if (fieldPath === undefined) return;
      requireRealPath(manifest, fieldPath);
      requireRealOldPath(manifest, fieldPath, fields.oldPath);
      requireRealHunk(manifest, fieldPath, fields.hunk);
      requireChapterOwnsPath(manifest, fieldPath, fields.chapterId);
      requireChapterOwnsHunk(manifest, fieldPath, fields.hunk, fields.chapterId);
      // Warned, not refused: re-running a command is the usual cause, but two
      // findings can legitimately share a path and note if a reviewer wants them
      // tracked separately, so the caller decides.
      // hunkEquals is false when either side is absent, which is exactly the
      // case for two whole-file findings on the same path: they share an anchor.
      const sameAnchor = (a?: Hunk, b?: Hunk): boolean =>
        (a === undefined && b === undefined) || hunkEquals(a, b);
      const twin = issues.find(
        (i) => i.path === fieldPath && i.note === fields.note && sameAnchor(i.hunk, fields.hunk)
      );
      if (twin) {
        console.error(
          `chapter-review: ${twin.id} already says this about ${fieldPath}; ` +
            "adding a second finding. `issue rm` one of them if that was a re-run."
        );
      }
      // Infer the owning chapter from the path when not given. A --hunk picks
      // the chapter that owns that range; on an ambiguous split (path in >1
      // chapter, no hunk to match) we pick the first and say so.
      if (fields.chapterId === undefined) {
        const owners = manifest.chapters.filter((ch) =>
          ch.files.some((f) => f.path === fields.path)
        );
        const inferred = ownerChapterId(manifest, fieldPath, fields.hunk, undefined);
        if (inferred) fields.chapterId = inferred;
        // Warn when the owner had to be guessed. requireRealHunk has already
        // rejected a range that matches nothing, so the only guess left is a
        // split path with no --hunk to choose by.
        if (owners.length > 1 && fields.hunk === undefined) {
          console.error(
            `chapter-review: ${fields.path} spans ${owners.map((o) => o.id).join(", ")}; ` +
              `recorded in ${inferred} and anchored to the whole file. ` +
              `pass --chapter to choose, or --hunk to pin a range.`
          );
        }
        // Nothing to infer from means the path is quarantined, and the guidance
        // is not to file findings against noise. Said here because the add is
        // where the decision happens: the confirmation line reads like any other,
        // and only a later `issue list` shows the finding as unassigned.
        const quarantined =
          inferred === undefined
            ? manifest.unassigned.find((f) => f.path === fieldPath)
            : undefined;
        if (quarantined) {
          console.error(
            `chapter-review: ${fieldPath} is quarantined as noise ` +
              `(${quarantined.reason ?? "no reason recorded"}), so no chapter owns this ` +
              "finding and it is numbered in the chapter-0 sequence. If the change there is " +
              "worth a finding, it is not noise: partition it into a chapter instead."
          );
        }
      }
      const { severity, note } = fields;
      if (severity === undefined || note === undefined) return;
      // Allocated once the owner is settled, because the number counts in that
      // chapter's own sequence: the first finding in ch-2 is iss-2.1.
      const id = nextIssueId(manifest, issues, fields.chapterId);
      const issue: Issue = {
        id,
        ...fields,
        path: fieldPath,
        severity,
        note,
        // Stamped here because nothing else ever sets it: the field was in the
        // schema, carried across regeneration, and always absent.
        createdAt: new Date().toISOString(),
      };
      const confidence = issue.confidence === "verified" ? "verified" : "suspected";
      saveIssues(manifest, [...issues, issue], () =>
        { console.log(`Added ${id} (${issue.severity}, ${confidence}) on ${issue.path}${issue.chapterId ? ` in ${issue.chapterId}` : ""}.`); }
      );
      break;
    }
    case "set": {
      const [id, ...flagArgs] = rest;
      if (!id) die("chapter-review: issue set needs an issue id.");
      const { issue } = findIssue(manifest, id);
      const flags = parseFlags(flagArgs, [
        "path",
        "oldPath",
        "note",
        "severity",
        "confidence",
        "chapterId",
        "status",
        "hunk",
      ]);
      const updates = issueFieldsFromFlags(flags);
      // Otherwise it reports "Updated iss-N." having changed nothing.
      if (Object.keys(updates).length === 0) {
        die(
          `chapter-review: issue set ${id} needs at least one field to change.\n` +
            "  --path --old-path --note --severity --confidence --chapter --hunk --status"
        );
      }
      requireRealChapter(manifest, updates.chapterId);
      requireRealPath(manifest, updates.path);
      requireRealOldPath(manifest, updates.path ?? issue.path, updates.oldPath);
      requireChapterOwnsPath(manifest, updates.path ?? issue.path, updates.chapterId);
      // A range belongs to the file it was read from. Moving the finding to
      // another path used to keep the old coordinates, pinning it to lines the
      // new file may not even have; canonicalIssue drops the undefined key.
      const droppedHunk =
        updates.path !== undefined && updates.hunk === undefined && issue.hunk !== undefined;
      const oldBucket = issueBucket(issue.chapterId);
      Object.assign(issue, updates);
      if (droppedHunk) issue.hunk = undefined;
      requireRealHunk(manifest, issue.path, issue.hunk);
      // Against the chapter the finding ends up in: an explicit --chapter wins,
      // and without one the owner is re-read off the anchor below, which cannot
      // disagree with it.
      requireChapterOwnsHunk(manifest, issue.path, issue.hunk, updates.chapterId);
      // Re-anchoring a finding must re-home it: `add` infers the owning chapter
      // from --path/--hunk, so `set` has to as well. Without this, moving a
      // finding to a path or range another chapter owns leaves it filed under
      // the old one — and when the old chapter still owns some of the path, the
      // next `write` re-maps nothing and the mis-filing is permanent. An
      // explicit --chapter in the same call still wins.
      const reanchored = updates.path !== undefined || updates.hunk !== undefined;
      if (reanchored && updates.chapterId === undefined) {
        // Undefined rather than removed: canonicalIssue drops the key on save.
        issue.chapterId = ownerChapterId(manifest, issue.path, issue.hunk, undefined);
      }
      // A finding that changed chapter takes the next id in the new chapter's
      // sequence, the same way `write` renumbers one a re-partition re-homes.
      // Its old number is retained as that chapter's mark, so nothing reuses it.
      const renumbered =
        issueBucket(issue.chapterId) === oldBucket
          ? undefined
          : nextIssueId(manifest, issues, issue.chapterId);
      if (renumbered !== undefined) issue.id = renumbered;
      saveIssues(manifest, issues, () => {
        // Name the state the move discarded. Silently dropping the range left
        // the finding anchored to a whole file with no sign it had been pinned,
        // and its note still describing the code it came from.
        const where = issue.chapterId ? ` in ${issue.chapterId}` : "";
        const moved = updates.path !== undefined;
        console.log(
          `Updated ${id}${where}.` +
            (renumbered === undefined
              ? ""
              : ` It is now ${renumbered}: an id counts in its chapter's sequence.`) +
            (droppedHunk ? " Its hunk was cleared: a range does not carry to another file." : "") +
            // The note was written about the old anchor and nothing rewrites it.
            // A --hunk earns the same warning as a --path: reaching for it to move
            // a finding between chapters re-anchors it as a side effect, leaving
            // the note describing code the finding no longer points at.
            (moved
              ? " Check the note still describes the new path."
              : updates.hunk === undefined
                ? ""
                : " Check the note still describes the range it now points at.")
        );
      });
      break;
    }
    case "resolve":
    case "reopen": {
      const [id] = rest;
      if (!id) die(`chapter-review: issue ${sub} needs an issue id.`);
      const { issue } = findIssue(manifest, id);
      issue.status = sub === "resolve" ? "resolved" : "open";
      saveIssues(manifest, issues, () =>
        { console.log(`${sub === "resolve" ? "Resolved" : "Reopened"} ${id}.`); }
      );
      break;
    }
    case "verify":
    case "unverify": {
      const [id] = rest;
      if (!id) die(`chapter-review: issue ${sub} needs an issue id.`);
      const { issue } = findIssue(manifest, id);
      issue.confidence = sub === "verify" ? "verified" : "suspected";
      saveIssues(manifest, issues, () =>
        { console.log(`Marked ${id} ${issue.confidence}.`); }
      );
      break;
    }
    case "rm": {
      const [id] = rest;
      if (!id) die("chapter-review: issue rm needs an issue id.");
      findIssue(manifest, id); // errors if missing
      // Pinned before the removal, so dropping the highest id does not free it.
      manifest.issueSeq = storedIssueSeq(manifest, issues);
      saveIssues(manifest, issues.filter((i) => i.id !== id), () =>
        { console.log(`Removed ${id}. Its id is retired, not reused.`); }
      );
      break;
    }
    case "list": {
      if (issues.length === 0) {
        console.log("No issues recorded.");
        break;
      }
      for (const i of issues) {
        const status = i.status === "resolved" ? "resolved" : "open";
        const confidence = i.confidence === "verified" ? "verified" : "suspected";
        // Name the no-chapter cases: a quarantined path legitimately has no
        // owner, a path outside the diff is a stale anchor.
        const where = i.chapterId
          ? ` (${i.chapterId})`
          : pathInManifest(manifest, i.path)
            ? " (unassigned)"
            : " (no anchor: path is not in the diff)";
        // The anchor is path + hunk, so show which of the two this finding got.
        const at = i.hunk
          ? ` @@ -${i.hunk.oldStart},${i.hunk.oldLines} +${i.hunk.newStart},${i.hunk.newLines} @@`
          : "";
        console.log(
          `${i.id}  [${i.severity}/${confidence}/${status}]  ${i.path}${at}${where}\n    ${i.note}`
        );
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      issueUsage(0);
      break;
    default:
      console.error(`chapter-review: unknown issue command "${sub ?? ""}"`);
      issueUsage(1);
  }
}
