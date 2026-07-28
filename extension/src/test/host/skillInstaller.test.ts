// The install decision, not the install. Everything here is read-only: the home
// directory is injected so a test can never reach the real ~/.claude/skills.

import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as vscode from "vscode";
import {
  computeSkillStatus,
  installSkill,
  installTargets,
  type SkillStamp,
} from "../../skillInstaller";

suite("install targets", () => {
  test("offers the user directory, under the home it is given", () => {
    const [user] = installTargets("/tmp/not-a-real-home");
    assert.equal(user.scope, "user");
    assert.match(user.dir.path, /\/tmp\/not-a-real-home\/\.claude\/skills\/chapter-review$/);
  });

  test("offers the workspace too when there is one", () => {
    const targets = installTargets("/tmp/not-a-real-home");
    const ws = vscode.workspace.workspaceFolders?.[0];
    assert.ok(ws, "the host tests run against a workspace");
    assert.deepEqual(
      targets.map((t) => t.scope),
      ["user", "workspace"]
    );
    assert.match(targets[1].dir.path, /\.claude\/skills\/chapter-review$/);
    assert.ok(
      targets[1].dir.path.startsWith(ws.uri.path),
      "the workspace target must sit inside the workspace"
    );
  });

  test("defaults to the real home when none is given", () => {
    // Only the path is inspected; nothing is written.
    const [user] = installTargets();
    assert.ok(user.dir.path.startsWith(vscode.Uri.file(os.homedir()).path));
  });
});

suite("installing the skill", () => {
  // Only the workspace scope, and the workspace is the harness's temp repo, so
  // this never approaches the real ~/.claude/skills. Naming a scope also skips
  // the QuickPick, which is the only interactive step on this path.
  test("copies a runnable skill into the workspace", async () => {
    const ext = vscode.extensions.getExtension("kevinboss.chapter-review");
    assert.ok(ext);
    const ws = vscode.workspace.workspaceFolders?.[0];
    assert.ok(ws);
    const dest = vscode.Uri.joinPath(ws.uri, ".claude", "skills", "chapter-review");

    // Not awaited: writeSkill ends on a notification that waits for a click,
    // which nothing here will give it. The copy happens before that await.
    void installSkill({ extensionUri: ext.extensionUri }, "workspace");

    // The pieces the CLI needs at runtime, not just the doc. Waited on as a set:
    // copyDir writes them one at a time, so any single file arriving proves
    // nothing about the rest.
    const skillMd = vscode.Uri.joinPath(dest, "SKILL.md");
    await waitFor(async () => {
      for (const name of ["SKILL.md", "chapter-review", "main.ts", "validate.ts", "diff.ts", "package.json"]) {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dest, name));
      }
    });

    const text = Buffer.from(await vscode.workspace.fs.readFile(skillMd)).toString("utf8");
    assert.match(text, /^\s*version:/m, "bundle-skill stamps the version it installed");
  });
});

/** Poll until `probe` stops throwing, or give up. */
async function waitFor(probe: () => Promise<void>, attempts = 60): Promise<void> {
  for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
    try {
      await probe();
      return;
    } catch {
      if (attempt === attempts - 1) {
        throw new Error(`gave up after ${attempts} attempts`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

suite("skill status", () => {
  const at = (contentHash?: string, version = "1.2.0"): SkillStamp => ({ version, contentHash });

  test("nothing bundled means nothing to offer", () => {
    assert.equal(computeSkillStatus(undefined, []), "current");
    assert.equal(computeSkillStatus(undefined, [at("aaaa")]), "current");
  });

  test("no copy anywhere is a fresh install", () => {
    assert.equal(computeSkillStatus("aaaa", []), "missing");
    assert.equal(computeSkillStatus("aaaa", [undefined, undefined]), "missing");
  });

  test("a copy whose content differs is an update", () => {
    assert.equal(computeSkillStatus("aaaa", [at("bbbb")]), "present");
    assert.equal(computeSkillStatus("aaaa", [undefined, at("bbbb")]), "present");
  });

  test("a copy matching this bundle needs nothing", () => {
    assert.equal(computeSkillStatus("aaaa", [at("aaaa")]), "current");
  });

  test("same version, different content is still an update", () => {
    // The case a version comparison cannot see: the skill was edited between
    // releases, so the content moved while the stamped version stood still.
    assert.equal(computeSkillStatus("aaaa", [at("bbbb", "1.2.0")]), "present");
  });

  test("a newer version with different content is still an update", () => {
    // The installed skill is a projection of the plugin, so matching the plugin
    // is the goal; which side is "newer" carries no weight.
    assert.equal(computeSkillStatus("aaaa", [at("bbbb", "9.9.9")]), "present");
  });

  test("an unstamped copy is an update, not a fresh install", () => {
    assert.equal(computeSkillStatus("aaaa", [{ version: undefined, contentHash: undefined }]), "present");
  });

  test("one matching copy is enough, wherever it sits", () => {
    assert.equal(computeSkillStatus("aaaa", [at("bbbb"), at("aaaa")]), "current");
  });
});
