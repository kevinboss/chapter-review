# Extension reference

The Chapter Review extension renders `<git-dir>/chapter-review/chapters.json` as
a reviewable tree in its own side bar. The extension is the review surface; it
does not generate the manifest itself, and questions about the branch still go
to your coding agent in its terminal.

If the Chapters view says "No chapter manifest found", the `chapter-review`
skill has not generated a manifest for the open repository yet.

## Chapters view

The Chapters view lives in its own activity-bar container and lists chapters,
files, and hunks, with an Unassigned bucket for quarantined noise (lockfiles,
generated code, and autoformat hunks). A tree/list toggle switches how files
appear inside a chapter, mirroring the native git views.

Rows are numbered: a chapter reads `2 · <title>` and its findings read `2.1`,
`2.2` because findings are numbered inside their chapter. Refer to "chapter 2"
or "2.1" in your coding agent instead of pasting a title; the skill resolves
them to `ch-2` and `iss-2.1`. The full id appears in the row's tooltip.

Selecting any row updates the focus pointer so your next question to the agent
targets what you are looking at.

## Chapter-scoped diffs

Clicking a file or hunk opens a diff showing only that chapter's changes, even
when other chapters touch the same file. The cursor lands on the first changed
line. Diffs follow the style of the native git history view.

## Review progress

Files and hunks carry native checkboxes. Progress tracks reviewed content so
checkmarks survive manifest regeneration for unchanged hunks. Ticking a chapter,
a folder, or the Unassigned root completes every file beneath it in one step.
The view shows per-chapter counts and an overall "N of M reviewed" summary.

## Findings

Findings the agent records while you read sit inside the chapter they concern,
pinned to a whole file, a hunk, or specific lines. Each finding carries a
checkbox: ticking it marks the finding resolved and writes that status back to
the manifest for the skill to read.

Clicking a finding opens its chapter's diff on the line the finding names, or on
its range's first change when no line is set. A finding on a file the branch
left wrong without changing it (such as a stale doc or a forgotten caller) sits
under the chapter of the change that caused it and reads "outside the diff".
Clicking it opens that file as it stands at the reviewed commit on the finding's
line.

## Review rounds

When the author pushes fixes and you run the skill again, the new round holds
only what changed since the previous one in a drawer of its own above earlier
rounds. Earlier rounds stay open with their checkmarks intact.

A round's diff runs from the previous round's head, replayed onto the new base
when the author rebased, so you read only the fixups rather than the whole
branch again. Each file row in a later round also offers the whole-branch diff
next to it. Open findings on files the fixups touched carry into the new round
and move with the code they point at.

## Uncommitted changes

The skill can also review uncommitted changes before you commit, either on their
own or combined with the branch's commits. It snapshots the working tree inside
`.git` so you can edit files while the review stays stable, parks any active
branch review, and restores it when you discard the working-tree review.

## Refresh and staleness

The view auto-refreshes whenever the skill regenerates the manifest. Staleness
detection flags when the branch has moved past the commit the chapters were
generated against, so you know when to regenerate the manifest.

## Known limitations

- Staleness is detected at the branch level (the recorded head moved). It does
not yet recompute which individual hunks changed, so a stale manifest is flagged
rather than partially updated.
- Multi-root workspaces: only the first folder is considered.
