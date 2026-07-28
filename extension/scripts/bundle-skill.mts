// Copies the chapter-review skill into the extension so it ships inside the
// .vsix, and stamps the bundled copy's version with the extension's version.
// The skill's source of truth is the repo's .claude/skills/chapter-review;
// extension/skill/ is a build artifact (gitignored) regenerated on every build.
//
// Two things get stamped. `version` is the extension's version, for display and
// release traceability. `contentHash` is what the install/update check actually
// compares: the installed skill is a projection of this bundle, so "should the
// user update?" is "does their copy differ from what this plugin carries?", with
// no notion of newer or older. A version alone could not answer that, because a
// skill edit between releases leaves the version untouched.
//
// The source skill carries neither stamp; they exist only on shipped
// (bundled/installed) copies, added here. Runs from vscode:prepublish.

import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(extDir, "..", ".claude", "skills", "chapter-review");
const dest = path.join(extDir, "skill");

rmSync(dest, { recursive: true, force: true });
// Skip the dev-only artifacts that support type-checking the source here
// (node_modules, the @types/node lockfile, tsconfig). None are needed to run
// the skill, and node_modules would bloat the shipped .vsix. package.json stays
// because its "type":"module" marks the folder as ESM at runtime.
const SKIP = new Set(["node_modules", "package-lock.json", "tsconfig.json"]);
cpSync(src, dest, {
  recursive: true,
  filter: (entry) => !SKIP.has(path.basename(entry)),
});

const pkg: unknown = JSON.parse(readFileSync(path.join(extDir, "package.json"), "utf8"));
if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") {
  throw new Error("extension/package.json has no string `version`");
}
const { version } = pkg;
const skillMd = path.join(dest, "SKILL.md");
writeFileSync(skillMd, stamp(readFileSync(skillMd, "utf8"), "version", version));

// Hashed after the version stamp and before the hash stamp, so the digest covers
// everything shipped (the version included) and never itself.
const contentHash = hashTree(dest);
writeFileSync(skillMd, stamp(readFileSync(skillMd, "utf8"), "contentHash", contentHash));

/**
 * Writes `metadata.<key>` into the skill's YAML frontmatter: overwrites an
 * existing line, else adds it under an existing `metadata:` block, else inserts a
 * fresh `metadata:` block at the end of the frontmatter. Kept under `metadata:`
 * because the agent-skill schema rejects unknown top-level keys.
 */
function stamp(text: string, key: string, value: string): string {
  const line = new RegExp(`^\\s*${key}:\\s*.*$`, "m");
  if (line.test(text)) {
    return text.replace(new RegExp(`^(\\s*${key}:\\s*).*$`, "m"), `$1${value}`);
  }
  if (/^metadata:\s*$/m.test(text)) {
    return text.replace(/^metadata:\s*$/m, `metadata:\n  ${key}: ${value}`);
  }
  const fm = /^(---\n[\s\S]*?\n)(---\n)/.exec(text);
  if (!fm) {
    throw new Error("bundle-skill: SKILL.md has no YAML frontmatter to stamp");
  }
  return fm[1] + `metadata:\n  ${key}: ${value}\n` + fm[2] + text.slice(fm[0].length);
}

/** Digest of every file in the tree, path included so a rename changes it. */
function hashTree(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        h.update(path.relative(root, full).split(path.sep).join("/"));
        h.update("\0");
        h.update(readFileSync(full));
        h.update("\0");
      }
    }
  };
  walk(root);
  return h.digest("hex").slice(0, 16);
}

console.log(
  `Bundled skill: ${path.relative(extDir, src)} -> ${path.relative(extDir, dest)} ` +
    `(version ${version}, contentHash ${contentHash})`
);
