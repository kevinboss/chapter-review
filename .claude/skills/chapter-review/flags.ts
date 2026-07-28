// Flag parsing for the issue and uncheck subcommands, plus the field-level
// checks (severity, confidence, status, chapter id, hunk shape) that fail fast
// before a change reaches the manifest validator.

import { die } from "./util.ts";
import type { Confidence, Hunk, IssueStatus, Severity } from "./types.ts";

// Partial, because a flag that was not passed is genuinely absent. Typing this
// as a bare Record would claim every flag is always present, making the
// undefined-guards below look redundant while they are load-bearing.
export type Flags = Partial<Record<string, string>>;

export interface IssueFields {
  path?: string;
  oldPath?: string;
  note?: string;
  severity?: Severity;
  chapterId?: string;
  confidence?: Confidence;
  status?: IssueStatus;
  hunk?: Hunk;
}

const SEVERITY = new Set(["critical", "high", "low"]);
const ISSUE_STATUS = new Set(["open", "resolved"]);
const CONFIDENCE = new Set(["suspected", "verified"]);
const CHAPTER_ID = /^ch-[0-9]+$/;

const FLAG_ALIASES: Record<string, string> = { "--old-path": "oldPath", "--chapter": "chapterId" };

/**
 * Parse `--key value` tokens into an object, applying the flag aliases and
 * rejecting an unknown flag or a flag given without a value.
 */
export function parseFlags(argv: string[], allowed: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) die(`chapter-review: unexpected argument "${tok}"`);
    const key = FLAG_ALIASES[tok] ?? tok.slice(2);
    if (!allowed.includes(key)) die(`chapter-review: unknown flag "${tok}"`);
    // .at() rather than [++i]: indexing is typed `string`, which would narrow
    // the guard below away, but a flag given as the last token genuinely has no
    // value. .at() reports the `string | undefined` that actually occurs.
    const val = argv.at(++i);
    if (val === undefined) die(`chapter-review: ${tok} needs a value`);
    out[key] = val;
  }
  return out;
}

/** Parse a "oldStart,oldLines,newStart,newLines" spec into a Hunk. */
export function parseHunk(spec: string): Hunk {
  // Strict decimal only. Number() would accept "0x10", "1e3" and "" (as 0), so a
  // typo'd coordinate would become a valid *different* range and file the finding
  // against the wrong hunk instead of erroring.
  // isSafeInteger, not isInteger: a 21-digit run of decimals passes the regex and
  // Number() turns it into 1e+21, which isInteger accepts and JSON.stringify
  // writes out in exponent notation.
  const raw = spec.split(",").map((t) => t.trim());
  const parts = raw.map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
  if (parts.length !== 4 || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    die(
      `chapter-review: --hunk must be "oldStart,oldLines,newStart,newLines" (got "${spec}")`
    );
  }
  const [oldStart, oldLines, newStart, newLines] = parts;
  return { oldStart, oldLines, newStart, newLines };
}

/**
 * Build the issue fields a flag set describes (validated at the field level;
 * full disjointness and schema checks happen when the manifest is installed).
 */
export function issueFieldsFromFlags(flags: Flags): IssueFields {
  const fields: IssueFields = {};
  if (flags.path !== undefined) fields.path = flags.path;
  if (flags.oldPath !== undefined) fields.oldPath = flags.oldPath;
  if (flags.note !== undefined) fields.note = flags.note;
  if (flags.severity !== undefined) {
    if (!SEVERITY.has(flags.severity)) {
      die(`chapter-review: --severity must be one of ${[...SEVERITY].join(", ")}`);
    }
    fields.severity = flags.severity as Severity;
  }
  if (flags.chapterId !== undefined) {
    if (!CHAPTER_ID.test(flags.chapterId)) {
      die("chapter-review: --chapter must match ch-<number>");
    }
    fields.chapterId = flags.chapterId;
  }
  if (flags.confidence !== undefined) {
    if (!CONFIDENCE.has(flags.confidence)) {
      die(`chapter-review: --confidence must be one of ${[...CONFIDENCE].join(", ")}`);
    }
    fields.confidence = flags.confidence as Confidence;
  }
  if (flags.status !== undefined) {
    if (!ISSUE_STATUS.has(flags.status)) {
      die(`chapter-review: --status must be one of ${[...ISSUE_STATUS].join(", ")}`);
    }
    fields.status = flags.status as IssueStatus;
  }
  if (flags.hunk !== undefined) fields.hunk = parseHunk(flags.hunk);
  return fields;
}
