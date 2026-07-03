// Validates a chapters.json manifest: JSON Schema first, then the partition
// rules the schema can't express. Used by `npm test` here, by the skill as its
// pre-write validation step, and by the extension before rendering.
//
// CLI: node scripts/validate.mjs <manifest.json>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "chapters.schema.json"
);

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile(
  JSON.parse(readFileSync(schemaPath, "utf8"))
);

/**
 * @param {unknown} manifest parsed chapters.json
 * @returns {{ ok: boolean, errors: string[], stats?: { chapters: number, files: number, hunks: number } }}
 */
export function validateManifest(manifest) {
  if (!validateSchema(manifest)) {
    const errors = validateSchema.errors.map(
      (e) => `schema: ${e.instancePath || "/"} ${e.message}`
    );
    return { ok: false, errors };
  }

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
    console.error("usage: node scripts/validate.mjs <manifest.json>");
    process.exit(2);
  }
  const result = validateManifest(JSON.parse(readFileSync(target, "utf8")));
  if (result.ok) {
    const s = result.stats;
    console.log(
      `OK: ${target} — ${s.chapters} chapters, ${s.files} files, ${s.hunks} hunk claims`
    );
  } else {
    console.error(`INVALID: ${target}`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
