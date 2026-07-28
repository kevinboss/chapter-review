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
