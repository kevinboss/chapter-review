// Unit tests for the manifest validator. Each case mutates a clone of the
// shipped example and asserts the outcome. Migrated from the old scripts/test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SKILL_DIR } from "./helpers.ts";
import { validateManifest } from "../.claude/skills/chapter-review/validate.ts";

// The whole point of this suite is to feed the validator shapes it must reject,
// so the mutators need a looser view than `Manifest`. These mirror it with the
// fields each case touches, plus an `unknown` index signature for the cases that
// bolt on properties the schema forbids. `unknown` rather than `any` keeps the
// looseness honest: adding junk keys is allowed, reading them back is not.
interface LooseHunk {
  [key: string]: unknown;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}
interface LooseFile {
  [key: string]: unknown;
  path: string;
  status: string;
  oldPath?: string;
  hunks?: LooseHunk[];
}
interface LooseChapter {
  [key: string]: unknown;
  id: string;
  files: LooseFile[];
}
interface LooseIssue {
  [key: string]: unknown;
  id: string;
  severity?: string;
  note?: string;
  confidence?: string;
}
interface LooseManifest {
  [key: string]: unknown;
  mergeBase?: string;
  chapters: LooseChapter[];
  unassigned?: LooseFile[];
  issues: LooseIssue[];
  reviewed?: unknown;
}

/**
 * The hunks of an entry the fixture is expected to have enumerated. Throws rather
 * than asserting non-null, so a reshaped example-chapters.json fails as a clear
 * fixture error instead of a confusing assertion further down.
 */
function hunksOf(file: LooseFile): LooseHunk[] {
  if (!file.hunks) {
    throw new Error(`fixture expected enumerated hunks on ${file.path}`);
  }
  return file.hunks;
}

const example = JSON.parse(
  readFileSync(path.join(SKILL_DIR, "example-chapters.json"), "utf8")
) as LooseManifest;

interface Case {
  name: string;
  mutate: (m: LooseManifest) => void;
  /** Substring the errors must contain, or null when the mutation stays valid. */
  expectError: string | null;
}

const cases: Case[] = [
  { name: "example manifest is valid", mutate: () => { /* unmutated */ }, expectError: null },
  { name: "missing mergeBase", mutate: (m) => delete m.mergeBase, expectError: "schema:" },
  { name: "unknown file status", mutate: (m) => (m.chapters[0].files[0].status = "changed"), expectError: "schema:" },
  {
    name: "identical hunk claimed twice",
    mutate: (m) => hunksOf(m.chapters[1].files[1]).push({ ...hunksOf(m.chapters[0].files[1])[0] }),
    expectError: "identical hunk",
  },
  {
    name: "overlapping hunks",
    mutate: (m) => (hunksOf(m.chapters[1].files[1])[0] = { oldStart: 13, oldLines: 2, newStart: 13, newLines: 5 }),
    expectError: "overlapping hunks",
  },
  {
    name: "whole file claimed alongside another entry",
    mutate: (m) => m.chapters[1].files.push({ path: "package-lock.json", status: "modified" }),
    expectError: "whole file",
  },
  { name: "conflicting status across entries", mutate: (m) => (m.chapters[1].files[1].status = "deleted"), expectError: "conflicting status" },
  { name: "oldPath without renamed status", mutate: (m) => (m.chapters[0].files[0].oldPath = "src/old.ts"), expectError: "oldPath" },
  { name: "duplicate chapter id", mutate: (m) => (m.chapters[1].id = "ch-1"), expectError: "duplicate chapter id" },
  { name: "issue with unknown severity", mutate: (m) => (m.issues[0].severity = "blocker"), expectError: "schema:" },
  { name: "issue missing note", mutate: (m) => delete m.issues[0].note, expectError: "note" },
  { name: "issue with unknown confidence", mutate: (m) => (m.issues[0].confidence = "maybe"), expectError: "confidence" },
  { name: "issue confidence omitted is valid", mutate: (m) => delete m.issues[0].confidence, expectError: null },
  { name: "duplicate issue id", mutate: (m) => m.issues.push({ ...m.issues[0] }), expectError: "duplicate issue id" },
  { name: "issue with unknown field", mutate: (m) => (m.issues[0].author = "me"), expectError: "unknown property" },
  { name: "reviewed unit is valid", mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "abcd1234" }]), expectError: null },
  {
    name: "reviewed unit with a hunk is valid",
    mutate: (m) => (m.reviewed = [{ path: "src/server.ts", hunk: { oldStart: 30, oldLines: 0, newStart: 30, newLines: 24 }, digest: "0a1b" }]),
    expectError: null,
  },
  { name: "reviewed unit with a non-hex digest", mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "NOPE" }]), expectError: "digest" },
  { name: "reviewed unit missing digest", mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts" }]), expectError: "digest" },
  { name: "reviewed unit with unknown field", mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "ab", extra: 1 }]), expectError: "unknown property" },
  { name: "reviewed must be an array", mutate: (m) => (m.reviewed = {}), expectError: "reviewed" },
];

for (const c of cases) {
  const expected = c.expectError;
  test(`validate: ${c.name}`, () => {
    const manifest = structuredClone(example);
    c.mutate(manifest);
    const result = validateManifest(manifest);
    if (expected === null) {
      assert.ok(result.ok, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
    } else {
      assert.ok(!result.ok, "expected invalid, but validation passed");
      assert.ok(
        result.errors.some((e) => e.includes(expected)),
        `expected an error containing "${expected}", got: ${JSON.stringify(result.errors)}`
      );
    }
  });
}
