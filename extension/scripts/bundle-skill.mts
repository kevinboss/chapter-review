// Copies the chapter-review skill into the extension so it ships inside the
// .vsix, and stamps the bundled copy with a digest of its own contents.
// The skill's source of truth is the repo's .claude/skills/chapter-review;
// extension/skill/ is a build artifact (gitignored) regenerated on every build.
//
// `contentHash` is the skill's entire identity: the installed copy is a projection
// of this bundle, so "should the user update?" is just "does their copy differ?".
// No version is stamped, because inside the digest it would make one skill built
// at two versions look like two, prompting an update for identical content.
//
// The source skill carries no stamp; it exists only on shipped (bundled or
// installed) copies, added here. Runs from vscode:prepublish.

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

// Hashed before the stamp is written, so the digest covers exactly what was
// copied and never itself. That also makes it reproducible: the same source tree
// always yields the same hash, whatever the extension version happens to be.
const skillMd = path.join(dest, "SKILL.md");
const contentHash = hashTree(dest);
writeFileSync(skillMd, stampContentHash(readFileSync(skillMd, "utf8"), contentHash));

/**
 * Writes `metadata.contentHash` into the skill's YAML frontmatter: overwrites an
 * existing line, else adds it under an existing `metadata:` block, else inserts a
 * fresh `metadata:` block at the end of the frontmatter. Kept under `metadata:`
 * because the agent-skill schema rejects unknown top-level keys.
 */
function stampContentHash(text: string, value: string): string {
  const key = "contentHash";
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
    `(contentHash ${contentHash})`
);
