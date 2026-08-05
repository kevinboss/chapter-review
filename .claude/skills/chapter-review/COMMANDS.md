# chapter-review command and schema reference

Companion to `SKILL.md`, which is the procedure. This is the lookup: what each command takes, and what the manifest's fields mean.
Read the sections you need; `SKILL.md` links here at the points where they matter.

## The command

Resolve the command's *path* relative to `SKILL.md`. Nothing sets that path for you, no `$SKILL_DIR` is exported, so build the absolute path to the `chapter-review` file sitting next to it and use it verbatim.
**Invoke it as `node "<path>/chapter-review" <args>`.** That form works everywhere.
Calling the file directly (`"<path>/chapter-review" <args>`) also works on macOS and Linux when the executable bit survived checkout, but on Windows the shebang shim is never executable, so prefer the `node` form unconditionally rather than discovering the difference.

But run it with your **current directory inside the repo you're reviewing**: the command picks its manifest destination from `git rev-parse --absolute-git-dir` at the cwd, not from its own location.
In a nested-repo layout (a repo that contains another repo, like a `demo/` fixture) a cwd in the wrong worktree silently writes the manifest into the wrong `.git`.
`write` prints the path it wrote, so check it.
Requirements are `git` and `node` (22.18 or newer) on PATH.

### write

`chapter-review write [file] [--dry-run]` — validate a **partition draft** (chapters + unassigned + meta, *no* `issues`) and install it. Reads the draft from `file` or stdin.

**How to run it.** Run it once with `--dry-run` first, then again without.
The dry run performs every check and prints the same report, opening `Would write …`, but installs nothing; a draft that passes it installs.
That is where you read the counts, the coverage verdict and what would carry forward, so you never have to derive any of it by hand.

**What it validates.** An invalid manifest is refused, never written.
It also refuses a draft describing a different tree, so a wrong-directory run cannot overwrite another repo's review: a draft is accepted when its `headSha` **is** the checked-out commit, or failing that when its `head` names a ref pointing at the checked-out commit.
On that second path, a `mergeBase` or `headSha` naming a commit this repo has never contained is a veto, because two unrelated projects are very often both on `main`.
`head` must be a real ref name: `HEAD`, `@` and their relatives (`HEAD^0`, `@{0}`) resolve to whatever tree you are standing in and so prove nothing.
Both SHAs may be stale (they get re-pinned) but must be commits this repo has; only `generatedAt` accepts a placeholder.
A repo with no resolvable `HEAD` (empty, unborn branch, or `HEAD` pointing at a deleted ref) is refused outright.

**What it preserves and re-pins.** It carries existing findings and the reviewer's checkmarks forward, pruning only entries whose path left the diff, so regeneration never loses review work.
It re-pins `headSha`, `mergeBase` and `generatedAt` to the working tree it observes, so a regenerated manifest matches live git and the extension stops flagging the review as out of date.

**Reading the report.** The summary opens with `Wrote <n> chapters across <n> files (<n> claims)`.
A "claim" is one *enumerated hunk*, except that a whole-file entry (no `hunks` array) counts as exactly 1 however many hunks the diff holds for it; `unassigned` entries are claims too, and `files` counts distinct paths.
The preserved-counts clauses (chapters kept, issues preserved, pruned, checkmarks carried, checkmarks dropped) are appended to that sentence **only when non-zero**, so on a first write it carries no clauses at all; their absence means zero, not a missing line. The lines below it (the destination path, the coverage verdict, the `pinned to HEAD …` pin) always print.
Read "checkmarks carried" as rows that survived path-pruning, not as units that still read as reviewed (see SKILL.md's Regenerating section). It is not a signal to go unchecking things.
Two kinds of per-finding line follow, one per finding rather than counted: `followed rename <id>: <old path> -> <new path>` for a finding whose file moved, and `renumbered <old id> -> <new id> (<chapter>)` for one the new partition handed to another chapter. Relay the renumbered lines; the old id may be quoted somewhere the manifest can't reach.

### issue

`chapter-review issue add --path P --severity S --note "…" [--confidence suspected|verified] [--chapter ch-N] [--hunk oldStart,oldLines,newStart,newLines] [--old-path P]` — record a finding.
The id is assigned for you and the owning chapter is inferred from `--path`.
Ids are numbered per chapter (the schema's `id` gives the shape), which is what makes the number quotable off the extension's tree, where a chapter row reads `2 · <title>` and its findings `2.1`, `2.2`.
When the path lives in **one** chapter that's unambiguous; when it spans **several** (a hunk-split file), pass `--hunk` to select the chapter that owns that range, or `--chapter` to name it outright, otherwise the command picks the first owner and warns you to disambiguate.
`--hunk` does two jobs and the warning only mentions the first: it picks the owning chapter *and* it is what pins the finding to that range.
Omit it and the finding anchors to the whole file, so a finding about one hunk needs `--hunk` even when `--chapter` has already settled ownership.
This second job works on a file claimed whole too: the partition enumerates no ranges there, but the file still has `@@` hunks, and pinning to one is what keeps two findings about different parts of the same file from showing the same location in `issue list`.
`issue list` prints the range each finding carries, so you can see which of the two you got.
A finding defaults to `confidence: suspected`; see SKILL.md step 7.
`--path` must name a path the manifest holds, in a chapter or in `unassigned`; anything else is refused, because a finding outside the diff anchors to nothing the reviewer can open.
Findings anchor to **chapters only**: `--chapter` takes `ch-<number>`, never `unassigned`.
For a path split between a chapter and `unassigned`, the finding lands on the chapter-side owner (that split doesn't count as "spans several", so you get no ambiguity warning); a purely quarantined path has no owner, so the finding is recorded without a `chapterId` and the extension shows it outside any chapter.
Don't file findings against quarantined noise: if a lockfile hunk is worth a finding, it wasn't noise.

`chapter-review issue set <id> [flags]` / `resolve <id>` / `reopen <id>` / `verify <id>` / `unverify <id>` / `rm <id>` / `list` — revise findings in place.
`verify`/`unverify` flip a finding's confidence (shorthand for `set <id> --confidence …`). No need to re-send the manifest.
`set` takes the same flags as `add` and needs at least one of them, including `--status open|resolved` (what `resolve`/`reopen` are shorthand for); `issue --help` prints them all.
A `--hunk` must name a real range, copied exactly: one of the ranges the partition claims for that path, or, when the path is claimed whole, one of that file's `@@` hunks in the diff.
`rm` retires the id rather than freeing it, so the next `add` never reuses a number you may already have quoted in a PR comment or report.
A `set` that moves a finding to another chapter (via `--chapter`, or via a `--path`/`--hunk` another chapter owns) renumbers it into that chapter's sequence and prints the new id, since the number counts there; the old one is retired too.

### uncheck

`chapter-review uncheck --path P [--hunk oldStart,oldLines,newStart,newLines]` — clear the reviewer's checkmark on a file (or one hunk) so it reads as unreviewed again.
It removes the matching unit from `progress.json`, the same kind of direct edit as `issue resolve`; the extension unticks the box, and if the reviewer re-checks it the extension writes it back.
Use it on regeneration for a file whose bytes didn't change but whose correctness now depends on one that did, or mid-review to send the reviewer back to something.

### base-check

`chapter-review base-check [base]` — report whether the review base is fresh before you diff against it (read-only: never fetches, never writes).
Prints JSON with an `action` (`ok` / `switch` / `fetch` / `unresolved`); SKILL.md step 1 acts on it.
Pass the base you resolved to check that exact ref, or omit it to let the command resolve the base the same way step 1 does.

**`action` is the only field that decides what you *do* about the base.**
The rest is diagnostic context you may still read and report; step 1's `ok` branch has you mention a skipped remote check, which is reporting a field, not branching on it: `base`, `baseSha`, `mergeBase`, `message` (a prose version of the verdict), `remoteReachable`, `remoteTip`, plus `unfetched` (a boolean, always present once the base resolved, `true` is what drives a `fetch` verdict) and `suggestedBase` / `suggestedMergeBase` / `ahead`.
Those three appear whenever a fresher local base exists, which is what a `switch` verdict is made of, but they can ride along on a `fetch` too when both conditions hold at once. Their presence is not the verdict; `action` is.
On `unresolved` you get only `action` and `message`, plus `base` when a base was named but didn't resolve (when none resolved at all, `base` is absent from the JSON).
`stale` is a convenience alias for `action !== "ok"` and cannot disagree with `action`; if you only read one field, read `action`.

### focus and show

`chapter-review focus` — print what the reviewer is currently looking at.
`chapter-review show` — print the current manifest.

### Two rules that hold across all of them

Every mutating command validates the resulting manifest and refuses to write if it would be invalid, printing the errors. There is no separate validate step to remember.

**One writer per document, one agent at a time.** `chapters.json` is yours; `progress.json` and `focus.json` are the extension's.
That split is what lets you record a finding while the reviewer ticks a box without either of you losing the other's edit.
Within your half, run the commands **serially**: each one reads the manifest, changes one thing and writes it back, so two of your own invocations racing each other will drop one of the changes and both report success.
Nothing enforces this; sequential calls are the contract.

## Schema

**Read `chapters.schema.json` for the field semantics.** It ships next to `SKILL.md` and every field carries a `description`, so the shape of a draft, which keys are required, and when to omit `hunks` or a `note` are all answered there. `validate.ts` (also there) enforces it and wins if the two disagree; `example-chapters.json` is the worked illustration. Only what the schema cannot state is repeated here:

- **A `hunks` object and a `--hunk` flag are the same four numbers in two spellings.** The flag takes them as a bare comma-separated list in schema order, so `--hunk 7,9,8,14` names the range a draft spells `{ "oldStart": 7, "oldLines": 9, "newStart": 8, "newLines": 14 }`.
- **`issues` and `issueSeq` are the CLI's, not yours.** `chapter-review issue …` assigns ids, infers the owning chapter and preserves both across regeneration; `write` refuses a draft carrying `issues` at all. The durable anchor is `path` (+ `hunk`), so `chapterId` re-maps itself when a path moves chapters, and the id is renumbered with it: an id's chapter part must agree with its `chapterId`, and `validate.ts` refuses a manifest where it doesn't.
- **Chapter ids start at `ch-1`.** `ch-0` is refused: 0 is the issue sequence for findings no chapter owns, which is what `iss-0.N` and `issueSeq["0"]` refer to.
- **Checkmarks are a separate document you never author**: `<git-dir>/chapter-review/progress.json`, owned by the extension, read by the CLI, and cleared only by `uncheck`. A unit reads as checked while its stored digest matches current content, which is what re-opens a file whose bytes moved and leaves an untouched one ticked.
