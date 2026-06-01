# claude-chapter-review

Tooling to review a git branch as a series of logical *chapters* instead of one undifferentiated diff.

Two pieces:

- **`skill/`** — Claude Code skill that partitions the current branch's diff into chapters and writes `.claude/chapters.json` in the target repo.
- **`extension/`** — VSCode extension that renders `chapters.json` as a tree (list + tree views), opens diffs on click in the same style as the native git history, and tracks review progress per hunk.

The contract between them is the JSON schema sketched in [`example-chapters.json`](./example-chapters.json). Q&A about the branch still happens in the Claude Code terminal — the extension is purely a review surface.

## Design decisions so far

- **Partition, not overlap.** Every hunk lives in exactly one chapter, or in `unassigned`. Enables a meaningful "12 of 47 hunks reviewed" progress counter and avoids "shown twice" weirdness in the tree.
- **Merge-base, not base.** The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters reflect "what this branch added", not "main vs me".
- **Quarantine over force-classify.** Lockfiles, snapshots, autoformat-only hunks go in `unassigned` with a `reason`. Don't pretend "Misc cleanup" is a real chapter.
- **No commit-splitting.** This tooling only *describes* the diff. Rewriting history into one-commit-per-chapter is a separate, much riskier tool.

## Status

Sketches only. No skill loader wired up, no extension scaffolded yet.
