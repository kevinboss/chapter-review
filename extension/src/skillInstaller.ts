import * as os from "node:os";
import * as vscode from "vscode";

// Installs the bundled chapter-review skill into a coding agent's skills dir.
// Consent-gated: the extension never writes into the user's config silently.
// The skill's source of truth ships inside the .vsix at <extension>/skill/.

const SKILL_NAME = "chapter-review";
// globalState: the bundled skill version we last showed an update notice for,
// so an available update is announced once per version, not in every git repo.
const NOTIFIED_UPDATE_KEY = "chapterReview.updateNotifiedVersion";

type Scope = "user" | "workspace";

interface InstallTarget {
  scope: Scope;
  label: string;
  detail: string;
  dir: vscode.Uri; // the destination chapter-review/ folder
}

function bundledSkillDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.extensionUri, "skill");
}

/**
 * A future agent (opencode, etc.) is one more entry here: only the skills-dir
 * location differs, the bundled folder and copy mechanism are the same.
 */
function installTargets(): InstallTarget[] {
  const home = vscode.Uri.file(os.homedir());
  const targets: InstallTarget[] = [
    {
      scope: "user",
      label: "$(home) User (all repositories)",
      detail: "~/.claude/skills/chapter-review",
      dir: vscode.Uri.joinPath(home, ".claude", "skills", SKILL_NAME),
    },
  ];
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    targets.push({
      scope: "workspace",
      label: "$(folder) This workspace",
      detail: `${ws.name}/.claude/skills/chapter-review`,
      dir: vscode.Uri.joinPath(ws.uri, ".claude", "skills", SKILL_NAME),
    });
  }
  return targets;
}

/**
 * `version` from a SKILL.md's frontmatter `metadata` block, or undefined if
 * the file is absent. Lives under `metadata:` because VS Code's agent-skill
 * schema rejects a top-level `version` key; the leading indent is allowed for.
 */
async function readSkillVersion(skillMd: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(skillMd);
    const text = Buffer.from(bytes).toString("utf8");
    return text.match(/^\s*version:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  } catch {
    return undefined;
  }
}

async function copyDir(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(dest);
  for (const [name, type] of await vscode.workspace.fs.readDirectory(src)) {
    const from = vscode.Uri.joinPath(src, name);
    const to = vscode.Uri.joinPath(dest, name);
    if (type === vscode.FileType.Directory) {
      await copyDir(from, to);
    } else {
      await vscode.workspace.fs.copy(from, to, { overwrite: true });
    }
  }
}

async function writeSkill(context: vscode.ExtensionContext, target: InstallTarget): Promise<void> {
  try {
    await copyDir(bundledSkillDir(context), target.dir);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Chapter Review: could not install the skill to ${target.detail}: ${(e as Error).message}`
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Chapter Review skill installed to ${target.detail}. Restart your coding agent if it was already running so it loads the skill.`,
    "Show folder"
  );
  if (choice === "Show folder") {
    void vscode.commands.executeCommand("revealFileInOS", target.dir);
  }
}

/** Command entry point: pick a location (or use the given scope) and install. */
export async function installSkill(
  context: vscode.ExtensionContext,
  scope?: Scope
): Promise<void> {
  const bundledVersion = await readSkillVersion(
    vscode.Uri.joinPath(bundledSkillDir(context), "SKILL.md")
  );
  const targets = installTargets();
  let target = scope && targets.find((t) => t.scope === scope);

  if (!target) {
    const pick = await vscode.window.showQuickPick(
      targets.map((t) => ({ label: t.label, detail: t.detail, target: t })),
      { title: "Install Chapter Review skill", placeHolder: "Where should the skill go?" }
    );
    if (!pick) {
      return;
    }
    target = pick.target;
  }

  const existing = await readSkillVersion(vscode.Uri.joinPath(target.dir, "SKILL.md"));
  if (existing && existing === bundledVersion) {
    const choice = await vscode.window.showInformationMessage(
      `Chapter Review skill ${existing} is already installed at ${target.detail}.`,
      "Reinstall"
    );
    if (choice !== "Reinstall") {
      return;
    }
  }
  await writeSkill(context, target);
}

/**
 * On activation, notify only opted-in users of an available update: an
 * installed copy exists but differs from the bundled version. Shown once per
 * bundled version so it doesn't re-fire in every git repo.
 *
 * A missing skill is deliberately NOT announced here. The extension activates
 * in every git repo, so an unsolicited "install?" toast would nag across
 * unrelated projects. Installation is offered where the user actually engages
 * with the feature: the empty Chapters view's welcome link and the
 * "Install or Update Skill" command.
 */
export async function checkSkill(context: vscode.ExtensionContext): Promise<void> {
  const bundledVersion = await readSkillVersion(
    vscode.Uri.joinPath(bundledSkillDir(context), "SKILL.md")
  );
  if (!bundledVersion) {
    return; // no bundled skill (e.g. dev build without bundling); nothing to offer
  }

  let outdated: InstallTarget | undefined;
  for (const t of installTargets()) {
    const v = await readSkillVersion(vscode.Uri.joinPath(t.dir, "SKILL.md"));
    if (v === bundledVersion) {
      return; // a current copy exists somewhere; leave the user alone
    }
    if (v && !outdated) {
      outdated = t;
    }
  }
  if (!outdated) {
    return; // skill absent everywhere: handled by the view, not a popup
  }
  if (context.globalState.get<string>(NOTIFIED_UPDATE_KEY) === bundledVersion) {
    return; // already announced this version's update
  }

  await context.globalState.update(NOTIFIED_UPDATE_KEY, bundledVersion);
  const choice = await vscode.window.showInformationMessage(
    `A newer Chapter Review skill (${bundledVersion}) is available for ${outdated.detail}.`,
    "Update",
    "Not now"
  );
  if (choice === "Update") {
    await installSkill(context, outdated.scope);
  }
}
