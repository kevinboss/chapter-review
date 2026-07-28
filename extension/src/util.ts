/**
 * The message of a caught value. `catch` binds `unknown`, and asserting it to
 * Error is a claim the language does not back: `throw "boom"` and rejected
 * non-Errors both reach here, where the cast would read `.message` off a string
 * and report undefined.
 *
 * Deliberately duplicated from the skill's util.ts rather than shared: the
 * extension and the CLI are separate TypeScript projects, and the skill folder
 * has to stay copy-and-run portable on its own.
 */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
