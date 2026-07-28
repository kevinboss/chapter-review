import { die } from "./util.ts";
import { issueFieldsFromFlags, parseFlags } from "./flags.ts";
import {
  hunksOverlap,
  installManifest,
  nextIssueId,
  ownerChapterId,
  readManifestOrDie,
  withIssues,
} from "./manifest.ts";
import type { Issue, Manifest, ManifestStats } from "./types.ts";

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

function findIssue(manifest: Manifest, id: string): { issues: Issue[]; issue: Issue } {
  const issues = Array.isArray(manifest.issues) ? manifest.issues : [];
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

/**
 * Dispatch an `issue` subcommand (add, set, resolve, reopen, verify, unverify,
 * rm, list) against the current manifest.
 */
export function cmdIssue(sub: string | undefined, rest: string[]): void {
  const manifest = readManifestOrDie();
  const issues = Array.isArray(manifest.issues) ? manifest.issues : [];

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
      const id = nextIssueId(issues);
      // Infer the owning chapter from the path when not given. A --hunk picks
      // the chapter that owns that range; on an ambiguous split (path in >1
      // chapter, no hunk to match) we pick the first and say so.
      if (fields.chapterId === undefined) {
        const owners = manifest.chapters.filter((ch) =>
          ch.files.some((f) => f.path === fields.path)
        );
        const inferred = ownerChapterId(manifest, fieldPath, fields.hunk, undefined);
        if (inferred) fields.chapterId = inferred;
        // Warn whenever the owner had to be guessed: no --hunk on a split path,
        // or a --hunk that overlaps none of the owning ranges (a typo'd range
        // would otherwise land the finding in the wrong chapter silently).
        if (owners.length > 1) {
          const { hunk } = fields;
          const hunkMatched =
            hunk !== undefined &&
            owners.some((ch) =>
              ch.files.some(
                (f) =>
                  f.path === fieldPath &&
                  f.hunks?.some((h) => hunksOverlap(h, hunk))
              )
            );
          if (!hunkMatched) {
            console.error(
              `chapter-review: ${fields.path} spans ${owners.map((o) => o.id).join(", ")}; ` +
                `recorded in ${inferred}. ` +
                (fields.hunk ? "The --hunk matched no owning range; " : "") +
                `pass --chapter to choose, or --hunk to match by range.`
            );
          }
        }
      }
      const issue = { id, ...fields } as Issue;
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
      requireRealChapter(manifest, updates.chapterId);
      Object.assign(issue, updates);
      // Re-anchoring a finding must re-home it: `add` infers the owning chapter
      // from --path/--hunk, so `set` has to as well. Without this, moving a
      // finding to a path or range another chapter owns leaves it filed under
      // the old one — and when the old chapter still owns some of the path, the
      // next `write` re-maps nothing and the mis-filing is permanent. An
      // explicit --chapter in the same call still wins.
      const reanchored = updates.path !== undefined || updates.hunk !== undefined;
      if (reanchored && updates.chapterId === undefined) {
        const owner = ownerChapterId(manifest, issue.path, issue.hunk, undefined);
        if (owner) issue.chapterId = owner;
        else delete issue.chapterId;
      }
      saveIssues(manifest, issues, () => { console.log(`Updated ${id}.`); });
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
      saveIssues(manifest, issues.filter((i) => i.id !== id), () =>
        { console.log(`Removed ${id}.`); }
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
        console.log(
          `${i.id}  [${i.severity}/${confidence}/${status}]  ${i.path}${i.chapterId ? ` (${i.chapterId})` : ""}\n    ${i.note}`
        );
      }
      break;
    }
    default:
      die(`chapter-review: unknown issue command "${sub ?? ""}" (add|set|resolve|reopen|verify|unverify|rm|list)`);
  }
}
