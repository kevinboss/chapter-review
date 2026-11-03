import * as vscode from "vscode";
import type { Manifest } from "./model";

/**
 * Calls `refresh` on every save while a worktree review is installed. It counts
 * the files edited since its snapshot, and a save changes that count without
 * touching anything under the git dir, where the other watchers look.
 */
export function refreshOnSave(
  manifest: () => Manifest | undefined,
  refresh: () => Promise<void>
): vscode.Disposable {
  return vscode.workspace.onDidSaveTextDocument(() => {
    if (manifest()?.mode === "worktree") {
      void refresh();
    }
  });
}
