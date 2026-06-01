# chapter-review (VSCode extension)

Renders `.claude/chapters.json` (produced by the `chapter-review` Claude Code skill) as a reviewable tree in the SCM side panel.

## Planned features

- Tree view + list view toggle, mirroring the native git history UI.
- Click a file → opens a diff editor (`vscode.diff`) scoped to that chapter's hunks.
- Per-hunk review progress: "12 of 47 hunks reviewed", persisted in workspace state.
- Watches `.claude/chapters.json` for changes (regeneration by the skill auto-refreshes the tree).

## Status

Not scaffolded yet. The contract this consumes is sketched in [`../example-chapters.json`](../example-chapters.json).
