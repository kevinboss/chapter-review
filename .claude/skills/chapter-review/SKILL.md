---
name: chapter-review
description: Group the current branch's changes into logical "chapters" for review. Writes the chapter manifest to <git-dir>/chapter-review/chapters.json (inside .git, so the worktree stays clean), which the chapter-review VSCode extension renders as a reviewable tree. Use when the user wants to review a branch chapter by chapter, prepare a PR for self-review, or split a sprawling branch into a reviewable narrative.
---

# Chapter review

Partition the current branch's diff into logical chapters and hand them to the extension with the `chapter-review` command that sits next to this file. You never read or write the manifest file yourself: `chapter-review write` installs a partition draft, `chapter-review issue …` records findings, and `chapter-review focus`/`show` read back the review state. The command owns the manifest location (`<git-dir>/chapter-review/chapters.json`), validates every change, and preserves findings across regeneration — so you talk to the extension, not to a file.

Every hunk must end up in exactly one chapter — or in `unassigned`. The contract is `validate.mjs` (authoritative) and `chapters.schema.json` (the same rules as JSON Schema), both next to this file; `example-chapters.json` next to them is a worked illustration. The manifest lives inside the git dir on purpose: it is tool state, invisible to `git status`, and no user-owned file (worktree, `.gitignore`, `.git/info/exclude`) gets touched.

## The command

Resolve the command's *path* relative to this SKILL.md, e.g. `"$SKILL_DIR/chapter-review" <args>`, or `node "$SKILL_DIR/chapter-review" <args>` if it isn't executable. But run it with your **current directory inside the repo you're reviewing**: the command picks its manifest destination from `git rev-parse --absolute-git-dir` at the cwd, not from its own location. In a nested-repo layout (a repo that contains another repo, like a `demo/` fixture) a cwd in the wrong worktree silently writes the manifest into the wrong `.git`. `write` prints the path it wrote — check it. Requirements are only `git` and `node` on PATH.

- `chapter-review write [file]` — validate a **partition draft** (chapters + unassigned + meta, *no* `issues`) and install it. Reads the draft from `file` or stdin. It validates before writing and refuses an invalid manifest, and it carries any existing findings forward (re-mapping each to its new chapter, pruning ones whose path vanished), so regeneration never loses review work. It also re-pins the commit metadata (`headSha`, `mergeBase`, `generatedAt`) to the working tree it observes, so a regenerated manifest matches live git and the extension stops flagging the review as out of date. The summary line reports how many findings were preserved and pruned when regenerating (a first write has none).
- `chapter-review issue add --path P --severity S --note "…" [--chapter ch-N] [--hunk oldStart,oldLines,newStart,newLines] [--old-path P]` — record a finding. The id (`iss-N`) is assigned for you and the owning chapter is inferred from `--path`. When the path lives in **one** chapter that's unambiguous; when it spans **several** (a hunk-split file), pass `--hunk` to select the chapter that owns that range, or `--chapter` to name it outright — otherwise the command picks the first owner and warns you to disambiguate.
- `chapter-review issue set <id> [flags]` / `resolve <id>` / `reopen <id>` / `rm <id>` / `list` — revise findings in place. No need to re-send the manifest.
- `chapter-review base-check [base]` — report whether the review base is fresh before you diff against it (read-only: never fetches, never writes). Prints JSON with an `action` (`ok` / `switch` / `fetch` / `unresolved`); step 1 acts on it. Pass the base you resolved to check that exact ref, or omit it to let the command resolve the base the same way step 1 does.
- `chapter-review focus` — print what the reviewer is currently looking at.
- `chapter-review show` — print the current manifest.

Every mutating command validates the resulting manifest and refuses to write if it would be invalid, printing the errors. There is no separate validate step to remember.

## Steps

1. **Resolve refs, then confirm the base is fresh.** `base` = default branch (check `git symbolic-ref refs/remotes/origin/HEAD`; on repos without an origin remote that errors — fall back to `main`, then `master`), `head` = current branch, `headSha = git rev-parse HEAD`. `base` and `head` are ref names ("main"), `headSha` is a full SHA.

   Before taking the diff, run `chapter-review base-check` (pass your resolved base to check that exact ref, or omit it to let the command resolve it the same way). A stale base is the classic footgun: an unfetched `origin/main` (or a local `main` behind it) pushes the merge base back to an old fork point, so the diff fills with commits already merged to main. The command is read-only and prints JSON with an `action`:
   - `"ok"` — the base is current; proceed. If `remoteReachable` is `false` the network check was skipped (offline, or no origin remote); proceed and mention it.
   - `"switch"` — a fresher copy of the base already exists locally (`suggestedBase`, forking `ahead` commits ahead of your base). Set `base = suggestedBase` and continue. It's a local ref with no fetch, so don't ask — just note the switch in your summary to the user.
   - `"fetch"` — `origin/<branch>` differs from the real remote tip (unfetched). Ask the user with one `AskUserQuestion` whether to `git fetch` the base and regenerate against the fresh fork point, or proceed against the stale base. Fetch only on their go-ahead, then recompute against the moved ref.
   - `"unresolved"` — no base ref resolved; fall back to the resolution above and continue without the check.

   Then `mergeBase = git merge-base <base> HEAD` against the (possibly switched) base — a full SHA. Diff against `mergeBase`, not `base` — you want "what this branch added", not "what main looks like vs me". Always record `headSha`: the extension reconstructs chapter-scoped diffs from it after the branch moves on. Resolve all of this fresh on every run, a regeneration after the branch moved included (see [Regenerating](#regenerating-the-branch-moved)); never carry a previous run's refs forward.

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

8. **Install the partition.** Build the draft — `version: 1`, `base`, `head`, `mergeBase`, `headSha`, ISO-8601 `generatedAt`, an optional one-line `summary` (shown as the branch summary in the extension), `chapters` (stable IDs `ch-1`, `ch-2`, …), and `unassigned` — and hand it to `chapter-review write` (write it to a scratch file and pass the path, or pipe it on stdin). Do **not** put an `issues` array in the draft; findings are recorded separately in step 9 and preserved automatically. The command validates and refuses a broken partition (fix and re-run), then prints the summary line — relay it, don't echo the JSON. On regeneration it carries existing findings forward and re-maps them for you; nothing to preserve by hand. It also re-pins `headSha`/`mergeBase`/`generatedAt` to the commit it sees, so the manifest matches live git and the extension's "Review may be out of date" banner clears once the write lands.

9. **Record the findings.** For each problem from step 7, run `chapter-review issue add --path … --severity … --note "…"`. The owning chapter is inferred from the path; when the path spans several chapters, add `--hunk oldStart,oldLines,newStart,newLines` (selects the chapter owning that range) or `--chapter ch-N` (names it) — the command warns if it has to guess. Skip this step when the branch is clean.

## Regenerating (the branch moved)

Re-running the skill on a branch that already has a manifest is a normal operation. You regenerate after new commits, an amend, a rebase, or a fetch that moved the base. There is one rule: do the full flow again. Resolve refs fresh (step 1) and rebuild the partition from the current `mergeBase..HEAD` diff. Don't edit the old manifest and don't reuse the previous run's `headSha`/`mergeBase`; the branch moved, which is the whole reason you're re-running. You call the same `chapter-review write` as a first run, and it handles the continuity:

- **Commit pin.** `write` stamps the commit pin (`headSha` and `mergeBase`) plus a fresh `generatedAt` from the working tree it observes, overriding whatever the draft carried. This is what clears the extension's "Review may be out of date" banner: the manifest lands pinned to the current commit, so it matches live git the moment it's written. You still compute `mergeBase` to take the diff, but you don't have to land the pin exactly right, because the command owns it. The flip side of that guarantee: build the partition against the **current** HEAD, since that's what `write` pins to. A stale partition stamped with a fresh HEAD would render diffs against the wrong blobs.
- **Findings.** Recorded issues carry forward by `path` (+ `hunk`), re-mapped to whichever new chapter owns that path, pruned only when the path left the diff. After writing, add findings for genuinely new problems; don't re-add ones the carry-forward already kept (check `chapter-review issue list`).
- **Review progress.** The reviewer's checkmarks live in the extension keyed by content digest, not by chapter id or line number. A file or hunk whose content didn't change keeps its checkmark across regeneration; one whose content moved reads as unreviewed again. The reviewer resumes on untouched code and only re-reviews what actually changed.

What doesn't survive is cosmetic: chapter ids are positional (`ch-1`, `ch-2`, …) so they can shift, and the extension's collapse/expand state resets, neither of which is review state.

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
