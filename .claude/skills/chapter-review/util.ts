// Tiny cross-cutting helpers, kept dependency-free so every other module can
// import them without pulling in git or fs.

/** Print `msg` to stderr and exit with `code` (default 1). Never returns. */
export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/**
 * Type predicate for a plain object. Everything that reads parsed JSON narrows
 * through this, so property access downstream is `unknown` rather than `any`.
 */
export const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * Array.isArray widens `unknown` to `any[]`, which puts `any` back into every
 * element. This keeps elements at `unknown`.
 */
export const isArray = (x: unknown): x is unknown[] => Array.isArray(x);

/**
 * The message of a caught value. `catch` binds `unknown`, and asserting it to
 * Error is a claim the language does not back: `throw "boom"` and rejected
 * non-Errors both reach here, where the cast would read `.message` off a string
 * and report undefined.
 */
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Read and parse JSON as a value rather than a control-flow event, so callers
 * bind a const instead of declaring it first and filling it in a catch.
 *
 * The read is a thunk so its failure lands here too: an unreadable file and
 * malformed contents are the same thing to every caller, and keeping fs out of
 * this module leaves it importable without pulling in git or the filesystem.
 */
export function tryReadJson(read: () => string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(read()) as unknown };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * A copy without the undefined-valued keys, in the original key order. How an
 * optional field gets removed here, since `delete` is banned by the lint config
 * and a key left at undefined still shows up in Object.keys — which the
 * manifest's "unknown property" validation walks.
 */
export function withoutUndefined<T extends object>(obj: T): T {
  // The one assertion the codebase keeps. Object.fromEntries is typed to return
  // a fresh index-signature object, and no predicate can express "same T, minus
  // the keys that were optional anyway" — dropping an undefined-valued optional
  // property leaves a value of T by construction, which only the caller's type
  // records.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as T;
}
