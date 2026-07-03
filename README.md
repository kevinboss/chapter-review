# claude-chapter-review

Tooling to review a git branch as a series of logical *chapters* instead of one undifferentiated diff.

Pieces:

- **`schema/`** — the contract: a draft-07 JSON Schema for `chapters.json`. [`example-chapters.json`](./example-chapters.json) is a worked example.
- **`scripts/`** — `validate.mjs` checks a manifest against the schema plus the partition rules (no hunk claimed twice, no overlaps, no double whole-file claims). `test.mjs` regression-tests the validator. Run both with `npm test`.
- **`skill/`** — Claude Code skill that partitions the current branch's diff into chapters and writes `.claude/chapters.json` in the target repo, using `validate.mjs` as its pre-write check.
- **`extension/`** — VSCode extension that renders `chapters.json` as a tree (list + tree views), opens diffs on click in the same style as the native git history, and tracks review progress per hunk.

Q&A about the branch still happens in the Claude Code terminal — the extension is purely a review surface.

## Design decisions so far

- **Partition, not overlap.** Every hunk lives in exactly one chapter, or in `unassigned`. Enables a meaningful "12 of 47 hunks reviewed" progress counter and avoids "shown twice" weirdness in the tree.
- **Merge-base, not base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters reflect "what this branch added", not "main vs me".
- **Quarantine over force-classify.** Lockfiles, snapshots, autoformat-only hunks go in `unassigned` with a `reason`. Don't pretend "Misc cleanup" is a real chapter.
- **No commit-splitting.** This tooling only *describes* the diff. Rewriting history into one-commit-per-chapter is a separate, much riskier tool.

## Status

Schema and validator done (`npm test`). No skill loader wired up, no extension scaffolded yet.
