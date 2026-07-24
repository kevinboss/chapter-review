// Regression tests for the validator. No framework: each case mutates a clone
// of example-chapters.json and asserts the expected outcome.
//
// CLI: node scripts/test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifest } from "../.claude/skills/chapter-review/validate.mjs";

const skillDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "skills",
  "chapter-review"
);
const example = JSON.parse(
  readFileSync(path.join(skillDir, "example-chapters.json"), "utf8")
);

const cases = [
  {
    name: "example manifest is valid",
    mutate: () => {},
    expectError: null,
  },
  {
    name: "schema: missing mergeBase",
    mutate: (m) => delete m.mergeBase,
    expectError: "schema:",
  },
  {
    name: "schema: unknown file status",
    mutate: (m) => (m.chapters[0].files[0].status = "changed"),
    expectError: "schema:",
  },
  {
    name: "identical hunk claimed twice",
    mutate: (m) =>
      m.chapters[1].files[1].hunks.push({ ...m.chapters[0].files[1].hunks[0] }),
    expectError: "identical hunk",
  },
  {
    name: "overlapping hunks",
    mutate: (m) =>
      (m.chapters[1].files[1].hunks[0] = {
        oldStart: 13,
        oldLines: 2,
        newStart: 13,
        newLines: 5,
      }),
    expectError: "overlapping hunks",
  },
  {
    name: "whole file claimed alongside another entry",
    mutate: (m) =>
      m.chapters[1].files.push({ path: "package-lock.json", status: "modified" }),
    expectError: "whole file",
  },
  {
    name: "conflicting status across entries",
    mutate: (m) => (m.chapters[1].files[1].status = "deleted"),
    expectError: "conflicting status",
  },
  {
    name: "oldPath without renamed status",
    mutate: (m) => (m.chapters[0].files[0].oldPath = "src/old.ts"),
    expectError: "oldPath",
  },
  {
    name: "duplicate chapter id",
    mutate: (m) => (m.chapters[1].id = "ch-1"),
    expectError: "duplicate chapter id",
  },
  {
    name: "issue with unknown severity",
    mutate: (m) => (m.issues[0].severity = "blocker"),
    expectError: "schema:",
  },
  {
    name: "issue missing note",
    mutate: (m) => delete m.issues[0].note,
    expectError: "note",
  },
  {
    name: "issue with unknown confidence",
    mutate: (m) => (m.issues[0].confidence = "maybe"),
    expectError: "confidence",
  },
  {
    name: "issue confidence omitted is valid",
    mutate: (m) => delete m.issues[0].confidence,
    expectError: null,
  },
  {
    name: "duplicate issue id",
    mutate: (m) => m.issues.push({ ...m.issues[0] }),
    expectError: "duplicate issue id",
  },
  {
    name: "issue with unknown field",
    mutate: (m) => (m.issues[0].author = "me"),
    expectError: "unknown property",
  },
  {
    name: "reviewed unit is valid",
    mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "abcd1234" }]),
    expectError: null,
  },
  {
    name: "reviewed unit with a hunk is valid",
    mutate: (m) =>
      (m.reviewed = [
        { path: "src/server.ts", hunk: { oldStart: 30, oldLines: 0, newStart: 30, newLines: 24 }, digest: "0a1b" },
      ]),
    expectError: null,
  },
  {
    name: "reviewed unit with a non-hex digest",
    mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "NOPE" }]),
    expectError: "digest",
  },
  {
    name: "reviewed unit missing digest",
    mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts" }]),
    expectError: "digest",
  },
  {
    name: "reviewed unit with unknown field",
    mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "ab", extra: 1 }]),
    expectError: "unknown property",
  },
  {
    name: "reviewed must be an array",
    mutate: (m) => (m.reviewed = {}),
    expectError: "reviewed",
  },
];

let failed = 0;
for (const c of cases) {
  const manifest = structuredClone(example);
  c.mutate(manifest);
  const result = validateManifest(manifest);

  let ok;
  if (c.expectError === null) {
    ok = result.ok;
  } else {
    ok = !result.ok && result.errors.some((e) => e.includes(c.expectError));
  }

  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    failed++;
    console.log(`      got: ok=${result.ok} errors=${JSON.stringify(result.errors)}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed > 0 ? 1 : 0);
