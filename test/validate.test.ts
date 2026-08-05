// Unit tests for the manifest validator. Each case mutates a clone of the
// shipped example and asserts the outcome. Migrated from the old scripts/test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readJsonAs, SKILL_DIR } from "./helpers.ts";
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

const example = readJsonAs<LooseManifest>(path.join(SKILL_DIR, "example-chapters.json"));

interface Case {
  name: string;
  mutate: (m: LooseManifest) => void;
  /** Substring the errors must contain, or null when the mutation stays valid. */
  expectError: string | null;
}

const cases: Case[] = [
  { name: "example manifest is valid", mutate: () => { /* unmutated */ }, expectError: null },
  { name: "missing mergeBase", mutate: (m) => (m.mergeBase = undefined), expectError: "schema:" },
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
  { name: "issue missing note", mutate: (m) => (m.issues[0].note = undefined), expectError: "note" },
  { name: "issue with unknown confidence", mutate: (m) => (m.issues[0].confidence = "maybe"), expectError: "confidence" },
  { name: "issue confidence omitted is valid", mutate: (m) => (m.issues[0].confidence = undefined), expectError: null },
  { name: "duplicate issue id", mutate: (m) => m.issues.push({ ...m.issues[0] }), expectError: "duplicate issue id" },
  { name: "issue with unknown field", mutate: (m) => (m.issues[0].author = "me"), expectError: "unknown property" },
  // Ids are numbered inside their chapter, so the two halves have to agree: an
  // iss-1.2 under chapter three is exactly what the numbering rules out.
  { name: "issue id naming another chapter", mutate: (m) => (m.issues[0].id = "iss-1.2"), expectError: "that chapter's sequence" },
  { name: "issue id with no chapter part", mutate: (m) => (m.issues[0].id = "iss-1"), expectError: "iss-<chapter>.<number>" },
  {
    name: "chapter-less issue numbered in the chapter-0 sequence is valid",
    mutate: (m) => {
      m.issues[0].chapterId = undefined;
      m.issues[0].id = "iss-0.1";
    },
    expectError: null,
  },
  { name: "chapter-less issue numbered in a chapter", mutate: (m) => (m.issues[0].chapterId = undefined), expectError: "no chapter" },
  // ch-0 is refused because 0 is the sequence for findings no chapter owns.
  { name: "chapter numbered from 0", mutate: (m) => (m.chapters[0].id = "ch-0"), expectError: "numbered from 1" },
  { name: "issueSeq as a single number", mutate: (m) => (m.issueSeq = 4), expectError: "keyed by chapter number" },
  { name: "issueSeq keyed by chapter number is valid", mutate: (m) => (m.issueSeq = { "0": 1, "2": 3 }), expectError: null },
  { name: "issueSeq keyed by chapter id", mutate: (m) => (m.issueSeq = { "ch-2": 3 }), expectError: "must be a chapter number" },
  { name: "issueSeq with a zero mark", mutate: (m) => (m.issueSeq = { "2": 0 }), expectError: "positive integer" },
  // Checkmarks live in progress.json alone; the manifest has no `reviewed` key.
  { name: "reviewed in the manifest is rejected", mutate: (m) => (m.reviewed = [{ path: "src/auth/oidc.ts", digest: "abcd1234" }]), expectError: "unknown property" },
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
