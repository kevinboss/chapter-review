import * as vscode from "vscode";
import { gitShow } from "./git";

export const GIT_SCHEME = "chapter-review-git";
export const PATCHED_SCHEME = "chapter-review-patched";

// The git queries themselves live in ./git, which imports no vscode API. Re-
// exported here so existing importers keep working.
export { resolveGitDir, gitShow, gitRevParse, gitMergeBase } from "./git";

/**
 * Serves file content at a fixed ref, so diffs against the merge base need no
 * coupling to the built-in git extension. URI form:
 * chapter-review-git:/<path>?<JSON {ref, path}> — an empty ref yields empty
 * content (the left side of an added file's diff).
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repoRoot: string) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = parseQuery(uri.query);
    if (!q) {
      return Promise.resolve("");
    }
    return gitShow(this.repoRoot, q.ref, q.path);
  }
}

/** The {ref, path} a review URI carries in its query, when it is well-formed. */
function parseQuery(query: string): { ref: string; path: string } | undefined {
  try {
    const q: unknown = JSON.parse(query);
    if (
      typeof q === "object" &&
      q !== null &&
      "ref" in q &&
      "path" in q &&
      typeof q.ref === "string" &&
      typeof q.path === "string"
    ) {
      return { ref: q.ref, path: q.path };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function gitUri(ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${path}`,
    query: JSON.stringify({ ref, path }),
  });
}

/**
 * The workspace-relative file path encoded in one of our review URIs (git or
 * patched), or undefined for anything else. Lets "Open File" recover the real
 * file behind a virtual diff side.
 */
export function reviewUriPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === GIT_SCHEME) {
    return parseQuery(uri.query)?.path;
  }
  if (uri.scheme === PATCHED_SCHEME) {
    // path is /<ownerId>/<relPath>; ownerId never contains a slash.
    return (/^[^/]+\/(.+)$/.exec(uri.path.replace(/^\/+/, "")))?.[1];
  }
  return undefined;
}

/**
 * Holds the chapter-scoped virtual documents built by the DiffViewer (merge-base
 * content plus only the chapter's hunks). Keyed by URI; re-opening a diff
 * overwrites the entry and fires a change so an open editor refreshes.
 */
export class PatchedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

export function patchedUri(ownerId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PATCHED_SCHEME, path: `/${ownerId}/${path}` });
}
