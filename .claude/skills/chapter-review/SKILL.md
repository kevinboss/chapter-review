---
name: chapter-review
description: Group the current branch's changes into logical "chapters" for review. Writes the chapter manifest to <git-dir>/chapter-review/chapters.json (inside .git, so the worktree stays clean), which the chapter-review VSCode extension renders as a reviewable tree. Use when the user wants to review a branch chapter by chapter, prepare a PR for self-review, or split a sprawling branch into a reviewable narrative.
---

# Chapter review

Partition the current branch's diff into logical chapters and write the manifest to `$(git rev-parse --git-dir)/chapter-review/chapters.json`. The contract is `validate.mjs` (authoritative) and `chapters.schema.json` (the same rules as JSON Schema), both next to this file; `example-chapters.json` next to them is a worked illustration. Every hunk must end up in exactly one chapter — or in `unassigned`. The manifest lives inside the git dir on purpose: it is tool state, invisible to `git status`, and no user-owned file (worktree, `.gitignore`, `.git/info/exclude`) gets touched.

## Steps

1. **Resolve refs.** `base` = default branch (check `git symbolic-ref refs/remotes/origin/HEAD`; on repos without an origin remote that errors — fall back to `main`, then `master`), `head` = current branch, `mergeBase = git merge-base <base> HEAD`, `headSha = git rev-parse HEAD`. `base` and `head` are ref names ("main"), `mergeBase` and `headSha` are full SHAs. Diff against `mergeBase`, not `base` — you want "what this branch added", not "what main looks like vs me". Always record `headSha`: the extension reconstructs chapter-scoped diffs from it after the branch moves on.

2. **Pull the diff.** `git diff -M --unified=3 <mergeBase>..HEAD`. `-M` matters: without it a rename shows up as delete+add and can never become `status: "renamed"`. Parse files and hunk headers (`@@ -oldStart,oldLines +newStart,newLines @@`). Header quirks: a count of 1 is omitted (`@@ -3 +3,2 @@` means `oldLines: 1`), and the empty side of an added/deleted file reads `-0,0` / `+0,0`.

3. **Cluster by intent, not by file.** A chapter is what a reviewer evaluates as one unit: "remove legacy X", "add Y", "rename Z everywhere", "tests for Y". One file can split across chapters; one chapter can span many files. Aim for 3–8 chapters on a typical branch — 15 means you're slicing too thin, 1 means too coarse. On a small branch fewer is fine; never pad the count.

   Chapters must be self-contained: the reviewer should see a change *and* what it means in one sitting.
   - Don't split an abstraction from its implementation and wiring. An interface, its first implementation, and the injection sites are one chapter unless each is genuinely large.
   - When the branch replaces X with Y, keep the removal of X visible: either one "replace X with Y" chapter, or a "remove X" chapter directly next to the "add Y" chapter. Never tuck the deletion of X into a chapter whose title is about Y's wiring.
   - A chapter whose files can't be understood without opening a later chapter is mis-cut.

4. **Quarantine noise.** Lockfiles, snapshot updates, generated code, pure autoformat hunks → `unassigned` with a short `reason`. Don't force these into thematic chapters.

   A generated file's *driver* is not noise: a version bump in a csproj or package.json is a hand edit and belongs in a chapter (its own chore chapter, or the chapter that needed the bump), while the lockfile it regenerates goes to `unassigned` with a reason pointing at the driver.

5. **Validate the partition before writing.**
   - Completeness: `⋃(chapter hunks) ∪ unassigned == full diff`. Check this yourself against the parsed diff — the validator can't see the repo.
   - Structure and disjointness: run `node validate.mjs <candidate.json>` where `validate.mjs` sits next to this SKILL.md (zero dependencies, just needs Node — resolve it relative to this file, not the target repo's cwd). It checks the schema plus: no hunk claimed twice, no overlapping hunk ranges, no whole-file claim next to another claim, consistent status per path.
   - If validation fails, fix and re-validate. Do not write a broken file.

6. **Order chapters as a review flow.** The order *is* the narrative: at every chapter the reviewer should know why they're looking at it. Core change first — the thing the branch exists for, with a preceding removal only when it motivates what follows. Independent side changes (mechanical renames, opportunistic refactors) come after the core story, not before it; leading with a trivial rename buries the plot. Then tests, then docs/chores.

   Story test before writing: read your titles top to bottom. They should work as a changelog that explains the branch to someone who hasn't seen the diff. If any title raises "why is this here / why now?", re-order or re-merge.

7. **Write the manifest.** Target: `$(git rev-parse --git-dir)/chapter-review/chapters.json` — use `--git-dir`, not a hardcoded `.git/`, so worktrees resolve correctly; create the `chapter-review` directory if missing. Stable IDs (`ch-1`, `ch-2`, …), ISO-8601 `generatedAt`. After writing, print one line: `Wrote N chapters covering M hunks across F files.` M counts unified-diff hunks (what step 2 parsed), not claim entries — a whole-file claim spanning 3 hunks counts as 3. The validator prints claim units instead (whole-file = 1), so its number being lower than M is expected, not a bug. Don't echo the JSON.

## Quality rules

- **Title**: imperative, ≤ 60 chars. "Add OIDC provider", not "OIDC stuff".
- **Description**: only when *why* isn't obvious from the title. One or two sentences. Don't recap the file list — the tree shows it.
- **Per-file `note`**: only when the same file appears in multiple chapters and its role per chapter needs distinguishing. Otherwise omit.
- **No filler chapters.** "Misc cleanup" is a smell — either it's a real refactor (name it) or it belongs in `unassigned`.

## Schema

The contract is `chapters.schema.json` (draft-07) and the worked example is `example-chapters.json`, both next to this SKILL.md. `validate.mjs` (also here) enforces it and is authoritative if the two ever disagree. Key semantics beyond the obvious:

- A file entry **without** `hunks` claims the file's entire diff (typical for added/deleted files). With `hunks`, only those ranges are claimed and the file may appear in other chapters with disjoint hunks.
- Splitting a file between a chapter and `unassigned` is normal (e.g. one real hunk plus one autoformat hunk); the disjointness rules are the same. In that case give the chapter-side entry a `note`; the unassigned side carries only its `reason` (the schema forbids `note` there).
- A renamed file's content hunks are absorbed by its whole-file claim; enumerate them only if they must split across chapters, then treat it like any modified file (with `oldPath` set).
- `unassigned` entries require a `reason` and are always present as an array, even when empty.
- `version` is `1`; consumers reject unknown versions.

## Installing in another repo

This skill directory is self-contained: `SKILL.md`, `validate.mjs`, `chapters.schema.json`, `example-chapters.json`. Copy the whole `chapter-review/` folder into that repo's `.claude/skills/`. Requirements are only `git` and `node` on PATH — no `npm install`, no dependencies. Pair it with the chapter-review VSCode extension to review the generated manifest.

## Known limitations

- **Chapter IDs reset every run.** `ch-1, ch-2, …` are positional. The extension's collapse/expanded state won't survive regeneration. Stable IDs (content-hash or LLM-side matching) is a v2 problem.
- **No commit-splitting.** This skill only describes the diff. Rewriting history into one-commit-per-chapter is out of scope.
