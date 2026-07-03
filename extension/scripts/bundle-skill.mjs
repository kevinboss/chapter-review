// Copies the chapter-review skill into the extension so it ships inside the
// .vsix, and stamps the bundled copy's version with the extension's version.
// The skill's source of truth is the repo's .claude/skills/chapter-review;
// extension/skill/ is a build artifact (gitignored) regenerated on every build.
//
// Stamping matters: the extension's install/update check compares the bundled
// skill version against the installed one. Deriving that version from the
// extension version (rather than a hand-maintained field) means it can never
// drift, every extension release re-stamps it, so a changed skill always
// triggers the update prompt. The source skill keeps a placeholder version for
// standalone (non-extension) copies. Runs from vscode:prepublish.

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
const text = readFileSync(skillMd, "utf8");
const versionLine = /^(\s*version:\s*).*$/m;
if (!versionLine.test(text)) {
  throw new Error("bundle-skill: no `version:` line in SKILL.md to stamp");
}
writeFileSync(skillMd, text.replace(versionLine, `$1${version}`));

console.log(
  `Bundled skill: ${path.relative(extDir, src)} -> ${path.relative(extDir, dest)} (stamped version ${version})`
);
