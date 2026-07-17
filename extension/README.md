<p align="center">
  <img src="media/icon.png" width="120" alt="Chapter Review logo">
</p>

<h1 align="center">Chapter Review</h1>

<p align="center">
  Review a git branch as a series of logical <em>chapters</em> instead of one flat diff.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review"><img src="https://vsmarketplacebadges.dev/version-short/kevinboss.chapter-review.svg" alt="VS Code Marketplace version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

This extension renders a chapter manifest as a reviewable tree in a dedicated **Chapter Review** side bar, with chapter-scoped diffs and per-hunk review progress.

The manifest is produced by the companion **chapter-review skill**, which you run in your coding agent (Claude Code today). The skill partitions the branch's diff into chapters and writes it to `<git-dir>/chapter-review/chapters.json` (inside `.git`, so your working tree stays clean). This extension is the review surface; it does not generate the manifest itself.

<!--
TODO(screenshot): add a hero screenshot or GIF of the Chapter Review side bar here.
Suggested capture: the Chapters view expanded (chapters → files → hunks) next to an
open chapter-scoped diff, with a couple of hunks ticked so the progress counter shows.
Save it under extension/media/ (e.g. media/screenshot.png) and reference it as:
![Chapter Review](media/screenshot.png)
Marketplace renders repo-relative image paths from the packaged README.
-->

## Requirements

- A git repository open in VSCode, with `git` on your PATH.
- A coding agent that loads Claude Code skills (Claude Code today), to generate the manifest.

## Getting started

1. **Install the skill.** This extension ships the chapter-review skill inside it. Run **Chapter Review: Install Skill** from the Command Palette, or click **Install the skill** in the empty Chapters view, then choose where it goes: `~/.claude/skills/` for every repository, or just the current workspace. Restart your coding agent afterward so it loads the skill. The extension prompts you to update whenever it bundles a newer skill version.
2. In your coding agent, run the chapter-review skill on the branch you want to review. It writes the chapter manifest.
3. Click the **Chapter Review** icon in the activity bar. The **Chapters** view lists the chapters; expand one to see its files and hunks.
4. Click a file or hunk to open its diff, scoped to that chapter. Tick the checkboxes as you review; progress is saved per hunk. Tick a chapter or folder to complete everything beneath it at once, and tick an issue to mark it resolved.

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

## License

MIT. See [LICENSE](LICENSE).
