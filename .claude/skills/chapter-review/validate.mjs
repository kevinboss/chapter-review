// Validates a chapters.json manifest: structure first, then the partition
// rules structure can't express. Zero dependencies (Node builtins only) so the
// skill directory is self-contained and portable into any repo; copy it in,
// no npm install. This validator is authoritative; chapters.schema.json is the
// same contract expressed as JSON Schema for editors and documentation. Keep
// the two in sync when the contract changes.
//
// CLI: node validate.mjs <manifest.json>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STATUS = new Set(["added", "modified", "deleted", "renamed"]);
const SEVERITY = new Set(["critical", "high", "low"]);
const ISSUE_STATUS = new Set(["open", "resolved"]);
const CONFIDENCE = new Set(["suspected", "verified"]);
const SHA = /^[0-9a-f]{7,40}$/;
const DIGEST = /^[0-9a-f]+$/;
const CHAPTER_ID = /^ch-[0-9]+$/;
const ISSUE_ID = /^iss-[0-9]+$/;
const PATH = /^[^/]/; // repo-relative, no leading slash
// ISO-8601 date-time with a required zone (Z or offset); seconds optional, so a
// minute-precision stamp like 2026-07-06T12:22Z is accepted, not just RFC-3339.
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function noExtraKeys(obj, allowed, label, push) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(`${label} has unknown property "${key}"`);
  }
}

function checkHunk(h, label, push) {
  if (!isObject(h)) {
    push(`${label} must be an object`);
    return;
  }
  for (const k of ["oldStart", "oldLines", "newStart", "newLines"]) {
    if (!Number.isInteger(h[k]) || h[k] < 0) {
      push(`${label}.${k} must be an integer >= 0`);
    }
  }
  noExtraKeys(h, ["oldStart", "oldLines", "newStart", "newLines"], label, push);
}

function checkHunks(hunks, label, push) {
  if (hunks === undefined) return;
  if (!Array.isArray(hunks) || hunks.length < 1) {
    push(`${label}.hunks, when present, must be a non-empty array`);
    return;
  }
  hunks.forEach((h, i) => checkHunk(h, `${label}.hunks[${i}]`, push));
}

function checkPath(value, label, push) {
  if (typeof value !== "string" || value.length < 1 || !PATH.test(value)) {
    push(`${label} must be a repo-relative path with no leading slash`);
  }
}

function checkFile(file, label, push, { requireReason }) {
  if (!isObject(file)) {
    push(`${label} must be an object`);
    return;
  }
  checkPath(file.path, `${label}.path`, push);
  if (file.oldPath !== undefined) checkPath(file.oldPath, `${label}.oldPath`, push);
  if (!STATUS.has(file.status)) {
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

function checkChapter(ch, label, push) {
  if (!isObject(ch)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof ch.id !== "string" || !CHAPTER_ID.test(ch.id)) {
    push(`${label}.id must match ch-<number>`);
  }
  if (typeof ch.title !== "string" || ch.title.length < 1 || ch.title.length > 60) {
    push(`${label}.title must be a string of 1-60 chars`);
  }
  if (ch.description !== undefined && typeof ch.description !== "string") {
    push(`${label}.description must be a string`);
  }
  if (!Array.isArray(ch.files) || ch.files.length < 1) {
    push(`${label}.files must be a non-empty array`);
  } else {
    ch.files.forEach((f, i) =>
      checkFile(f, `${label}.files[${i}]`, push, { requireReason: false })
    );
  }
  noExtraKeys(ch, ["id", "title", "description", "files"], label, push);
}

function checkIssue(issue, label, push) {
  if (!isObject(issue)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof issue.id !== "string" || !ISSUE_ID.test(issue.id)) {
    push(`${label}.id must match iss-<number>`);
  }
  checkPath(issue.path, `${label}.path`, push);
  if (issue.oldPath !== undefined) checkPath(issue.oldPath, `${label}.oldPath`, push);
  if (issue.hunk !== undefined) checkHunk(issue.hunk, `${label}.hunk`, push);
  if (issue.chapterId !== undefined && (typeof issue.chapterId !== "string" || !CHAPTER_ID.test(issue.chapterId))) {
    push(`${label}.chapterId must match ch-<number>`);
  }
  if (!SEVERITY.has(issue.severity)) {
    push(`${label}.severity must be one of ${[...SEVERITY].join(", ")}`);
  }
  if (typeof issue.note !== "string" || issue.note.length < 1) {
    push(`${label}.note must be a non-empty string`);
  }
  if (issue.confidence !== undefined && !CONFIDENCE.has(issue.confidence)) {
    push(`${label}.confidence must be one of ${[...CONFIDENCE].join(", ")}`);
  }
  if (issue.status !== undefined && !ISSUE_STATUS.has(issue.status)) {
    push(`${label}.status must be one of ${[...ISSUE_STATUS].join(", ")}`);
  }
  noExtraKeys(
    issue,
    ["id", "path", "oldPath", "hunk", "chapterId", "severity", "note", "confidence", "status", "createdAt"],
    label,
    push
  );
}

function checkReviewedUnit(u, label, push) {
  if (!isObject(u)) {
    push(`${label} must be an object`);
    return;
  }
  checkPath(u.path, `${label}.path`, push);
  if (u.hunk !== undefined) checkHunk(u.hunk, `${label}.hunk`, push);
  if (typeof u.digest !== "string" || !DIGEST.test(u.digest)) {
    push(`${label}.digest must be a hex string`);
  }
  noExtraKeys(u, ["path", "hunk", "digest"], label, push);
}

function structuralErrors(m) {
  const errors = [];
  const push = (msg) => errors.push(`schema: ${msg}`);

  if (!isObject(m)) {
    push("manifest must be an object");
    return errors;
  }
  if (m.version !== 1) push(`version must be 1 (got ${JSON.stringify(m.version)})`);
  for (const k of ["base", "head"]) {
    if (typeof m[k] !== "string" || m[k].length < 1) {
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
  if (!Array.isArray(m.chapters)) push("chapters must be an array");
  if (!Array.isArray(m.unassigned)) push("unassigned must be an array");
  if (m.issues !== undefined && !Array.isArray(m.issues)) push("issues, when present, must be an array");
  if (m.reviewed !== undefined && !Array.isArray(m.reviewed)) push("reviewed, when present, must be an array");
  noExtraKeys(
    m,
    ["version", "base", "head", "mergeBase", "headSha", "generatedAt", "summary", "chapters", "unassigned", "issues", "reviewed"],
    "manifest",
    push
  );

  if (Array.isArray(m.chapters)) {
    m.chapters.forEach((ch, i) => checkChapter(ch, `chapters[${i}]`, push));
  }
  if (Array.isArray(m.unassigned)) {
    m.unassigned.forEach((f, i) =>
      checkFile(f, `unassigned[${i}]`, push, { requireReason: true })
    );
  }
  if (Array.isArray(m.issues)) {
    const ids = new Set();
    m.issues.forEach((issue, i) => {
      checkIssue(issue, `issues[${i}]`, push);
      if (isObject(issue) && typeof issue.id === "string") {
        if (ids.has(issue.id)) push(`duplicate issue id "${issue.id}"`);
        ids.add(issue.id);
      }
    });
  }
  if (Array.isArray(m.reviewed)) {
    m.reviewed.forEach((u, i) => checkReviewedUnit(u, `reviewed[${i}]`, push));
  }
  return errors;
}

/**
 * @param {unknown} manifest parsed chapters.json
 * @returns {{ ok: boolean, errors: string[], stats?: { chapters: number, files: number, hunks: number } }}
 */
export function validateManifest(manifest) {
  const structural = structuralErrors(manifest);
  if (structural.length > 0) return { ok: false, errors: structural };

  const errors = [];

  const ids = new Set();
  for (const ch of manifest.chapters) {
    if (ids.has(ch.id)) errors.push(`duplicate chapter id "${ch.id}"`);
    ids.add(ch.id);
  }

  // Claims per path, across chapters and unassigned.
  // A claim is either the whole file (entry without hunks) or a hunk list.
  const byPath = new Map();
  const entries = [
    ...manifest.chapters.flatMap((ch) =>
      ch.files.map((f) => ({ owner: ch.id, file: f }))
    ),
    ...manifest.unassigned.map((f) => ({ owner: "unassigned", file: f })),
  ];

  for (const { owner, file } of entries) {
    if (file.oldPath && file.status !== "renamed") {
      errors.push(
        `${file.path} (${owner}): oldPath given but status is "${file.status}"`
      );
    }
    let claims = byPath.get(file.path);
    if (!claims) byPath.set(file.path, (claims = []));
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
    const hunks = claims.flatMap((c) =>
      (c.hunks ?? []).map((h) => ({ owner: c.owner, h }))
    );
    for (let i = 0; i < hunks.length; i++) {
      for (let j = i + 1; j < hunks.length; j++) {
        const a = hunks[i];
        const b = hunks[j];
        if (
          a.h.oldStart === b.h.oldStart &&
          a.h.oldLines === b.h.oldLines &&
          a.h.newStart === b.h.newStart &&
          a.h.newLines === b.h.newLines
        ) {
          errors.push(
            `${p}: identical hunk @@ -${a.h.oldStart},${a.h.oldLines} +${a.h.newStart},${a.h.newLines} @@ claimed by ${a.owner} and ${b.owner}`
          );
        } else if (
          spansOverlap(a.h.newStart, a.h.newLines, b.h.newStart, b.h.newLines) ||
          spansOverlap(a.h.oldStart, a.h.oldLines, b.h.oldStart, b.h.oldLines)
        ) {
          errors.push(
            `${p}: overlapping hunks claimed by ${a.owner} and ${b.owner}`
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    stats: {
      chapters: manifest.chapters.length,
      files: byPath.size,
      hunks: entries.reduce((n, e) => n + (e.file.hunks?.length ?? 1), 0),
    },
  };
}

// Zero-length spans are insertion points and can't overlap anything.
function spansOverlap(startA, lenA, startB, lenB) {
  if (lenA === 0 || lenB === 0) return false;
  return startA < startB + lenB && startB < startA + lenA;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node validate.mjs <manifest.json>");
    process.exit(2);
  }
  const result = validateManifest(JSON.parse(readFileSync(target, "utf8")));
  if (result.ok) {
    const s = result.stats;
    console.log(
      `OK ${target}: ${s.chapters} chapters, ${s.files} files, ${s.hunks} claims (a whole-file claim counts once, regardless of its hunk count)`
    );
  } else {
    console.error(`INVALID: ${target}`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
