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

Chapter Review renders a chapter manifest in its own side bar as a tree of
chapters, files, and hunks with chapter-scoped diffs and per-hunk checkmarks.
The companion `chapter-review` skill in Claude Code partitions the branch diff
and writes the manifest inside `.git`, keeping your working tree clean. This
extension displays the review; it does not generate the manifest itself.

<!--
TODO(screenshot): add a hero screenshot or GIF of the Chapter Review side bar.
Suggested capture: the Chapters view expanded (chapters -> files -> hunks) next
to an open chapter-scoped diff, with a couple of hunks ticked so the progress
counter shows. Save it under extension/media/ (e.g. media/screenshot.png) and
reference it as:
![Chapter Review](media/screenshot.png)
Marketplace renders repo-relative image paths from the packaged README.
-->

Install the extension from the Marketplace or from a terminal:

```bash
code --install-extension kevinboss.chapter-review
```

Then run `Chapter Review: Install Skill` from the Command Palette and restart
Claude Code (requires `git` and Node.js 22.18 or newer on `PATH`). See the
[installation docs](https://github.com/kevinboss/chapter-review/blob/main/docs/installation.md)
for manual setup and pre-release builds.

Open a git repository in VS Code and ask Claude Code to run the
`chapter-review` skill on the current branch. Open the Chapters view from the
activity bar, expand a chapter, and click a file or hunk to inspect its
chapter-scoped diff. Tick checkboxes as you review. See the
[extension reference](https://github.com/kevinboss/chapter-review/blob/main/docs/extension.md)
for every feature and known limitation.
