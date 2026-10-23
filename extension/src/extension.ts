import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { clearReviewState, confirmClear, hasReviewState } from "./clear";
import { DiffViewer } from "./diffViewer";
import { FocusStore, focusForNode, resolveFocus } from "./focus";
import {
  GIT_SCHEME,
  GitContentProvider,
  PATCHED_SCHEME,
  PatchedContentProvider,
  resolveGitDir,
  reviewUriPath,
} from "./gitContent";
import { aborted, Coalescer } from "./coalesce";
import { computeDigests, DigestCache } from "./fingerprint";
import { releasePins } from "./git";
import { isOpen, Manifest, OutdatedManifestError, parseManifest, ReviewedUnit } from "./model";
import { ReviewProgress } from "./progress";
import { checkSkill, installSkill, refreshSkillContext } from "./skillInstaller";
import { checkStaleness } from "./staleness";
import { errorMessage } from "./util";
import { ChapterTreeProvider, FileNode, HunkNode, IssueNode, Node, RoundView, ViewMode } from "./tree";

// Relative to the repo's git dir: tool state lives inside .git, invisible to
// git status and impossible to commit by accident.
const PROTOCOL_DIR = "chapter-review";
const MANIFEST_PATH = `${PROTOCOL_DIR}/chapters.json`;
// Review checkmarks live in their own document, written only here. The manifest
// belongs to the agent's CLI; when both wrote chapters.json, each side's
// whole-file read-modify-write could silently drop the other's edit.
const PROGRESS_PATH = `${PROTOCOL_DIR}/progress.json`;
const VIEW_MODE_KEY = "chapterReview.viewMode";
// Gates the destructive Clear Review entry in the view's menu.
const HAS_MANIFEST_KEY = "chapterReview.hasManifest";
// Holds back the "No chapter manifest found" welcome until the first load has
// settled, so an empty tree that is still loading does not claim there is none.
const READY_KEY = "chapterReview.ready";
const VIEW_ID = "chapterReview";
const SPIN_DELAY_MS = 250;

// Fingerprint of manifest bytes, so the extension can recognize its own writes.
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A round as the host holds it: what the tree reads, and where its ticks go. */
interface HostRound extends RoundView {
  progress: ReviewProgress;
  progressUri: vscode.Uri;
}

/** progress.json as the extension expects to find it. */
function hasReviewedArray(doc: unknown): doc is { reviewed: ReviewedUnit[] } {
  return (
    typeof doc === "object" &&
    doc !== null &&
    "reviewed" in doc &&
    Array.isArray(doc.reviewed)
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The skill installer needs neither a git repo nor a manifest, so register
  // it first and let the rest bail out early on non-git workspaces.
  context.subscriptions.push(
    vscode.commands.registerCommand("chapterReview.installSkill", () => installSkill(context)),
    vscode.commands.registerCommand("chapterReview.updateSkill", () => installSkill(context))
  );
  void checkSkill(context);
  void refreshSkillContext(context);

  const ready = (): void => void vscode.commands.executeCommand("setContext", READY_KEY, true);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    ready();
    return;
  }
  const folderUri = folder.uri;
  const gitDir = await resolveGitDir(folderUri.fsPath);
  if (!gitDir) {
    ready();
    return; // not a git repo; the view keeps its welcome content
  }
  const gitDirUri = vscode.Uri.file(gitDir);
  const protocolUri = vscode.Uri.joinPath(gitDirUri, PROTOCOL_DIR);
  const manifestUri = vscode.Uri.joinPath(gitDirUri, MANIFEST_PATH);
  const progressUri = vscode.Uri.joinPath(gitDirUri, PROGRESS_PATH);
  // Earlier rounds, kept by the CLI under rounds/<n>/.
  const roundUri = (round: number, file: string): vscode.Uri =>
    vscode.Uri.joinPath(protocolUri, "rounds", String(round), file);

  // Hash of the last content we wrote, so the watcher can skip our own writes.
  // A container because the manifest's is reassigned from the closures below;
  // checkmarks are keyed by the document's URI, one per round.
  const lastWritten: { manifest?: string; progress: Map<string, string> } = { progress: new Map() };

  const focus = new FocusStore(gitDirUri);
  const patchedDocs = new PatchedContentProvider();

  const viewMode = context.workspaceState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  const provider = new ChapterTreeProvider(folderUri, viewMode);
  // The rounds as the host holds them: what the tree reads, plus where each
  // round's checkmarks are written. `outdated` marks a current manifest left in
  // an older format, which the view names instead of raising an error.
  const state: { rounds: HostRound[]; outdated: boolean } = { rounds: [], outdated: false };
  const roundOf = (n: number | undefined): HostRound | undefined =>
    state.rounds.find((r) => r.manifest.round === n);
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    // Containers (chapter/folder) and issues carry checkboxes backed by two
    // separate stores, so we drive parent/child state ourselves rather than
    // letting VS Code cascade a chapter tick into resolving its issues.
    manageCheckboxStateManually: true,
  });

  const diffViewer = new DiffViewer(folderUri, patchedDocs, (n) => provider.roundView(n)?.manifest);

  function updateSummary(): void {
    const m = provider.manifest;
    // Set here because this is the one function every manifest transition ends
    // in, so the key cannot drift from what the view is showing.
    void vscode.commands.executeCommand("setContext", HAS_MANIFEST_KEY, m !== undefined);
    if (!m) {
      view.description = undefined;
      view.message = state.outdated
        ? "The review here was written by an older Chapter Review and is ignored. The next write replaces it."
        : undefined;
      return;
    }
    const { done, total } = provider.progressSummary();
    view.description =
      done === undefined ? `checking ${total} units…` : `${done} of ${total} reviewed`;
    view.message = m.summary ? `${m.head}: ${m.summary}` : m.head;
  }

  // Fingerprints the reviewed content of each unit so checkmarks track content,
  // not hunk coordinates: a regenerated chapter drops the check on units whose
  // content moved. Digests are a pure function of a round's pinned commits and
  // units, so the cache recomputes them only when those change.
  const digestCache = new DigestCache((m) => computeDigests(folderUri.fsPath, m));
  const reloads = new Coalescer(loadRounds);
  const reload = (): Promise<void> => {
    const settled = reloads.request();
    void vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => settled);
    return settled;
  };

  /**
   * Paints the rounds as soon as their manifests are read, then each round's
   * checkmarks once its digests are in. After every await a newer reload may
   * have superseded this one, which then stops without publishing anything.
   */
  async function loadRounds(signal: AbortSignal): Promise<void> {
    state.outdated = false;
    const current = await readManifest(manifestUri, true);
    const earlier: Manifest[] = [];
    for (const n of current ? Array.from({ length: current.round - 1 }, (_, i) => i + 1) : []) {
      const m = await readManifest(roundUri(n, "chapters.json"), false);
      if (m) earlier.push(m);
    }
    const rounds = await Promise.all(
      [...earlier, ...(current ? [current] : [])].map(async (manifest): Promise<HostRound> => {
        const uri = manifest === current ? progressUri : roundUri(manifest.round, "progress.json");
        const progress = new ReviewProgress();
        progress.load(await readProgressUnits(uri));
        return { manifest, progress, digests: digestCache.known(manifest), progressUri: uri };
      })
    );
    if (signal.aborted) {
      return;
    }
    state.rounds = rounds;
    provider.rounds = rounds;
    await refreshStaleness();

    const slow = setTimeout(() => {
      provider.showLoading = true;
      provider.refresh();
    }, SPIN_DELAY_MS);
    const filled = await Promise.all(
      rounds.map(async (round) => {
        const digests = await Promise.race([digestCache.digestsFor(round.manifest), aborted(signal)]);
        if (!digests) {
          return false;
        }
        round.digests = digests;
        // Persisted when it moved something: the next tick serializes only the
        // units this manifest declares, which would drop the adopted marks again.
        if (round.progress.adoptWholeFileMarks(digests)) {
          await writeProgress(round);
        }
        provider.refresh();
        updateSummary();
        return true;
      })
    ).finally(() => { clearTimeout(slow); });
    // A superseded load leaves spinners already showing to the load that
    // replaced it, rather than blinking them off in between.
    if (filled.every(Boolean)) {
      provider.showLoading = false;
    }
  }

  /** A manifest, or undefined when it is absent or unreadable; only the current one's errors are shown. */
  async function readManifest(uri: vscode.Uri, report: boolean): Promise<Manifest | undefined> {
    try {
      return parseManifest(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
    } catch (e) {
      if (report && e instanceof OutdatedManifestError) {
        state.outdated = true;
      } else if (report && !(e instanceof vscode.FileSystemError)) {
        void vscode.window.showErrorMessage(`Chapter Review: ${errorMessage(e)}`);
      }
      return undefined;
    }
  }

  /** Checkmarks from a progress document; undefined when it is absent or unreadable. */
  async function readProgressUnits(uri: vscode.Uri): Promise<ReviewedUnit[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const doc: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return hasReviewedArray(doc) ? doc.reviewed : undefined;
    } catch {
      return undefined;
    }
  }

  // Write the manifest, remembering its hash so the watcher skips this write.
  async function persistManifest(m: Manifest): Promise<void> {
    const buf = Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8");
    lastWritten.manifest = sha(buf);
    await vscode.workspace.fs.writeFile(manifestUri, buf);
  }

  /**
   * Persist a round's checked set to its progress document.
   *
   * Written via a temp file and rename: the CLI reads this document, and an
   * in-place write can hand it a truncated file.
   */
  async function writeProgress(round: HostRound): Promise<void> {
    const doc = { version: 1, reviewed: round.progress.toReviewedUnits(round.manifest) };
    const buf = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
    lastWritten.progress.set(round.progressUri.toString(), sha(buf));
    const tmp = vscode.Uri.joinPath(round.progressUri, `../progress.json.${process.pid}.tmp`);
    await vscode.workspace.fs.writeFile(tmp, buf);
    await vscode.workspace.fs.rename(tmp, round.progressUri, { overwrite: true });
  }

  /** Persist the rounds whose checkmarks changed, then repaint from memory. */
  async function persistProgress(rounds: HostRound[]): Promise<void> {
    for (const round of rounds) {
      await writeProgress(round);
    }
    provider.refresh();
    updateSummary();
  }

  // Re-checks whether the manifest's pinned commit still matches the branch and
  // repaints. Cheap (a couple of git calls), so the HEAD watcher and the
  // window-focus net can call it directly without re-reading the manifest.
  async function refreshStaleness(): Promise<void> {
    provider.staleness = provider.manifest
      ? await checkStaleness(folderUri.fsPath, provider.manifest)
      : undefined;
    provider.refresh();
    updateSummary();
  }

  function setViewMode(mode: ViewMode): void {
    provider.viewMode = mode;
    void context.workspaceState.update(VIEW_MODE_KEY, mode);
    void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, mode);
    provider.refresh();
  }

  // The resource behind the active editor: the modified side of a diff, or a
  // plain editor's document. Used to recover the real file from a diff view.
  function activeReviewUri(): vscode.Uri | undefined {
    // The tab input is `unknown` by design: its shape depends on the editor kind
    // (diff, text, notebook, custom). Read the two fields that interest us if
    // they are there, rather than claiming a shape this tab may not have.
    const { input } = vscode.window.tabGroups.activeTabGroup.activeTab ?? {};
    if (typeof input !== "object" || input === null) {
      return undefined;
    }
    const fields = new Map<string, unknown>(Object.entries(input));
    const uriField = (key: string): vscode.Uri | undefined => {
      const v = fields.get(key);
      return v instanceof vscode.Uri ? v : undefined;
    };
    return uriField("modified") ?? uriField("uri");
  }

  // Opens the real working-tree file behind a diff side, at the current line.
  async function openFile(arg?: vscode.Uri): Promise<void> {
    const uri = arg && reviewUriPath(arg) ? arg : activeReviewUri();
    const rel = uri && reviewUriPath(uri);
    if (!rel) {
      return;
    }
    const selection = vscode.window.activeTextEditor?.selection;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderUri, rel));
      await vscode.window.showTextDocument(doc, selection ? { selection } : {});
    } catch {
      void vscode.window.showWarningMessage(`Chapter Review: could not open ${rel}`);
    }
  }

  // Records what the reviewer is looking at. Async because resolving the anchor's
  // line reads the file, which focusForNode cannot do.
  async function writeFocus(node: Node): Promise<void> {
    const anchor = focusForNode(node);
    if (anchor) {
      const m = anchor.round === undefined ? provider.manifest : provider.roundView(anchor.round)?.manifest;
      await focus.write(await resolveFocus(folderUri.fsPath, m, anchor));
    }
  }

  // Opening an issue both shows its diff and records it as the current focus.
  async function openIssue(node: IssueNode): Promise<void> {
    await diffViewer.openIssue(node);
    await writeFocus(node);
  }

  // Applies the checked/unchecked state of issue checkboxes to the manifest in
  // a single write. Issue state lives in chapters.json (the skill reads it
  // back), separate from the per-user review-progress store used by files.
  async function setIssuesResolved(updates: { id: string; resolved: boolean }[]): Promise<void> {
    const m = provider.manifest;
    if (!m?.issues) {
      return;
    }
    const changed = updates.filter(({ id, resolved }) => {
      const issue = m.issues?.find((i) => i.id === id);
      if (!issue || !isOpen(issue) === resolved) {
        return false;
      }
      issue.status = resolved ? "resolved" : "open";
      return true;
    });
    if (changed.length === 0) {
      return;
    }
    try {
      await persistManifest(m);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Chapter Review: could not update the issue: ${errorMessage(e)}`
      );
      return;
    }
  }

  // Throws the whole review away: the partition, the findings, the checkmarks
  // and the focus pointer. Confirmed with a modal because a click in the view's
  // menu is easier to misfire than a typed command, and nothing here is
  // recoverable afterwards (see clear.ts).
  async function clearReview(): Promise<void> {
    if (!(await hasReviewState(protocolUri))) {
      void vscode.window.showInformationMessage(
        "Chapter Review: this repository has no review state to clear."
      );
      return;
    }
    if (!(await confirmClear(provider.manifest))) {
      return;
    }
    try {
      await clearReviewState(protocolUri);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Chapter Review: could not clear the review state: ${errorMessage(e)}`
      );
      return;
    }
    await releasePins(folderUri.fsPath);
    // Repainted from here rather than through the watcher: a file removed along
    // with its parent directory does not reliably raise onDidDelete.
    await reload();
  }

  context.subscriptions.push(
    view,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_SCHEME,
      new GitContentProvider(folderUri.fsPath)
    ),
    vscode.workspace.registerTextDocumentContentProvider(PATCHED_SCHEME, patchedDocs),
    view.onDidChangeCheckboxState(async (e) => {
      const issueUpdates: { id: string; resolved: boolean }[] = [];
      // A tick lands in the round its node belongs to; each round touched is
      // written once.
      const ticked = new Set<HostRound>();
      for (const [node, checkState] of e.items) {
        const checked = checkState === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === "issue") {
          issueUpdates.push({ id: node.issue.id, resolved: checked });
          continue;
        }
        // A row painted before its round's digests arrived has no digest to tick
        // against, and setReviewed would record the tick as an untick.
        const round = roundOf(provider.roundOf(node));
        if (round?.digests) {
          round.progress.setReviewed(provider.reviewUnitsFor(node), checked);
          ticked.add(round);
        }
      }
      if (issueUpdates.length > 0) {
        await setIssuesResolved(issueUpdates);
      }
      // persistProgress repaints; if only issues changed, repaint here instead.
      if (ticked.size > 0) {
        await persistProgress([...ticked]);
      } else {
        provider.refresh();
        updateSummary();
      }
    }),
    view.onDidChangeSelection(async (e) => {
      const node = e.selection[0] as Node | undefined;
      if (node) {
        await writeFocus(node);
      }
    }),
    vscode.commands.registerCommand("chapterReview.refresh", reload),
    vscode.commands.registerCommand("chapterReview.viewAsTree", () => { setViewMode("tree"); }),
    vscode.commands.registerCommand("chapterReview.viewAsList", () => { setViewMode("list"); }),
    vscode.commands.registerCommand("chapterReview.openDiff", (node: FileNode | HunkNode) =>
      diffViewer.openDiff(node)
    ),
    vscode.commands.registerCommand("chapterReview.openBranchDiff", (node: FileNode) =>
      diffViewer.openBranchDiff(node)
    ),
    vscode.commands.registerCommand("chapterReview.openFile", openFile),
    vscode.commands.registerCommand("chapterReview.openIssue", openIssue),
    vscode.commands.registerCommand("chapterReview.resetProgress", async () => {
      for (const round of state.rounds) {
        round.progress.clear();
      }
      await persistProgress(state.rounds);
    }),
    vscode.commands.registerCommand("chapterReview.clearReview", clearReview)
  );

  // Skip reloads caused by our own writes; a CLI write differs and still reloads.
  // An earlier round's manifest is the CLI's alone, so any change to one reloads.
  async function onManifestWritten(uri: vscode.Uri): Promise<void> {
    if (uri.toString() === manifestUri.toString()) {
      try {
        const bytes = await vscode.workspace.fs.readFile(manifestUri);
        if (sha(bytes) === lastWritten.manifest) {
          return;
        }
      } catch {
        // Fall through: reload() handles a missing or unreadable manifest.
      }
    }
    await reload();
  }

  // Base the watcher on the git dir, which may sit outside the workspace
  // folder (worktrees); RelativePattern with a Uri base handles that.
  // Checkmarks are written by this extension and by `chapter-review uncheck`,
  // so an external change has to repaint them. Cheaper than the manifest path:
  // only that round's checked set changed, so no reload or digest work.
  async function onProgressWritten(uri: vscode.Uri): Promise<void> {
    const round = state.rounds.find((r) => r.progressUri.toString() === uri.toString());
    if (!round) {
      return; // a round not loaded yet; the manifest watcher reloads it whole
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (sha(Buffer.from(bytes)) === lastWritten.progress.get(uri.toString())) {
        return; // our own write
      }
    } catch {
      /* deleted: fall through and repaint as empty */
    }
    round.progress.load(await readProgressUnits(uri));
    provider.refresh();
    updateSummary();
  }

  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, `${PROTOCOL_DIR}/{progress.json,rounds/*/progress.json}`)
  );
  progressWatcher.onDidCreate((uri) => void onProgressWritten(uri));
  progressWatcher.onDidChange((uri) => void onProgressWritten(uri));
  progressWatcher.onDidDelete((uri) => void onProgressWritten(uri));
  context.subscriptions.push(progressWatcher);

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, `${PROTOCOL_DIR}/{chapters.json,rounds/*/chapters.json}`)
  );
  watcher.onDidCreate((uri) => void onManifestWritten(uri));
  watcher.onDidChange((uri) => void onManifestWritten(uri));
  watcher.onDidDelete(() => void reload());
  context.subscriptions.push(watcher);

  // Live staleness: a commit, amend, rebase or checkout in the terminal moves
  // HEAD or the branch ref, both files under the git dir. Re-check on those,
  // and on window focus as a safety net for OSes where .git watches are flaky.
  const headWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirUri, "{HEAD,refs/heads/**,packed-refs}")
  );
  headWatcher.onDidCreate(refreshStaleness);
  headWatcher.onDidChange(refreshStaleness);
  headWatcher.onDidDelete(refreshStaleness);
  context.subscriptions.push(
    headWatcher,
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refreshStaleness();
      }
    })
  );

  void reload().finally(ready);
}

// Nothing to tear down: every disposable is registered on the extension
// context, which VSCode disposes for us.
export function deactivate(): void {
  /* no-op */
}
