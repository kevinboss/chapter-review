# chapter-review

Tooling to review a git branch as a series of logical *chapters* instead of one undifferentiated diff.

Pieces:

- **`.claude/skills/chapter-review/`** — the Claude Code skill and its self-contained contract. Partitions the current branch's diff into chapters and writes the manifest to `<git-dir>/chapter-review/chapters.json` in the target repo (inside `.git`, so the worktree and git status stay clean). The folder bundles everything it needs: `SKILL.md`, `chapters.schema.json` (draft-07 contract), `validate.mjs` (zero-dependency validator, authoritative), and `example-chapters.json` (worked example). Copy the folder into any repo's `.claude/skills/` to install; only `git` and `node` are required.
- **`.claude/skills/demo/`** — `/demo` skill: rebuild the C# demo, generate its manifest via the chapter-review skill in a sub-agent, launch the extension dev host.
- **`scripts/`** — `test.mjs` regression-tests the validator; `make-demo.mjs` builds the demo repo. Run tests with `npm test` (no dependencies).
- **`extension/`** — VSCode extension that renders `chapters.json` as a tree (list + tree views), opens diffs on click in the same style as the native git history, and tracks review progress per hunk.

Q&A about the branch still happens in the coding-agent terminal — the extension is purely a review surface.

## Design decisions so far

- **Partition, not overlap.** Every hunk lives in exactly one chapter, or in `unassigned`. Enables a meaningful "12 of 47 hunks reviewed" progress counter and avoids "shown twice" weirdness in the tree.
- **Merge-base, not base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters reflect "what this branch added", not "main vs me".
- **Quarantine over force-classify.** Lockfiles, snapshots, autoformat-only hunks go in `unassigned` with a `reason`. Don't pretend "Misc cleanup" is a real chapter.
- **No commit-splitting.** This tooling only *describes* the diff. Rewriting history into one-commit-per-chapter is a separate, much riskier tool.

## Installing

- **Extension:** download `chapter-review-<version>.vsix` from [Releases](https://github.com/kevinboss/chapter-review/releases) and run "Extensions: Install from VSIX…" in VSCode (or `code --install-extension <file>.vsix`).
- **Skill:** copy `.claude/skills/chapter-review/` into your repo's `.claude/skills/` (or download `chapter-review-skill.zip` from the same release and unzip it there). Needs only `git` and `node`.

## Developing

Run `npm install && npm run compile` in `extension/` once, then F5. Two launch targets:

- **Run Extension (C# demo)** — run `npm run demo` first to build `demo/`, a throwaway git repo from `demo-fixtures/{before,after}` (an order-service branch: swaps email for a queue, renames a helper, updates tests, bumps xunit). Generating its manifest is the skill's job: run the chapter-review skill against `demo/` (the skill's end-to-end test), or `npm run demo -- --manifest` for the scripted reference. Then open the Source Control side bar → Chapters.
- **Run Extension** — opens this repo itself against its own committed fixture manifest.

`npm test` runs the validator regression tests plus a standalone-portability check (no dependencies).

## Status

Skill portable and self-contained. Extension packaged as a `.vsix` via `vsce`. CI runs the validator tests, a standalone-portability check, and the extension build on push/PR; tagging `vX.Y.Z` (see the `/release` skill) publishes the `.vsix` and skill bundle to a GitHub Release.
