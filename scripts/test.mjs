// Regression tests for the validator. No framework: each case mutates a clone
// of example-chapters.json and asserts the expected outcome.
//
// CLI: node scripts/test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifest } from "./validate.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = JSON.parse(
  readFileSync(path.join(root, "example-chapters.json"), "utf8")
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
