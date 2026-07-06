---
name: chapter-review
description: Group the current branch's changes into logical "chapters" for review. Writes the chapter manifest to <git-dir>/chapter-review/chapters.json (inside .git, so the worktree stays clean), which the chapter-review VSCode extension renders as a reviewable tree. Use when the user wants to review a branch chapter by chapter, prepare a PR for self-review, or split a sprawling branch into a reviewable narrative.
---

# Chapter review

Partition the current branch's diff into logical chapters and hand them to the extension with the `chapter-review` command that sits next to this file. You never read or write the manifest file yourself: `chapter-review write` installs a partition draft, `chapter-review issue …` records findings, and `chapter-review focus`/`show` read back the review state. The command owns the manifest location (`<git-dir>/chapter-review/chapters.json`), validates every change, and preserves findings across regeneration — so you talk to the extension, not to a file.

Every hunk must end up in exactly one chapter — or in `unassigned`. The contract is `validate.mjs` (authoritative) and `chapters.schema.json` (the same rules as JSON Schema), both next to this file; `example-chapters.json` next to them is a worked illustration. The manifest lives inside the git dir on purpose: it is tool state, invisible to `git status`, and no user-owned file (worktree, `.gitignore`, `.git/info/exclude`) gets touched.

## The command

Run it from anywhere in the repo; resolve its path relative to this SKILL.md (not the target repo's cwd), e.g. `"$SKILL_DIR/chapter-review" <args>`, or `node "$SKILL_DIR/chapter-review" <args>` if it isn't executable. Requirements are only `git` and `node` on PATH.

- `chapter-review write [file]` — validate a **partition draft** (chapters + unassigned + meta, *no* `issues`) and install it. Reads the draft from `file` or stdin. It validates before writing and refuses an invalid manifest, and it carries any existing findings forward (re-mapping each to its new chapter, pruning ones whose path vanished), so regeneration never loses review work. The summary line reports how many findings were preserved and pruned when regenerating (a first write has none).
- `chapter-review issue add --path P --severity S --note "…" [--chapter ch-N] [--hunk oldStart,oldLines,newStart,newLines] [--old-path P]` — record a finding. The id (`iss-N`) is assigned for you and the owning chapter is inferred from `--path`. When the path lives in **one** chapter that's unambiguous; when it spans **several** (a hunk-split file), pass `--hunk` to select the chapter that owns that range, or `--chapter` to name it outright — otherwise the command picks the first owner and warns you to disambiguate.
- `chapter-review issue set <id> [flags]` / `resolve <id>` / `reopen <id>` / `rm <id>` / `list` — revise findings in place. No need to re-send the manifest.
- `chapter-review focus` — print what the reviewer is currently looking at.
- `chapter-review show` — print the current manifest.

Every mutating command validates the resulting manifest and refuses to write if it would be invalid, printing the errors. There is no separate validate step to remember.

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

5. **Check completeness yourself.** `⋃(chapter hunks) ∪ unassigned == full diff` — verify this against the parsed diff, because the command can't see the repo. Everything else (schema, no hunk claimed twice, no overlapping ranges, no whole-file claim next to another claim, consistent status per path) is enforced by `chapter-review write` in the next step: it validates the draft and refuses to install a broken partition, printing the errors. There's no separate validator to run.

6. **Order chapters as a review flow.** The order *is* the narrative: at every chapter the reviewer should know why they're looking at it. Core change first — the thing the branch exists for, with a preceding removal only when it motivates what follows. Independent side changes (mechanical renames, opportunistic refactors) come after the core story, not before it; leading with a trivial rename buries the plot. Then tests, then docs/chores.

   Story test before writing: read your titles top to bottom. They should work as a changelog that explains the branch to someone who hasn't seen the diff. If any title raises "why is this here / why now?", re-order or re-merge. A tooling or test-framework bump (an xunit upgrade, say) can sit with the tests it supports or as a trailing chore; either reads fine.

7. **Note the issues you noticed.** Partitioning means reading the whole diff, so keep track of genuine problems as you go: bugs, risky changes, smells, or things worth questioning. You'll record them with `chapter-review issue add` in step 9 (it needs the manifest to exist first). Each finding is a `path`, a `severity`, a one-line `note`, and — when it's about a specific hunk of a hunk-split file — a `--hunk`; for a whole-file entry (added/deleted/renamed claimed whole), `path` alone is the anchor, don't invent coordinates. The `iss-N` id and the owning chapter are assigned for you.

   Severity: `critical` = broken or unsafe as written (data loss, security hole, crash on a normal path); `high` = a real bug or risk that bites on a real path; `low` = a smell, gap, or minor concern. Judge the change as written, but don't flag an intentional simplification as if it were a production omission unless the branch presents itself as complete. Flag only real findings; a clean chapter has none, and findings never block writing the manifest. The user reviews these and can ask you to add or revise more later (see Follow-up review).

8. **Install the partition.** Build the draft — `version: 1`, `base`, `head`, `mergeBase`, `headSha`, ISO-8601 `generatedAt`, `chapters` (stable IDs `ch-1`, `ch-2`, …), and `unassigned` — and hand it to `chapter-review write` (write it to a scratch file and pass the path, or pipe it on stdin). Do **not** put an `issues` array in the draft; findings are recorded separately in step 9 and preserved automatically. The command validates and refuses a broken partition (fix and re-run), then prints the summary line — relay it, don't echo the JSON. On regeneration it carries existing findings forward and re-maps them for you; nothing to preserve by hand.

9. **Record the findings.** For each problem from step 7, run `chapter-review issue add --path … --severity … --note "…"`. The owning chapter is inferred from the path; when the path spans several chapters, add `--hunk oldStart,oldLines,newStart,newLines` (selects the chapter owning that range) or `--chapter ch-N` (names it) — the command warns if it has to guess. Skip this step when the branch is clean.

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
- `issues` is an optional top-level array of the skill's per-chapter review findings (id, path, optional hunk, chapterId, severity, note, status). You never write this array directly — `chapter-review issue …` owns it (assigning ids, inferring chapters, preserving across regeneration). The durable anchor is `path` (+ `hunk`); `chapterId` is the display grouping and is re-mapped on regen.
- `version` is `1`; consumers reject unknown versions.

## Follow-up review (focus-driven)

Once the manifest exists, the user reviews in the extension and asks you questions here. Run `chapter-review focus` to see what they are currently looking at — it prints what they last clicked (a file, hunk, or issue):

```json
{ "path": "src/auth/oidc.ts", "line": 42, "chapterId": "ch-2", "issueId": "iss-3", "updatedAt": "2026-07-03T10:00:00Z" }
```

`line`, `chapterId`, and `issueId` are optional; if nothing is selected yet the command says so.

**When it applies.** Any question that leans on what the user is currently looking at is focus-driven, not just the phrases "this file / this change / this issue". It also covers "what am I looking at", "what's the problem here", "explain this", and bare follow-ups like "now?". If a question names no explicit target, assume it is about the current focus.

**How to answer.** The focus is a pointer, not the answer. Resolve it: read the referenced file (around `line` when present) and look up `chapterId`/`issueId` in the manifest (`chapter-review show`), then answer about that actual content. Never just echo the pointer back or hand the lookup to the user. Resolve it silently: don't preface the answer by explaining that the question was focus-driven or that you consulted the focus. Just answer as if the user had named the file.

Example: the user asks "what's wrong here?" and the focus points at `QueueNotifier.cs` / `iss-1`. Read the file and the `iss-1` note, then explain the finding against the code, not "you are focused on iss-1".

On request, add or revise findings with `chapter-review issue add` / `issue set <id>` / `resolve <id>` / `reopen <id>` / `rm <id>`; each validates and installs on its own. The focus is transient state owned by the extension; read it with `chapter-review focus`, never write it.

## Installing in another repo

This skill directory is self-contained: `SKILL.md`, the `chapter-review` command, `validate.mjs` (which the command uses), `chapters.schema.json`, `example-chapters.json`. Copy the whole `chapter-review/` folder into that repo's `.claude/skills/`. Requirements are only `git` and `node` on PATH — no `npm install`, no dependencies. Pair it with the chapter-review VSCode extension to review the generated manifest.

## Known limitations

- **Chapter IDs reset every run.** `ch-1, ch-2, …` are positional. The extension's collapse/expanded state won't survive regeneration. Stable IDs (content-hash or LLM-side matching) is a v2 problem.
- **No commit-splitting.** This skill only describes the diff. Rewriting history into one-commit-per-chapter is out of scope.
