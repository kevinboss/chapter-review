// Builds demo/ — a throwaway C# git repo with a reviewable branch. Fixture
// trees live in demo-fixtures/{before,after}; "before" becomes main, "after"
// becomes feat/queue-notifications.
//
// By default no chapters.json is written: generating it is the chapter-review
// skill's job (run the skill against demo/). Pass --manifest to also emit a
// scripted reference manifest — the parse-classify-validate flow below is a
// dry run of what the skill has to do.
//
// CLI: node scripts/make-demo.ts [--manifest]

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifest } from "../.claude/skills/chapter-review/validate.ts";
import type { FileEntry, FileStatus, Manifest } from "../.claude/skills/chapter-review/types.ts";

/** One hunk of the parsed diff, with the +/- lines kept for classification. */
interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changed: string[];
}

/** One file of the parsed diff. */
interface ParsedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: ParsedHunk[];
}

/** The hunks of one path claimed by one owner. */
interface Entry {
  file: ParsedFile;
  hunks: ParsedHunk[];
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, "demo");
const fixtures = path.join(root, "demo-fixtures");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: demo, encoding: "utf8" }).trim();
}

// --- build the repo ---------------------------------------------------------

rmSync(demo, { recursive: true, force: true });
mkdirSync(demo);
git("init", "-b", "main");
git("config", "user.name", "Demo");
git("config", "user.email", "demo@example.com");
git("config", "core.autocrlf", "false");
git("config", "commit.gpgsign", "false");

// The C# language server may drop bin/obj next to the fixture csproj; never
// let build artifacts into the demo history.
const copyOpts = {
  recursive: true,
  filter: (src: string): boolean => !/[\\/](bin|obj)([\\/]|$)/.test(src),
};

cpSync(path.join(fixtures, "before"), demo, copyOpts);
git("add", "-A");
git("commit", "-m", "Initial order service with email notifications");

for (const name of readdirSync(demo)) {
  if (name !== ".git") rmSync(path.join(demo, name), { recursive: true });
}
cpSync(path.join(fixtures, "after"), demo, copyOpts);
git("checkout", "-b", "feat/queue-notifications");
git("add", "-A");
git("commit", "-m", "Queue-based notifications; rename Guard to Ensure");

const mergeBase = git("rev-parse", "main");
const headSha = git("rev-parse", "HEAD");

// Install the skill into the demo repo so it can be tried out there directly,
// the way the extension installs it into a real workspace. Copied after both
// commits (so it's untracked, never part of the reviewed diff) and hidden via
// .git/info/exclude so `git status` stays clean and it can't leak into a
// partition. Only chapter-review — the demo/release skills are repo chores.
const skillSrc = path.join(root, ".claude", "skills", "chapter-review");
const skillDest = path.join(demo, ".claude", "skills", "chapter-review");
cpSync(skillSrc, skillDest, { recursive: true });
appendFileSync(path.join(git("rev-parse", "--absolute-git-dir"), "info", "exclude"), ".claude/\n");

if (!process.argv.includes("--manifest")) {
  console.log(`demo/ rebuilt at ${mergeBase.slice(0, 8)}..feat/queue-notifications`);
  console.log("skill installed at demo/.claude/skills/chapter-review (hidden via .git/info/exclude)");
  console.log(
    "No chapters.json written — run the chapter-review skill against demo/ to generate it,"
  );
  console.log("or rerun with --manifest for the scripted reference manifest.");
  process.exit(0);
}

// --- parse the real diff ----------------------------------------------------

// A hunk header's count is omitted when it is 1 (`@@ -3 +3,2 @@`).
const hunkCount = (v: string | undefined): number => (v === undefined ? 1 : Number(v));

/** Status and path for one diff section, from its header lines. */
function classifyFile(
  header: string[],
  aPath: string,
  bPath: string
): { path: string; oldPath: string | undefined; status: FileStatus } {
  if (header.some((l) => l.startsWith("new file"))) {
    return { path: bPath, oldPath: undefined, status: "added" };
  }
  if (header.some((l) => l.startsWith("deleted file"))) {
    return { path: aPath, oldPath: undefined, status: "deleted" };
  }
  const from = header.find((l) => l.startsWith("rename from "));
  const to = header.find((l) => l.startsWith("rename to "));
  if (from !== undefined && to !== undefined) {
    return {
      path: to.slice("rename to ".length),
      oldPath: from.slice("rename from ".length),
      status: "renamed",
    };
  }
  return { path: bPath, oldPath: undefined, status: "modified" };
}

function parseDiff(text: string): ParsedFile[] {
  return text
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => {
      const lines = section.split("\n");
      const paths = /^a\/(\S+) b\/(\S+)$/.exec(lines[0]);
      if (!paths) throw new Error(`unparsable diff header: ${lines[0]}`);
      const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
      const header = lines.slice(0, firstHunk === -1 ? lines.length : firstHunk);
      const { path: filePath, oldPath, status } = classifyFile(header, paths[1], paths[2]);

      // Each +/- line belongs to the hunk header above it, so append to the last
      // one pushed rather than tracking a "current" cursor.
      const hunks: ParsedHunk[] = [];
      for (const line of firstHunk === -1 ? [] : lines.slice(firstHunk)) {
        const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (h) {
          hunks.push({
            oldStart: Number(h[1]),
            oldLines: hunkCount(h.at(2)),
            newStart: Number(h[3]),
            newLines: hunkCount(h.at(4)),
            changed: [],
          });
        } else if (hunks.length > 0 && /^[+-]/.test(line)) {
          hunks[hunks.length - 1].changed.push(line);
        }
      }
      return { path: filePath, oldPath, status, hunks };
    });
}

const files = parseDiff(git("diff", "-M", "--no-color", "--unified=3", "main..HEAD"));

// --- classify hunks into chapters -------------------------------------------

const CHAPTERS = [
  {
    id: "ch-1",
    title: "Remove the legacy email notifier",
    description: "Synchronous SMTP alerting goes away; call sites move to the new notifier in ch-2.",
  },
  { id: "ch-2", title: "Introduce queue-based notifications" },
  {
    id: "ch-3",
    title: "Rename Guard to Ensure",
    description: "Mechanical rename, one call site.",
  },
  { id: "ch-4", title: "Update tests for notifier injection" },
  { id: "ch-5", title: "Bump xunit to 2.7.0" },
];

function isWhitespaceOnly(changed: string[]): boolean {
  const strip = (prefix: string): string =>
    changed
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(1).replace(/\s+/g, ""))
      .join("\n");
  const removed = strip("-");
  return removed.length > 0 && removed === strip("+");
}

function classifyHunk(changed: string[]): string {
  const text = changed.join("\n");
  if (isWhitespaceOnly(changed)) return "unassigned:autoformat";
  if (/Guard|Ensure/.test(text)) return "ch-3";
  if (/INotifier|QueueNotifier|Demo\.Notifications|\.Notify\(/.test(text)) return "ch-2";
  if (text.includes('EmailNotifier')) return "ch-1";
  throw new Error(`unclassifiable hunk:\n${text}`);
}

function ownersFor(file: ParsedFile): (hunk: ParsedHunk) => string {
  if (file.path === "packages.lock.json") return () => "unassigned:generated";
  if (file.path === "Demo.csproj") return () => "ch-5";
  if (file.path.startsWith("tests/")) return () => "ch-4";
  if (file.status === "deleted") return () => "ch-1";
  if (file.status === "renamed") return () => "ch-3";
  return (hunk) => classifyHunk(hunk.changed);
}

// owner -> path -> { file, hunks }
const assignments = new Map<string, Map<string, Entry>>();
const parsedHunks = files.reduce((total, file) => {
  const owner = ownersFor(file);
  for (const hunk of file.hunks) {
    const key = owner(hunk);
    const perPath = assignments.get(key) ?? new Map<string, Entry>();
    assignments.set(key, perPath);
    const entry = perPath.get(file.path) ?? { file, hunks: [] };
    perPath.set(file.path, entry);
    entry.hunks.push(hunk);
  }
  return total + file.hunks.length;
}, 0);

// --- emit the manifest -------------------------------------------------------

// A path owned by a single owner collapses to a whole-file claim.
const ownersPerPath = new Map<string, number>();
for (const [owner, perPath] of assignments) {
  for (const p of perPath.keys()) {
    ownersPerPath.set(p, (ownersPerPath.get(p) ?? 0) + (owner ? 1 : 0));
  }
}

function emitEntry(owner: string, { file, hunks }: Entry): FileEntry {
  const split = (ownersPerPath.get(file.path) ?? 0) > 1;
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    ...(split
      ? {
          hunks: [...hunks]
            .sort((a, b) => a.newStart - b.newStart)
            .map(({ oldStart, oldLines, newStart, newLines }) => ({
              oldStart,
              oldLines,
              newStart,
              newLines,
            })),
        }
      : {}),
    ...(owner.startsWith("unassigned:")
      ? { reason: owner.slice("unassigned:".length) }
      : {}),
  };
}

const manifest: Manifest = {
  version: 1,
  base: "main",
  head: "feat/queue-notifications",
  mergeBase,
  headSha,
  generatedAt: new Date().toISOString(),
  summary:
    "Replace synchronous email alerts with a queue-backed notifier; rename the Guard helper to Ensure.",
  chapters: CHAPTERS.map((meta) => {
    const perPath = assignments.get(meta.id);
    if (!perPath) throw new Error(`chapter ${meta.id} ended up empty`);
    return {
      ...meta,
      files: [...perPath.values()]
        .sort((a, b) => a.file.path.localeCompare(b.file.path))
        .map((e) => emitEntry(meta.id, e)),
    };
  }),
  unassigned: [...assignments]
    .filter(([owner]) => owner.startsWith("unassigned:"))
    .flatMap(([owner, perPath]) =>
      [...perPath.values()]
        .sort((a, b) => a.file.path.localeCompare(b.file.path))
        .map((e) => emitEntry(owner, e))
    ),
};

// --- validate and write ------------------------------------------------------

const assigned = [...assignments.values()]
  .flatMap((perPath) => [...perPath.values()])
  .reduce((n, e) => n + e.hunks.length, 0);
if (assigned !== parsedHunks) {
  throw new Error(`partition incomplete: ${assigned} of ${parsedHunks} hunks assigned`);
}

const result = validateManifest(manifest);
if (!result.ok) {
  console.error("generated manifest is invalid:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const manifestDir = path.join(git("rev-parse", "--absolute-git-dir"), "chapter-review");
mkdirSync(manifestDir, { recursive: true });
writeFileSync(path.join(manifestDir, "chapters.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`demo/ rebuilt at ${mergeBase.slice(0, 8)}..feat/queue-notifications`);
console.log(
  `chapters.json: ${result.stats.chapters} chapters, ${result.stats.files} files, ${result.stats.hunks} hunk claims (${parsedHunks} diff hunks)`
);
for (const ch of manifest.chapters) {
  console.log(`  ${ch.id}  ${ch.title} (${ch.files.length} files)`);
}
console.log('Run the "Run Extension (C# demo)" launch config to review it.');
