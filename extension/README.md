# chapter-review (VSCode extension)

Renders the chapter manifest at `<git-dir>/chapter-review/chapters.json` (produced by the `chapter-review` Claude Code skill; lives inside `.git` so the worktree stays clean) as a reviewable tree in the SCM side panel.

## Features

- "Chapters" view in the SCM panel: chapters → files → hunks, with an Unassigned bucket at the end.
- Tree/list toggle for the files inside a chapter, mirroring the native git views.
- Click a file or hunk → chapter-scoped diff editor: the right side is a virtual document (merge base plus only that chapter's hunks, reconstructed from `headSha`), so each chapter shows exactly its own changes even when other chapters touch the same file. Content is served via `git show`, no dependency on the git extension. The cursor lands on the hunk's first changed line.
- Review progress via native checkboxes on files and hunks. Persisted in workspace state, keyed by hunk coordinates (not chapter ids), so progress survives manifest regeneration for unchanged hunks. Per-chapter counts plus an overall "N of M reviewed" on the view.
- Watches the manifest (git dir resolved via `git rev-parse --absolute-git-dir`, so worktrees work); regeneration by the skill auto-refreshes the tree.

## Developing / testing

No test harness. Two F5 targets:

**C# demo (the realistic one).** `npm run demo` at the repo root builds `demo/`, a throwaway git repo from `demo-fixtures/{before,after}`: an order service branch that swaps email notifications for a queue, renames a helper, updates tests, and bumps xunit. Generating the manifest is the chapter-review skill's job — run the skill against `demo/` (that is the skill's end-to-end test). `npm run demo -- --manifest` writes a scripted reference manifest instead. Then launch "Run Extension (C# demo)" and open the Source Control side bar → "Chapters" view. Rerun `npm run demo` anytime for a fresh state; review progress survives because it is keyed by hunk coordinates.

**Self-hosting fixture.** "Run Extension" opens this repo itself; its manifest (in this repo's own `.git/chapter-review/`) describes a real diff (initial commit → schema commit). It goes stale as the repo moves on (hunk line numbers reference old blobs); diffs still open, ranges may drift. Regenerate with the chapter-review skill anytime.

Before either: `npm install && npm run compile` in `extension/` once (the launch configs compile automatically afterwards).

## Not done yet

- No staleness warning when the branch has moved past `headSha` (scoped diffs stay correct because they reconstruct from `headSha`, but they then show the chapter as of generation time, not the latest commits).
- Manifests without `headSha` fall back to the `head` ref, which drifts.
- Multi-root workspaces: only the first folder is considered.
