<h1 align="center">Chapter Review</h1>

<p align="center">
  Review a git branch as a series of logical <em>chapters</em> instead of one flat diff.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review"><img src="https://vsmarketplacebadges.dev/version-short/kevinboss.chapter-review.svg" alt="VS Code Marketplace version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

Chapter Review displays a git branch as grouped chapters in a dedicated side bar with chapter-scoped diffs and progress checkboxes.
The extension reads a manifest stored inside `.git` and does not generate the manifest itself.
The companion `chapter-review` skill in Claude Code partitions the branch diff and writes that manifest while leaving your working tree clean.
Running the skill requires `git` and Node.js 22.18 or newer on `PATH`.

<!--
TODO(screenshot): add a hero screenshot or GIF of the Chapter Review side bar.
Suggested capture: the Chapters view expanded (chapters -> files -> hunks) next
to an open chapter-scoped diff, with a couple of hunks ticked so the progress
counter shows. Save it under extension/media/ (e.g. media/screenshot.png) and
reference it as:
![Chapter Review](media/screenshot.png)
Marketplace renders repo-relative image paths from the packaged README.
-->

## Usage

1. **Install the companion skill.**
   Run `Chapter Review: Install Skill` from the Command Palette and choose `~/.claude/skills/` for every repository or the current workspace.
   Restart Claude Code to load the skill.
2. **Generate chapters for the branch.**
   Open a git repository in VS Code and ask Claude Code to run the `chapter-review` skill on the current branch.
   The Chapters view refreshes automatically when the skill writes or updates the manifest.
3. **Inspect chapter-scoped diffs.**
   Open the Chapters view from the activity bar and expand a chapter.
   Click any file or hunk to open a diff containing only that chapter's changes, even when other chapters touch the same file.
4. **Track your progress.**
   Tick checkboxes on files and hunks as you review them.
   The view shows per-chapter counts and preserves checkmarks for unchanged hunks when the manifest is regenerated.

## License

MIT. See [LICENSE](LICENSE).
