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

A large branch lands as a single flat diff: dozens of files and hundreds of hunks in no particular order.
chapter-review groups those hunks into chapters (a new feature here, a rename there) so you can read the branch as a narrative and track how much of it you have covered.
A Claude Code skill partitions the diff and writes a manifest; a VSCode extension renders that manifest as a reviewable tree with chapter-scoped diffs and per-hunk progress.

Q&A about the branch still happens in the coding-agent terminal.
The extension is purely a review surface.

## Installing

1. **Install the extension** — get **Chapter Review** from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review), or download `chapter-review-<version>.vsix` from [Releases](https://github.com/kevinboss/chapter-review/releases) and run "Extensions: Install from VSIX…" in VSCode (or `code --install-extension <file>.vsix`).
2. **Install the skill** — the extension bundles it. Run **Chapter Review: Install Skill** from the Command Palette (or click **Install the skill** in the empty Chapters view) and pick a location: `~/.claude/skills/` for every repo, or the current workspace only. Restart your coding agent so it loads the skill; the extension prompts you to update it when a newer version ships.

Installing the skill by hand instead: copy `.claude/skills/chapter-review/` into your repo's `.claude/skills/`, or unzip `chapter-review-skill.zip` from a release there. It needs only `git` and `node`.

## Repository layout

- **`.claude/skills/chapter-review/`** — the Claude Code skill and its self-contained contract. Partitions the current branch's diff into chapters and writes the manifest to `<git-dir>/chapter-review/chapters.json` in the target repo (inside `.git`, so the worktree and git status stay clean). The folder bundles everything it needs: `SKILL.md`, `chapters.schema.json` (draft-07 contract), `validate.mjs` (zero-dependency validator, authoritative), and `example-chapters.json` (worked example). Copy the folder into any repo's `.claude/skills/` to install; only `git` and `node` are required.
- **`.claude/skills/demo/`** — `/demo` skill: rebuild the C# demo, generate its manifest via the chapter-review skill in a sub-agent, launch the extension dev host.
- **`scripts/`** — `test.mjs` regression-tests the validator; `make-demo.mjs` builds the demo repo. Run tests with `npm test` (no dependencies).
- **`extension/`** — VSCode extension that renders `chapters.json` as a tree (list + tree views), opens diffs on click in the same style as the native git history, and tracks review progress per hunk.

## Design decisions

- **Partition, not overlap.** Every hunk lives in exactly one chapter, or in `unassigned`. This gives a meaningful "12 of 47 hunks reviewed" progress counter and keeps any hunk from appearing twice in the tree.
- **Merge-base, not base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters reflect "what this branch added", not "main vs me".
- **Quarantine over force-classify.** Lockfiles and other generated or autoformat-only hunks go in `unassigned` with a `reason`, rather than being filed under a fake "Misc cleanup" chapter.
- **No commit-splitting.** This tooling only *describes* the diff. Rewriting history into one-commit-per-chapter is a separate, much riskier tool.

## Developing

Run `npm install && npm run compile` in `extension/` once, then F5. Two launch targets:

- **Run Extension (C# demo)** — run `npm run demo` first to build `demo/`, a throwaway git repo from `demo-fixtures/{before,after}` (an order-service branch: swaps email for a queue, renames a helper, updates tests, bumps xunit). Generating its manifest is the skill's job: run the chapter-review skill against `demo/` (the skill's end-to-end test), or `npm run demo -- --manifest` for the scripted reference. Then open the **Chapter Review** side bar → Chapters.
- **Run Extension** — opens this repo itself against its own committed fixture manifest.

`npm test` runs the validator regression tests and the standalone-portability check (no dependencies).

## Status

Skill portable and self-contained. Extension packaged as a `.vsix` via `vsce`. CI runs the validator tests and the standalone-portability check, then builds the extension, on every push and PR. Tagging `vX.Y.Z` (see the `/release` skill) publishes the `.vsix` and skill bundle to a GitHub Release and the extension to the VSCode Marketplace.

## License

MIT. See [LICENSE](LICENSE).
