// Copies the chapter-review skill into the extension so it ships inside the
// .vsix. The skill's source of truth is the repo's .claude/skills/chapter-review;
// extension/skill/ is a build artifact (gitignored) regenerated on every build.
// Runs from vscode:prepublish, so `vsce package` always bundles the current skill.

import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(extDir, "..", ".claude", "skills", "chapter-review");
const dest = path.join(extDir, "skill");

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`Bundled skill: ${path.relative(extDir, src)} -> ${path.relative(extDir, dest)}`);
