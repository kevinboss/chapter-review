# Chapter Review

Review a git branch as a series of logical *chapters* instead of one flat diff. This extension renders a chapter manifest as a reviewable tree in a dedicated **Chapter Review** side bar, with chapter-scoped diffs and per-hunk review progress.

The manifest is produced by the companion **chapter-review skill**, which you run in your coding agent (Claude Code today). The skill partitions the branch's diff into chapters and writes it to `<git-dir>/chapter-review/chapters.json` (inside `.git`, so your working tree stays clean). This extension is the review surface; it does not generate the manifest itself.

## Requirements

- A git repository open in VSCode, with `git` on your PATH.
- The chapter-review skill installed in your coding agent, to generate the manifest.

## Getting started

1. In your coding agent, run the chapter-review skill on the branch you want to review. It writes the chapter manifest.
2. Click the **Chapter Review** icon in the activity bar. The **Chapters** view lists the chapters; expand one to see its files and hunks.
3. Click a file or hunk to open its diff, scoped to that chapter. Tick the checkboxes as you review; progress is saved per hunk. Tick a chapter or folder to complete everything beneath it at once, and tick an issue to mark it resolved.

If the view says "No chapter manifest found", the skill hasn't generated one for this repo yet.

## Features

- **Chapters** view in its own activity-bar container: chapters → files → hunks, with an Unassigned bucket for quarantined noise (lockfiles, generated code, autoformat).
- Tree/list toggle for the files inside a chapter, mirroring the native git views.
- Chapter-scoped diffs: a file or hunk opens a diff showing only that chapter's changes, even when other chapters touch the same file. The cursor lands on the first changed line.
- Review progress via native checkboxes on files and hunks, keyed by hunk position so it survives manifest regeneration for unchanged hunks. Ticking a chapter, folder or the Unassigned root completes every file beneath it in one step. Per-chapter counts plus an overall "N of M reviewed".
- Issues carry the same checkbox: ticking one marks it resolved (written back to the manifest for the skill to read), so completing a finding works like completing a file.
- Auto-refreshes when the skill regenerates the manifest.
- Staleness detection: the view flags when the branch has moved past the commit the chapters were generated against, so you know to regenerate the manifest.

## Known limitations

- Staleness is detected at the branch level (the recorded head moved). It does not yet recompute which individual hunks changed, so a stale manifest is flagged rather than partially updated.
- A manifest generated without a pinned head commit falls back to the branch ref, which can drift.
- Multi-root workspaces: only the first folder is considered.
