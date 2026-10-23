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
chapter-review groups those hunks into chapters (a new feature here, a rename there) so you can read the branch one topic at a time and track how much of it you have covered.
A Claude Code skill partitions the diff and writes a manifest.
A VSCode extension shows that manifest as a tree, with a diff per chapter and a checkmark per hunk.
Findings the agent records while you read sit in the tree inside the chapter they concern, pinned to a whole file or to the lines they are about.
When the author pushes again, the next review round holds only what changed since the last one, and earlier rounds stay open as drawers of their own.
Open findings carry over into the new round and move with the code they point at.

Questions about the branch still go to the coding agent in its terminal.
The extension only shows the review.

## Installing

1. **Install the extension.** Get **Chapter Review** from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review), or download `chapter-review-<version>.vsix` from [Releases](https://github.com/kevinboss/chapter-review/releases) and run "Extensions: Install from VSIX…" in VSCode (or `code --install-extension <file>.vsix`).
2. **Install the skill.** The extension bundles it. Run **Chapter Review: Install Skill** from the Command Palette (or click **Install the skill** in the empty Chapters view) and pick a location: `~/.claude/skills/` for every repo, or the current workspace only. The same step registers the skill's MCP server with Claude Code (`claude mcp add`, at user scope or at local scope for a workspace install), so the agent can call the commands as typed tools. If the `claude` command isn't on PATH, the skill still installs and the notification offers the command to copy. Restart your coding agent so it loads the skill. Whenever your copy differs from the one the extension carries, the extension asks you to update it.

Installing the skill by hand instead: copy `.claude/skills/chapter-review/` into your repo's `.claude/skills/`, or unzip `chapter-review-skill.zip` from a release there. It needs `git` and `node` 22.18 or newer.

### Pre-releases

Every push to `main` publishes a pre-release build to the Marketplace. To ride it, open the extension's Marketplace page in VSCode and use **Switch to Pre-Release Version**. Switch back with **Switch to Release Version**.

## Repository layout

- **`.claude/skills/chapter-review/`** — the Claude Code skill and the manifest format it writes. Partitions the current branch's diff into chapters and writes the manifest to `<git-dir>/chapter-review/chapters.json` in the target repo (inside `.git`, so the worktree and git status stay clean). The folder bundles everything it needs: `SKILL.md`, the `chapter-review` CLI (TypeScript, no build step), `mcp.ts` (the same commands as an MCP server, zero dependencies), `chapters.schema.json` (draft-07 contract), `validate.ts` (zero-dependency validator, which wins where it and the schema differ), and `example-chapters.json` (worked example).
- **`.claude/skills/demo/`** — `/demo` skill: rebuild the C# demo and have a sub-agent generate its manifest with the chapter-review skill, then launch the extension dev host on it.
- **`.claude/skills/release/`** — `/release` skill: bump the version and push a tag, so the Release workflow publishes the `.vsix` and the skill bundle.
- **`scripts/`** — `make-demo.ts` builds the demo repo, and `publish-version.ts` refuses a version a publishing lane must not ship.
- **Tooling** — `eslint.config.ts` (flat config, typescript-eslint strict-type-checked with typed linting) plus four `tsconfig.json` projects covering the skill CLI, the extension, the extension's build scripts, and the root scripts/tests. `npm run lint` and `npm run typecheck` gate both in CI. These are dev-only: the skill folder still runs with no install.
- **`test/`** — `node:test` suites: `validate.test.ts` covers the validator, `write`, `issues`, `line`, `outside`, `rounds` and `progress` drive the CLI end-to-end against throwaway git repos, `mcp.test.ts` drives the MCP server the same way, and `publish-version.test.ts` covers the version guard both publishing lanes run. Run with `npm test`.
- **`extension/`** — VSCode extension that shows `chapters.json` as a tree or a list and tracks review progress per hunk. A click opens the diff in the same style as the native git history.

## Design decisions

- **Every hunk in one place.** Each hunk lives in exactly one chapter, or in `unassigned`. A counter like "12 of 47 hunks reviewed" then adds up, and no hunk appears twice in the tree.
- **Diffed from the merge base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters show what this branch added and leave out whatever main gained since. Once the branch moves, the next review round partitions only what changed since the last one, and earlier rounds stay readable with their checkmarks.
- **Noise goes to quarantine.** Lockfiles and other generated or autoformat-only hunks go in `unassigned` with a `reason`, instead of under a made-up "Misc cleanup" chapter.
- **No commit-splitting.** This tooling only describes the diff. Rewriting history into one commit per chapter would be a separate and much riskier tool.

## Developing

Run `npm install && npm run compile` in `extension/` once, then F5. Two launch targets:

- **Run Extension (C# demo)** — run `npm run demo` first to build `demo/`, a throwaway git repo from `demo-fixtures/{before,after}` (an order-service branch: swaps email for a queue, renames a helper, updates tests, bumps xunit). Generating its manifest is the skill's job: run the chapter-review skill against `demo/` (the skill's end-to-end test), or `npm run demo -- --manifest` for the scripted reference. Then open the **Chapter Review** side bar → Chapters.
- **Run Extension** — opens this repo itself, showing whatever review its `.git/chapter-review/` holds.

`npm test` runs the suites in `test/`.

## Status

The skill runs from its own folder with nothing to install. The extension is packaged as a `.vsix` via `vsce`. On every push and PR, CI runs lint, the type-check, the tests and a check that the skill runs without `node_modules`, then builds and tests the extension. A push to `main` that passes both jobs publishes a pre-release to the Marketplace. Tagging `vX.Y.Z` (see the `/release` skill) publishes the `.vsix` and skill bundle to a GitHub Release and the extension to the Marketplace as a stable release. Both lanes run `scripts/publish-version.ts`. It refuses a version that is already published or out of lane, and one that is behind a version this repo has already tagged.

## License

MIT. See [LICENSE](LICENSE).
