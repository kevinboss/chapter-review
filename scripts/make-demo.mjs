// Builds demo/ — a throwaway C# git repo with a reviewable branch. Fixture
// trees live in demo-fixtures/{before,after}; "before" becomes main, "after"
// becomes feat/queue-notifications.
//
// By default no chapters.json is written: generating it is the chapter-review
// skill's job (run the skill against demo/). Pass --manifest to also emit a
// scripted reference manifest — the parse-classify-validate flow below is a
// dry run of what the skill has to do.
//
// CLI: node scripts/make-demo.mjs [--manifest]

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifest } from "./validate.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(root, "demo");
const fixtures = path.join(root, "demo-fixtures");

function git(...args) {
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
  filter: (src) => !/[\\/](bin|obj)([\\/]|$)/.test(src),
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

if (!process.argv.includes("--manifest")) {
  console.log(`demo/ rebuilt at ${mergeBase.slice(0, 8)}..feat/queue-notifications`);
  console.log(
    "No chapters.json written — run the chapter-review skill against demo/ to generate it,"
  );
  console.log("or rerun with --manifest for the scripted reference manifest.");
  process.exit(0);
}

// --- parse the real diff ----------------------------------------------------

function parseDiff(text) {
  return text
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => {
      const lines = section.split("\n");
      const paths = lines[0].match(/^a\/(\S+) b\/(\S+)$/);
      let filePath = paths[2];
      let oldPath;
      let status = "modified";

      const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
      const header = lines.slice(0, firstHunk === -1 ? lines.length : firstHunk);
      if (header.some((l) => l.startsWith("new file"))) {
        status = "added";
      } else if (header.some((l) => l.startsWith("deleted file"))) {
        status = "deleted";
        filePath = paths[1];
      } else {
        const from = header.find((l) => l.startsWith("rename from "));
        const to = header.find((l) => l.startsWith("rename to "));
        if (from && to) {
          status = "renamed";
          oldPath = from.slice("rename from ".length);
          filePath = to.slice("rename to ".length);
        }
      }

      const hunks = [];
      if (firstHunk !== -1) {
        let current = null;
        for (const line of lines.slice(firstHunk)) {
          const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (h) {
            current = {
              oldStart: +h[1],
              oldLines: h[2] === undefined ? 1 : +h[2],
              newStart: +h[3],
              newLines: h[4] === undefined ? 1 : +h[4],
              changed: [],
            };
            hunks.push(current);
          } else if (current && /^[+-]/.test(line)) {
            current.changed.push(line);
          }
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

function isWhitespaceOnly(changed) {
  const strip = (prefix) =>
    changed
      .filter((l) => l[0] === prefix)
      .map((l) => l.slice(1).replace(/\s+/g, ""))
      .join("\n");
  const removed = strip("-");
  return removed.length > 0 && removed === strip("+");
}

function classifyHunk(changed) {
  const text = changed.join("\n");
  if (isWhitespaceOnly(changed)) return "unassigned:autoformat";
  if (/Guard|Ensure/.test(text)) return "ch-3";
  if (/INotifier|QueueNotifier|Demo\.Notifications|\.Notify\(/.test(text)) return "ch-2";
  if (/EmailNotifier/.test(text)) return "ch-1";
  throw new Error(`unclassifiable hunk:\n${text}`);
}

function ownersFor(file) {
  if (file.path === "packages.lock.json") return () => "unassigned:generated";
  if (file.path === "Demo.csproj") return () => "ch-5";
  if (file.path.startsWith("tests/")) return () => "ch-4";
  if (file.status === "deleted") return () => "ch-1";
  if (file.status === "renamed") return () => "ch-3";
  return (hunk) => classifyHunk(hunk.changed);
}

// owner -> path -> { file, hunks }
const assignments = new Map();
let parsedHunks = 0;
for (const file of files) {
  const owner = ownersFor(file);
  for (const hunk of file.hunks) {
    parsedHunks++;
    const key = owner(hunk);
    let perPath = assignments.get(key);
    if (!perPath) assignments.set(key, (perPath = new Map()));
    let entry = perPath.get(file.path);
    if (!entry) perPath.set(file.path, (entry = { file, hunks: [] }));
    entry.hunks.push(hunk);
  }
}

// --- emit the manifest -------------------------------------------------------

// A path owned by a single owner collapses to a whole-file claim.
const ownersPerPath = new Map();
for (const [owner, perPath] of assignments) {
  for (const p of perPath.keys()) {
    ownersPerPath.set(p, (ownersPerPath.get(p) ?? 0) + (owner ? 1 : 0));
  }
}

function emitEntry(owner, { file, hunks }) {
  const entry = { path: file.path };
  if (file.oldPath) entry.oldPath = file.oldPath;
  entry.status = file.status;
  if (ownersPerPath.get(file.path) > 1) {
    entry.hunks = [...hunks]
      .sort((a, b) => a.newStart - b.newStart)
      .map(({ oldStart, oldLines, newStart, newLines }) => ({
        oldStart,
        oldLines,
        newStart,
        newLines,
      }));
  }
  if (owner.startsWith("unassigned:")) {
    entry.reason = owner.slice("unassigned:".length);
  }
  return entry;
}

const manifest = {
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
