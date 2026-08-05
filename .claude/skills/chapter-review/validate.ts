// Validates a chapters.json manifest: structure first, then the partition
// rules structure can't express. Zero dependencies (Node builtins only) so the
// skill directory is self-contained and portable into any repo; copy it in,
// no npm install. This validator is authoritative; chapters.schema.json is the
// same contract expressed as JSON Schema for editors and documentation. Keep
// the two in sync when the contract changes.
//
// Everything in the structural pass takes `unknown` and narrows, because the
// input is parsed JSON from outside: an `any` here would silently disable the
// very checks this file exists to make.
//
// CLI: node validate.ts <manifest.json>

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tryReadJson } from "./util.ts";
import type { FileEntry, FileStatus, Hunk, Manifest, ValidationResult } from "./types.ts";

type Push = (msg: string) => void;

const STATUS = new Set(["added", "modified", "deleted", "renamed"]);
const SEVERITY = new Set(["critical", "high", "low"]);
const ISSUE_STATUS = new Set(["open", "resolved"]);
const CONFIDENCE = new Set(["suspected", "verified"]);
const SHA = /^[0-9a-f]{7,40}$/;
// Numbering starts at 1, so 0 is free to mean "no chapter" in an issue id.
const CHAPTER_ID = /^ch-[1-9][0-9]*$/;
// `iss-<chapter>.<n>`: findings are numbered within their chapter, so the id
// says where the finding is. Chapter 0 is the sequence for findings with none.
const ISSUE_ID = /^iss-([0-9]+)\.([1-9][0-9]*)$/;
const ISSUE_SEQ_KEY = /^(0|[1-9][0-9]*)$/;
const PATH = /^[^/]/; // repo-relative, no leading slash
// A leading slash is not the only way out of the repo. `..` segments escape too,
// and the manifest is the extension's input, so the check that claims to enforce
// repo-relativity has to mean it.
const PATH_ESCAPE = /(^|\/)\.\.(\/|$)/;
// ISO-8601 date-time with a required zone (Z or offset); seconds optional, so a
// minute-precision stamp like 2026-07-06T12:22Z is accepted, not just RFC-3339.
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// A type predicate, not a boolean: this is what lets every check below take
// `unknown` and still read properties afterwards.
const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

// Array.isArray, but leaving elements at `unknown` rather than `any`.
const isArray = (x: unknown): x is unknown[] => Array.isArray(x);

/** True when `x` is a string the set contains — the set lookup alone rejects `unknown`. */
const isOneOf = (x: unknown, set: Set<string>): boolean =>
  typeof x === "string" && set.has(x);

function noExtraKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  label: string,
  push: Push
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(`${label} has unknown property "${key}"`);
  }
}

function checkHunk(h: unknown, label: string, push: Push): void {
  if (!isObject(h)) {
    push(`${label} must be an object`);
    return;
  }
  for (const k of ["oldStart", "oldLines", "newStart", "newLines"] as const) {
    const v = h[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      push(`${label}.${k} must be an integer >= 0`);
    }
  }
  noExtraKeys(h, ["oldStart", "oldLines", "newStart", "newLines"], label, push);
}

function checkHunks(hunks: unknown, label: string, push: Push): void {
  if (hunks === undefined) return;
  if (!isArray(hunks) || hunks.length < 1) {
    push(`${label}.hunks, when present, must be a non-empty array`);
    return;
  }
  hunks.forEach((h, i) => {
    checkHunk(h, `${label}.hunks[${i}]`, push);
  });
}

function checkPath(value: unknown, label: string, push: Push): void {
  if (typeof value !== "string" || value.length < 1 || !PATH.test(value)) {
    push(`${label} must be a repo-relative path with no leading slash`);
    return;
  }
  if (PATH_ESCAPE.test(value)) {
    push(`${label} must stay inside the repo (no ".." segments)`);
  }
}

function checkFile(
  file: unknown,
  label: string,
  push: Push,
  { requireReason }: { requireReason: boolean }
): void {
  if (!isObject(file)) {
    push(`${label} must be an object`);
    return;
  }
  checkPath(file.path, `${label}.path`, push);
  if (file.oldPath !== undefined) checkPath(file.oldPath, `${label}.oldPath`, push);
  if (!isOneOf(file.status, STATUS)) {
    push(`${label}.status must be one of ${[...STATUS].join(", ")}`);
  }
  checkHunks(file.hunks, label, push);

  if (requireReason) {
    if (typeof file.reason !== "string" || file.reason.length < 1) {
      push(`${label}.reason must be a non-empty string`);
    }
    noExtraKeys(file, ["path", "oldPath", "status", "hunks", "reason"], label, push);
  } else {
    if (file.note !== undefined && typeof file.note !== "string") {
      push(`${label}.note must be a string`);
    }
    noExtraKeys(file, ["path", "oldPath", "status", "hunks", "note"], label, push);
  }
}

function checkChapter(ch: unknown, label: string, push: Push): void {
  if (!isObject(ch)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof ch.id !== "string" || !CHAPTER_ID.test(ch.id)) {
    push(`${label}.id must match ch-<number>, numbered from 1`);
  }
  if (typeof ch.title !== "string" || ch.title.length < 1 || ch.title.length > 60) {
    push(`${label}.title must be a string of 1-60 chars`);
  }
  if (ch.description !== undefined && typeof ch.description !== "string") {
    push(`${label}.description must be a string`);
  }
  const { files } = ch;
  if (!isArray(files) || files.length < 1) {
    push(`${label}.files must be a non-empty array`);
  } else {
    files.forEach((f, i) => {
      checkFile(f, `${label}.files[${i}]`, push, { requireReason: false });
    });
  }
  noExtraKeys(ch, ["id", "title", "description", "files"], label, push);
}

function checkIssue(issue: unknown, label: string, push: Push): void {
  if (!isObject(issue)) {
    push(`${label} must be an object`);
    return;
  }
  const id = typeof issue.id === "string" ? ISSUE_ID.exec(issue.id) : null;
  if (!id) {
    push(`${label}.id must match iss-<chapter>.<number>`);
  }
  checkPath(issue.path, `${label}.path`, push);
  if (issue.oldPath !== undefined) checkPath(issue.oldPath, `${label}.oldPath`, push);
  if (issue.hunk !== undefined) checkHunk(issue.hunk, `${label}.hunk`, push);
  if (
    issue.chapterId !== undefined &&
    (typeof issue.chapterId !== "string" || !CHAPTER_ID.test(issue.chapterId))
  ) {
    push(`${label}.chapterId must match ch-<number>, numbered from 1`);
  }
  // The chapter part of the id is what a reviewer reads off the extension's tree
  // and quotes back, so it has to name the chapter the finding is actually filed
  // under. Findings are renumbered when they change chapter for this reason.
  if (id) {
    const owner = typeof issue.chapterId === "string" ? issue.chapterId : undefined;
    const ownerNumber = /^ch-([0-9]+)$/.exec(owner ?? "");
    const expected = ownerNumber ? ownerNumber[1] : "0";
    if (id[1] !== expected) {
      push(
        `${label}.id is ${id[0]} but the finding sits in ${owner ?? "no chapter"}; ` +
          `it must be numbered in that chapter's sequence (iss-${expected}.<number>)`
      );
    }
  }
  if (!isOneOf(issue.severity, SEVERITY)) {
    push(`${label}.severity must be one of ${[...SEVERITY].join(", ")}`);
  }
  if (typeof issue.note !== "string" || issue.note.length < 1) {
    push(`${label}.note must be a non-empty string`);
  }
  if (issue.confidence !== undefined && !isOneOf(issue.confidence, CONFIDENCE)) {
    push(`${label}.confidence must be one of ${[...CONFIDENCE].join(", ")}`);
  }
  if (issue.status !== undefined && !isOneOf(issue.status, ISSUE_STATUS)) {
    push(`${label}.status must be one of ${[...ISSUE_STATUS].join(", ")}`);
  }
  noExtraKeys(
    issue,
    ["id", "path", "oldPath", "hunk", "chapterId", "severity", "note", "confidence", "status", "createdAt"],
    label,
    push
  );
}

function structuralErrors(m: unknown): string[] {
  const errors: string[] = [];
  const push: Push = (msg) => errors.push(`schema: ${msg}`);

  if (!isObject(m)) {
    push("manifest must be an object");
    return errors;
  }
  if (m.version !== 1) push(`version must be 1 (got ${JSON.stringify(m.version)})`);
  for (const k of ["base", "head"] as const) {
    const v = m[k];
    if (typeof v !== "string" || v.length < 1) {
      push(`${k} must be a non-empty string`);
    }
  }
  if (typeof m.mergeBase !== "string" || !SHA.test(m.mergeBase)) {
    push("mergeBase must be a hex sha (7-40 chars)");
  }
  if (m.headSha !== undefined && (typeof m.headSha !== "string" || !SHA.test(m.headSha))) {
    push("headSha, when present, must be a hex sha (7-40 chars)");
  }
  if (typeof m.generatedAt !== "string" || !ISO_8601.test(m.generatedAt)) {
    push("generatedAt must be an ISO-8601 date-time");
  }
  if (m.summary !== undefined && typeof m.summary !== "string") {
    push("summary must be a string");
  }
  if (m.issueSeq !== undefined) {
    if (!isObject(m.issueSeq)) {
      push(
        "issueSeq, when present, must be an object keyed by chapter number " +
          '("0" for findings with no chapter)'
      );
    } else {
      for (const [bucket, n] of Object.entries(m.issueSeq)) {
        if (!ISSUE_SEQ_KEY.test(bucket)) {
          push(`issueSeq key "${bucket}" must be a chapter number ("0" = no chapter)`);
        }
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          push(`issueSeq["${bucket}"] must be a positive integer`);
        }
      }
    }
  }
  const { chapters, unassigned, issues } = m;
  if (!isArray(chapters)) push("chapters must be an array");
  if (!isArray(unassigned)) push("unassigned must be an array");
  if (issues !== undefined && !isArray(issues)) push("issues, when present, must be an array");
  noExtraKeys(
    m,
    ["version", "base", "head", "mergeBase", "headSha", "generatedAt", "summary", "chapters", "unassigned", "issues", "issueSeq"],
    "manifest",
    push
  );

  if (isArray(chapters)) {
    chapters.forEach((ch, i) => {
      checkChapter(ch, `chapters[${i}]`, push);
    });
  }
  if (isArray(unassigned)) {
    unassigned.forEach((f, i) => {
      checkFile(f, `unassigned[${i}]`, push, { requireReason: true });
    });
  }
  if (isArray(issues)) {
    const ids = new Set<string>();
    issues.forEach((issue, i) => {
      checkIssue(issue, `issues[${i}]`, push);
      if (isObject(issue) && typeof issue.id === "string") {
        if (ids.has(issue.id)) push(`duplicate issue id "${issue.id}"`);
        ids.add(issue.id);
      }
    });
  }
  return errors;
}

/** One entry's claim on a path: a whole-file claim (null) or an explicit hunk list. */
interface Claim {
  owner: string;
  status: FileStatus;
  hunks: Hunk[] | null;
}

/**
 * Narrows to Manifest once structuralErrors has come back clean. The checks here
 * are the ones the compiler needs to see; structuralErrors is what actually
 * establishes the rest, field by field, and reports it in detail.
 */
function hasManifestShape(m: unknown): m is Manifest {
  return (
    isObject(m) &&
    typeof m.base === "string" &&
    typeof m.head === "string" &&
    typeof m.mergeBase === "string" &&
    typeof m.generatedAt === "string" &&
    isArray(m.chapters) &&
    isArray(m.unassigned)
  );
}

/**
 * True when `x` satisfies the whole contract. The narrowing companion to
 * validateManifest, for callers that want the type rather than the errors.
 */
export function isManifest(x: unknown): x is Manifest {
  return validateManifest(x).ok;
}

/**
 * Validate a parsed chapters.json against the contract: structure first, then
 * the partition rules structure can't express (no hunk claimed twice, no
 * overlapping ranges). Returns the stats on success or the collected errors.
 */
export function validateManifest(manifest: unknown): ValidationResult {
  const structural = structuralErrors(manifest);
  if (structural.length > 0) return { ok: false, errors: structural };
  if (!hasManifestShape(manifest)) {
    return { ok: false, errors: ["schema: manifest must be an object"] };
  }
  const m = manifest;
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const ch of m.chapters) {
    if (ids.has(ch.id)) errors.push(`duplicate chapter id "${ch.id}"`);
    ids.add(ch.id);
  }

  // Claims per path, across chapters and unassigned.
  // A claim is either the whole file (entry without hunks) or a hunk list.
  const byPath = new Map<string, Claim[]>();
  const entries: { owner: string; file: FileEntry }[] = [
    ...m.chapters.flatMap((ch) => ch.files.map((f) => ({ owner: ch.id, file: f }))),
    ...m.unassigned.map((f) => ({ owner: "unassigned", file: f })),
  ];

  for (const { owner, file } of entries) {
    if (file.oldPath && file.status !== "renamed") {
      errors.push(
        `${file.path} (${owner}): oldPath given but status is "${file.status}"`
      );
    }
    const claims = byPath.get(file.path) ?? [];
    if (!byPath.has(file.path)) byPath.set(file.path, claims);
    claims.push({ owner, status: file.status, hunks: file.hunks ?? null });
  }

  for (const [p, claims] of byPath) {
    const owners = claims.map((c) => c.owner).join(", ");

    if (new Set(claims.map((c) => c.status)).size > 1) {
      errors.push(`${p}: conflicting status across entries (${owners})`);
    }

    const whole = claims.filter((c) => c.hunks === null);
    if (whole.length > 0 && claims.length > 1) {
      errors.push(
        `${p}: claimed as whole file but appears in multiple entries (${owners})`
      );
      continue;
    }

    // Pairwise hunk checks within one path.
    const hunkClaims = claims.flatMap((c) =>
      (c.hunks ?? []).map((h) => ({ owner: c.owner, h }))
    );
    // Every unordered pair, once: index i against every later index.
    const pairs = hunkClaims.flatMap((first, i) =>
      hunkClaims.slice(i + 1).map((second) => [first, second] as const)
    );
    for (const [{ owner: ownerA, h: a }, { owner: ownerB, h: b }] of pairs) {
      if (
        a.oldStart === b.oldStart &&
        a.oldLines === b.oldLines &&
        a.newStart === b.newStart &&
        a.newLines === b.newLines
      ) {
        errors.push(
          `${p}: identical hunk @@ -${a.oldStart},${a.oldLines} +${a.newStart},${a.newLines} @@ claimed by ${ownerA} and ${ownerB}`
        );
      } else if (
        spansOverlap(a.newStart, a.newLines, b.newStart, b.newLines) ||
        spansOverlap(a.oldStart, a.oldLines, b.oldStart, b.oldLines)
      ) {
        errors.push(`${p}: overlapping hunks claimed by ${ownerA} and ${ownerB}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    stats: {
      chapters: m.chapters.length,
      files: byPath.size,
      hunks: entries.reduce((n, e) => n + (e.file.hunks?.length ?? 1), 0),
    },
  };
}

// Zero-length spans are insertion points and can't overlap anything.
function spansOverlap(startA: number, lenA: number, startB: number, lenB: number): boolean {
  if (lenA === 0 || lenB === 0) return false;
  return startA < startB + lenB && startB < startA + lenA;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node validate.ts <manifest.json>");
    process.exit(2);
  }
  // A missing or unreadable path is ordinary CLI misuse; report it as such
  // rather than letting an ENOENT stack trace out.
  if (!existsSync(target)) {
    console.error(`validate: cannot read ${target}`);
    process.exit(2);
  }
  const parsed = tryReadJson(() => readFileSync(target, "utf8"));
  if (!parsed.ok) {
    console.error(`validate: ${target} is not readable as JSON: ${parsed.error}`);
    process.exit(2);
  }
  const result = validateManifest(parsed.value);
  if (result.ok) {
    const { stats } = result;
    console.log(
      `OK ${target}: ${stats.chapters} chapters, ${stats.files} files, ${stats.hunks} claims (a whole-file claim counts once, regardless of its hunk count)`
    );
  } else {
    console.error(`INVALID: ${target}`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
