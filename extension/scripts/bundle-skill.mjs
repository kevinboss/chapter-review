// Copies the chapter-review skill into the extension so it ships inside the
// .vsix, and stamps the bundled copy's version with the extension's version.
// The skill's source of truth is the repo's .claude/skills/chapter-review;
// extension/skill/ is a build artifact (gitignored) regenerated on every build.
//
// Stamping matters: the extension's install/update check compares the bundled
// skill version against the installed one. Deriving that version from the
// extension version (rather than a hand-maintained field) means it can never
// drift, every extension release re-stamps it, so a changed skill always
// triggers the update prompt. The source skill carries NO version at all — it
// would only be a misleading placeholder; the version exists solely on shipped
// (bundled/installed) copies, added here. Runs from vscode:prepublish.

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(extDir, "..", ".claude", "skills", "chapter-review");
const dest = path.join(extDir, "skill");

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

const { version } = JSON.parse(readFileSync(path.join(extDir, "package.json"), "utf8"));
const skillMd = path.join(dest, "SKILL.md");
writeFileSync(skillMd, stampVersion(readFileSync(skillMd, "utf8"), version));

// Writes `metadata.version` into the skill's YAML frontmatter: overwrites an
// existing version line, else adds it under an existing `metadata:` block, else
// inserts a fresh `metadata:` block at the end of the frontmatter. Kept under
// `metadata:` because the agent-skill schema rejects a top-level `version` key.
function stampVersion(text, version) {
  if (/^\s*version:\s*.*$/m.test(text)) {
    return text.replace(/^(\s*version:\s*).*$/m, `$1${version}`);
  }
  if (/^metadata:\s*$/m.test(text)) {
    return text.replace(/^metadata:\s*$/m, `metadata:\n  version: ${version}`);
  }
  const fm = text.match(/^(---\n[\s\S]*?\n)(---\n)/);
  if (!fm) {
    throw new Error("bundle-skill: SKILL.md has no YAML frontmatter to stamp");
  }
  return fm[1] + `metadata:\n  version: ${version}\n` + fm[2] + text.slice(fm[0].length);
}

console.log(
  `Bundled skill: ${path.relative(extDir, src)} -> ${path.relative(extDir, dest)} (stamped version ${version})`
);
