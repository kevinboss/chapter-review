---
name: chapter-review
description: Group the current branch's changes into logical "chapters" for review. Writes .claude/chapters.json which the chapter-review VSCode extension renders as a reviewable tree. Use when the user wants to review a branch chapter by chapter, prepare a PR for self-review, or split a sprawling branch into a reviewable narrative.
---

# Chapter review

Partition the current branch's diff into logical chapters and write `.claude/chapters.json` matching the schema sketched in `example-chapters.json`. Every hunk must end up in exactly one chapter — or in `unassigned`.

## Steps

1. **Resolve refs.** `base` = default branch (check `git symbolic-ref refs/remotes/origin/HEAD` if unsure), `head` = current branch, `mergeBase = git merge-base <base> HEAD`. Diff against `mergeBase`, not `base` — you want "what this branch added", not "what main looks like vs me".

2. **Pull the diff.** `git diff --unified=3 <mergeBase>..HEAD`. Parse files and hunk headers (`@@ -oldStart,oldLines +newStart,newLines @@`).

3. **Cluster by intent, not by file.** A chapter is what a reviewer evaluates as one unit: "remove legacy X", "add Y", "rename Z everywhere", "tests for Y". One file can split across chapters; one chapter can span many files. Aim for 3–8 chapters on a typical branch — 15 means you're slicing too thin, 1 means too coarse.

4. **Quarantine noise.** Lockfiles, snapshot updates, generated code, pure autoformat hunks → `unassigned` with a short `reason`. Don't force these into thematic chapters.

5. **Validate the partition before writing.**
   - Completeness: `⋃(chapter hunks) ∪ unassigned == full diff`. Check this yourself against the parsed diff — the validator can't see the repo.
   - Structure and disjointness: run `node scripts/validate.mjs <file>` (from the claude-chapter-review repo) on the candidate JSON. It checks the schema plus: no hunk claimed twice, no overlapping hunk ranges, no whole-file claim next to another claim, consistent status per path.
   - If validation fails, fix and re-validate. Do not write a broken file.

6. **Order chapters as a review flow.** Usually: removals/refactors → new functionality → tests → docs. The order *is* the narrative.

7. **Write `.claude/chapters.json`.** Stable IDs (`ch-1`, `ch-2`, …), ISO-8601 `generatedAt`. After writing, print one line: `Wrote N chapters covering M hunks across F files.` Don't echo the JSON.

## Quality rules

- **Title**: imperative, ≤ 60 chars. "Add OIDC provider", not "OIDC stuff".
- **Description**: only when *why* isn't obvious from the title. One or two sentences. Don't recap the file list — the tree shows it.
- **Per-file `note`**: only when the same file appears in multiple chapters and its role per chapter needs distinguishing. Otherwise omit.
- **No filler chapters.** "Misc cleanup" is a smell — either it's a real refactor (name it) or it belongs in `unassigned`.

## Schema

The contract is `schema/chapters.schema.json` (draft-07); `example-chapters.json` in the repo root is a worked example. Key semantics beyond the obvious:

- A file entry **without** `hunks` claims the file's entire diff (typical for added/deleted files). With `hunks`, only those ranges are claimed and the file may appear in other chapters with disjoint hunks.
- `unassigned` entries require a `reason` and are always present as an array, even when empty.
- `version` is `1`; consumers reject unknown versions.

## Known limitations

- **Chapter IDs reset every run.** `ch-1, ch-2, …` are positional. The extension's collapse/expanded state won't survive regeneration. Stable IDs (content-hash or LLM-side matching) is a v2 problem.
- **No commit-splitting.** This skill only describes the diff. Rewriting history into one-commit-per-chapter is out of scope.
