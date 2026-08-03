import * as os from "node:os";
import * as vscode from "vscode";
import { errorMessage } from "./util";

// Installs the bundled chapter-review skill into a coding agent's skills dir.
// Consent-gated: the extension never writes into the user's config silently.
// The skill's source of truth ships inside the .vsix at <extension>/skill/.

const SKILL_NAME = "chapter-review";
// globalState: the content hash of the bundled skill we last showed an update
// notice for, so an update is announced once per bundle, not in every git repo.
const NOTIFIED_UPDATE_KEY = "chapterReview.updateNotifiedVersion";

type Scope = "user" | "workspace";

interface InstallTarget {
  scope: Scope;
  label: string;
  detail: string;
  dir: vscode.Uri; // the destination chapter-review/ folder
}

/**
 * What the install path needs from the extension context: where the bundled
 * skill sits. Narrower than ExtensionContext so a test can drive an install
 * without fabricating the rest of one.
 */
export interface SkillHost {
  extensionUri: vscode.Uri;
}

function bundledSkillDir(host: SkillHost): vscode.Uri {
  return vscode.Uri.joinPath(host.extensionUri, "skill");
}

/**
 * A future agent (opencode, etc.) is one more entry here: only the skills-dir
 * location differs, the bundled folder and copy mechanism are the same.
 */
export function installTargets(homeDir: string = os.homedir()): InstallTarget[] {
  const home = vscode.Uri.file(homeDir);
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
 * What a shipped SKILL.md's `metadata` block records about its own build. One
 * field, but an object so that "no file" and "file without a stamp" stay
 * distinguishable (see readSkillStamp).
 */
export interface SkillStamp {
  /** Digest of the whole skill folder, and the skill's entire identity. */
  contentHash?: string;
}

/**
 * The `metadata` stamp from a SKILL.md, or undefined when there is no such file.
 * Absent file and present-but-unstamped are different answers: the second is an
 * installed copy that simply predates the stamp, and it needs updating, not
 * installing. It lives under `metadata:` because VS Code's agent-skill schema
 * rejects unknown top-level keys; the leading indent is allowed for.
 */
async function readSkillStamp(skillMd: vscode.Uri): Promise<SkillStamp | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(skillMd);
    const text = Buffer.from(bytes).toString("utf8");
    const found = /^\s*contentHash:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1];
    return { contentHash: found };
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

async function writeSkill(host: SkillHost, target: InstallTarget): Promise<void> {
  try {
    await copyDir(bundledSkillDir(host), target.dir);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Chapter Review: could not install the skill to ${target.detail}: ${errorMessage(e)}`
    );
    return;
  }
  await refreshSkillContext(host);
  const choice = await vscode.window.showInformationMessage(
    `Chapter Review skill installed to ${target.detail}. Restart your coding agent if it was already running so it loads the skill.`,
    "Show folder"
  );
  if (choice === "Show folder") {
    void vscode.commands.executeCommand("revealFileInOS", target.dir);
  }
}

export type SkillStatus = "missing" | "present" | "current";

/**
 * Skill state relative to the bundled copy, decided by content hash:
 *   - "current": some copy matches this bundle exactly (nothing to do), or there
 *     is no bundled skill to compare against;
 *   - "present": a copy exists and none matches this bundle (offer update);
 *   - "missing": no copy exists anywhere (offer a fresh install).
 *
 * Equality, not ordering, and the skill carries no version of its own. The
 * installed copy is a projection of this bundle, so the only question is whether
 * it matches; a copy that differs is offered an update either way. Comparing
 * extension versions instead would miss the case that matters most, a skill
 * edited between releases, where the content moves and the version does not.
 */
export function computeSkillStatus(
  bundledHash: string | undefined,
  installed: readonly (SkillStamp | undefined)[]
): SkillStatus {
  if (!bundledHash) {
    return "current"; // no bundled skill: nothing to offer
  }
  const found = installed.filter((s): s is SkillStamp => s !== undefined);
  if (found.length === 0) {
    return "missing";
  }
  return found.some((s) => s.contentHash === bundledHash) ? "current" : "present";
}


const SKILL_STATUS_KEY = "chapterReview.skillStatus";

/**
 * Every value the skillStatus context key can hold: the three statuses plus
 * "checking" while the probe runs. package.json's when-clauses branch on exactly
 * these, so a value added here needs a clause there too.
 */
type SkillContext = SkillStatus | "checking";

const setSkillContext = (value: SkillContext): Thenable<unknown> =>
  vscode.commands.executeCommand("setContext", SKILL_STATUS_KEY, value);

/**
 * Sets the skillStatus context key, which gates the install/update affordances
 * (view-title menu, welcome link): "Install" when missing, "Update" when a copy
 * that differs is present, and nothing when current.
 *
 * Claimed as "checking" before the directory probe, so the wait shows no
 * affordance rather than "Install" on a machine that already has the skill.
 */
export async function refreshSkillContext(host: SkillHost): Promise<void> {
  await setSkillContext("checking");
  const bundled = await readSkillStamp(vscode.Uri.joinPath(bundledSkillDir(host), "SKILL.md"));
  const installed = await Promise.all(
    installTargets().map((t) => readSkillStamp(vscode.Uri.joinPath(t.dir, "SKILL.md")))
  );
  await setSkillContext(computeSkillStatus(bundled?.contentHash, installed));
}

/** Command entry point: pick a location (or use the given scope) and install. */
export async function installSkill(host: SkillHost, scope?: Scope): Promise<void> {
  const bundled = await readSkillStamp(vscode.Uri.joinPath(bundledSkillDir(host), "SKILL.md"));
  const targets = installTargets();
  const named = scope === undefined ? undefined : targets.find((t) => t.scope === scope);
  // Only ask when the caller did not name a scope, or named one we do not have.
  const target =
    named ??
    (
      await vscode.window.showQuickPick(
        targets.map((t) => ({ label: t.label, detail: t.detail, target: t })),
        { title: "Install Chapter Review skill", placeHolder: "Where should the skill go?" }
      )
    )?.target;
  if (!target) {
    return;
  }

  const existing = await readSkillStamp(vscode.Uri.joinPath(target.dir, "SKILL.md"));
  if (existing && existing.contentHash === bundled?.contentHash) {
    const choice = await vscode.window.showInformationMessage(
      `The Chapter Review skill at ${target.detail} already matches this extension.`,
      "Reinstall"
    );
    if (choice !== "Reinstall") {
      return;
    }
  }
  await writeSkill(host, target);
}

/**
 * On activation, notify only opted-in users of an available update: an installed
 * copy exists and does not match this bundle. Shown once per bundle so it doesn't
 * re-fire in every git repo, keyed by content hash, so a skill edited between
 * releases still announces itself exactly once.
 *
 * A missing skill is deliberately NOT announced here. The extension activates
 * in every git repo, so an unsolicited "install?" toast would nag across
 * unrelated projects. Installation is offered where the user actually engages
 * with the feature: the empty Chapters view's welcome link and the
 * "Install or Update Skill" command.
 */
export async function checkSkill(context: vscode.ExtensionContext): Promise<void> {
  const bundledHash = (
    await readSkillStamp(vscode.Uri.joinPath(bundledSkillDir(context), "SKILL.md"))
  )?.contentHash;
  if (!bundledHash) {
    return; // no bundled skill (e.g. dev build without bundling); nothing to offer
  }

  const installed = await Promise.all(
    installTargets().map(async (target) => ({
      target,
      stamp: await readSkillStamp(vscode.Uri.joinPath(target.dir, "SKILL.md")),
    }))
  );
  if (installed.some(({ stamp }) => stamp?.contentHash === bundledHash)) {
    return; // a matching copy exists somewhere; leave the user alone
  }
  const outdated = installed.find(({ stamp }) => stamp)?.target;
  if (!outdated) {
    return; // skill absent everywhere: handled by the view, not a popup
  }
  if (context.globalState.get<string>(NOTIFIED_UPDATE_KEY) === bundledHash) {
    return; // already announced this bundle's update
  }

  await context.globalState.update(NOTIFIED_UPDATE_KEY, bundledHash);
  const choice = await vscode.window.showInformationMessage(
    `The Chapter Review skill at ${outdated.detail} differs from the copy this extension carries.`,
    "Update",
    "Not now"
  );
  if (choice === "Update") {
    await installSkill(context, outdated.scope);
  }
}
