import * as vscode from "vscode";

const PROGRESS_KEY = "chapterReview.reviewed";

/**
 * Tracks which review units (file/hunk keys from model.reviewKey) the user has
 * checked off. Backed by the extension's workspace Memento, so progress is
 * per-repo and survives reloads.
 */
export class ReviewProgress {
  private reviewed: Set<string>;

  constructor(private readonly state: vscode.Memento) {
    this.reviewed = new Set(state.get<string[]>(PROGRESS_KEY, []));
  }

  isReviewed(key: string): boolean {
    return this.reviewed.has(key);
  }

  setReviewed(keys: string[], reviewed: boolean): Thenable<void> {
    for (const key of keys) {
      reviewed ? this.reviewed.add(key) : this.reviewed.delete(key);
    }
    return this.state.update(PROGRESS_KEY, [...this.reviewed]);
  }

  clear(): Thenable<void> {
    this.reviewed.clear();
    return this.state.update(PROGRESS_KEY, []);
  }
}
