# claude-chapter-review

Tooling to review a git branch as a series of logical *chapters* instead of one undifferentiated diff.

Pieces:

- **`.claude/skills/chapter-review/`** — the Claude Code skill and its self-contained contract. Partitions the current branch's diff into chapters and writes the manifest to `<git-dir>/chapter-review/chapters.json` in the target repo (inside `.git`, so the worktree and git status stay clean). The folder bundles everything it needs: `SKILL.md`, `chapters.schema.json` (draft-07 contract), `validate.mjs` (zero-dependency validator, authoritative), and `example-chapters.json` (worked example). Copy the folder into any repo's `.claude/skills/` to install; only `git` and `node` are required.
- **`.claude/skills/demo/`** — `/demo` skill: rebuild the C# demo, generate its manifest via the chapter-review skill in a sub-agent, launch the extension dev host.
- **`scripts/`** — `test.mjs` regression-tests the validator; `make-demo.mjs` builds the demo repo. Run tests with `npm test` (no dependencies).
- **`extension/`** — VSCode extension that renders `chapters.json` as a tree (list + tree views), opens diffs on click in the same style as the native git history, and tracks review progress per hunk.

Q&A about the branch still happens in the Claude Code terminal — the extension is purely a review surface.

## Design decisions so far

- **Partition, not overlap.** Every hunk lives in exactly one chapter, or in `unassigned`. Enables a meaningful "12 of 47 hunks reviewed" progress counter and avoids "shown twice" weirdness in the tree.
- **Merge-base, not base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters reflect "what this branch added", not "main vs me".
- **Quarantine over force-classify.** Lockfiles, snapshots, autoformat-only hunks go in `unassigned` with a `reason`. Don't pretend "Misc cleanup" is a real chapter.
- **No commit-splitting.** This tooling only *describes* the diff. Rewriting history into one-commit-per-chapter is a separate, much riskier tool.

## Status

Skill is portable and self-contained (zero dependencies, `npm test` green). Extension scaffolded and compiling. Two ways to try it: `npm run demo` then F5 "Run Extension (C# demo)" for a realistic C# branch review, or plain F5 against this repo's own fixture (see `extension/README.md`). Next: extension packaging and CI.
