<p align="center">
  <img src="extension/media/icon.png" width="120" alt="Chapter Review logo">
</p>

<h1 align="center">Chapter Review</h1>

<p align="center">
  Review a git branch as a series of logical <em>chapters</em> instead of one undifferentiated diff.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <a href="https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review"><img src="https://vsmarketplacebadges.dev/version-short/kevinboss.chapter-review.svg" alt="VS Marketplace"></a>
  <a href="https://github.com/kevinboss/chapter-review/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/kevinboss/chapter-review/ci.yml?label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kevinboss/chapter-review" alt="License"></a>
  <a href="https://github.com/kevinboss/heartbeat"><img src="https://raw.githubusercontent.com/kevinboss/heartbeat/main/badges/kevinboss_chapter-review.svg" alt="Heartbeat"></a>
</p>

> This project is being developed using AI development tools. However, every line of code is reviewed and approved by a human before being committed.

Chapter Review splits a git branch's flat diff into logical chapters so you can
read one topic at a time and track review progress. A Claude Code skill
partitions the diff and writes a manifest inside `.git`, leaving your working
tree clean. A VS Code extension shows that manifest as a tree with
chapter-scoped diffs, per-hunk checkmarks, and findings from the agent.

Install the extension from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review)
or from a terminal:

```bash
code --install-extension kevinboss.chapter-review
```

Then run `Chapter Review: Install Skill` from the VS Code Command Palette and
restart Claude Code (requires `git` and Node.js 22.18 or newer on `PATH`). See
[docs/installation.md](docs/installation.md) for `.vsix` packages, manual skill
setup, and pre-release builds.

To review a branch, open the repository in VS Code and ask Claude Code to run
the `chapter-review` skill on the current branch. Open the Chapters view from
the activity bar, expand a chapter, and select a file or hunk to inspect its
chapter-scoped diff. Tick checkboxes as you review. See
[docs/extension.md](docs/extension.md) for the extension reference and
[docs/design.md](docs/design.md) for how partitioning works.

## How to contribute

Make your changes on a branch, make sure all checks pass, and open a pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, build and
test commands, and the release workflow.
