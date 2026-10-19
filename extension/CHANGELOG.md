# Changelog

All notable changes to the Chapter Review extension are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-10-19

### Added
- The skill ships an MCP server, `mcp.ts`, offering its commands as typed tools.
  The agent passes the repository and the draft as fields instead of assembling a `node <path>/chapter-review` line, and the server runs one call at a time.
- Installing or updating the skill also registers that server with Claude Code: at user scope for a user install, at local scope for a workspace install, so no committed `.mcp.json` is touched.
  Without the `claude` command on PATH the skill still installs, and the notification offers the command to copy.
- Findings on a file the branch left wrong without changing it, such as a stale doc or a forgotten caller.
  `issue add --path <file> --line <n> --cause-path <changed file>` records one on the stale file itself, filed under the chapter of the change that caused it.
  The row says "outside the diff", and clicking it opens the file as reviewed, on that line.
  These used to be anchored on the changed file with the real location only in the note, so clicking one opened code it was not about.

### Changed
- The skill paces a review one chapter at a time: you read a chapter's code first and discuss its findings afterwards.
  The handover gives only the number of findings per chapter, since findings shown up front shape how the code gets read.
  A finding raised while reading that belongs to a chapter you already finished is taken up at the end of the current one, so it still gets discussed.

## [0.10.0] - 2026-09-08

### Added
- "Discard Review" in the Chapters view removes the whole protocol directory,
  which used to mean deleting files under `.git` by hand. Confirmed with a
  modal naming how many findings and checkmarks are at stake, since nothing
  here is recoverable afterwards.
- Chapter rows and finding rows show their numbers, so there is something to
  quote back at the agent.

### Changed
- Finding ids read `iss-<chapter>.<n>` instead of a branch-wide counter, so an
  id says where the finding sits rather than how many came before it. A finding
  that moves to another chapter takes a new number and `write` prints the
  mapping. Old `iss-N` ids no longer validate: regenerate the manifest.
- A finding carries one problem, not two. Two problems in one note share a
  single severity, so the lesser one arrives inflated and one `issue resolve`
  closes both or neither.
- `write` now reports findings whose hunk left the diff, which is what an
  author fixing exactly that hunk produces. Reported rather than resolved:
  whether the finding still stands needs the diff in front of you.

### Fixed
- Clicking a finding lands on its changed line rather than three lines of
  context above it. The same finding used to read right or wrong depending on
  how its file happened to be partitioned.
- A finding whose coordinates drifted through a partition rewrite resolves onto
  the range covering them, instead of opening the file at line 1 as if the
  finding were there.
- `issue add` and `issue set` refuse a chapter that does not hold the finding's
  path, or a range another chapter owns. Both cases used to be undone silently
  by the next `write`, behind a `renumbered` line that looked like the branch
  had moved.
- A row's tooltip stays open when the pointer reaches it, so a finding's note
  can be read without holding the mouse still.

## [0.8.1] - 2026-08-03

### Fixed
- The logo at the top of the Marketplace page. Relative image paths in this
  README were rewritten to the repository root rather than to the `extension/`
  directory the files live in, so the page requested an image that was not
  there. The icon beside the extension name was never affected, since that one
  is read from inside the package rather than fetched.

## [0.8.0] - 2026-08-03

### Added
- Pre-release channel. Every push to `main` now publishes a pre-release build,
  reachable from "Switch to Pre-Release Version" on the extension's Marketplace
  page. Stable releases use even minor versions and pre-releases the next odd
  one, so the two channels never collide on a version number.
- A warning row when the worktree has uncommitted changes, so it is clear that
  the chapters render the last commit rather than what is currently on disk.
- Review findings carry a confidence, `suspected` or `verified`. A first-pass
  note now reads as something to check before relying on, not as settled.
- `chapter-review uncheck` clears the checkmark on a file or hunk, to send the
  reviewer back to something whose own bytes did not change.
- `chapter-review write --dry-run` runs every check and prints the same report
  as a real write, installing nothing.
- A finding can be pinned to a hunk of a file the partition claims whole, so two
  findings on the same file stay distinguishable.

### Changed
- Review progress lives in its own `progress.json` beside the manifest. The
  agent owns `chapters.json` and the extension owns progress, so neither side's
  writes can drop the other's.
- A checkmark on an unchanged file now survives a regeneration that splits that
  file into hunks. The tick used to be discarded even though the content matched.
- The prompt to update the installed skill compares content rather than version
  numbers, so it fires when your copy actually differs from the bundled one.
- The skill's command reference moved to `COMMANDS.md`, leaving `SKILL.md` for
  the partitioning guidance.

### Fixed
- `chapter-review write` refuses a partition the diff contradicts: an unclaimed
  file or hunk, a range the diff does not have, a path outside the diff, or a
  status git disagrees with. It names every offender instead of installing a
  manifest that renders against the wrong lines.
- Regenerating a manifest no longer loses recorded findings or checkmarks.
- The published `.vsix` no longer carries compiled test output.

## [0.7.3] - 2026-07-17

### Added
- Chapter generation now checks that the review base is fresh before diffing. A
  stale base (an unfetched `origin/main`, or a local `main` behind it) used to
  push the merge base back to an old fork point and fill the review with commits
  already merged to main. It now switches to a fresher local base automatically,
  or asks before fetching when only the remote is behind.

## [0.7.2] - 2026-07-16

### Fixed
- The "Review may be out of date" banner now clears when the manifest is
  regenerated in place, instead of lingering after the chapters were rebuilt
  against the current commit.

## [0.7.1] - 2026-07-15

### Fixed
- Marketplace listing: backfilled the 0.7.0 changelog entry, which was missing
  when 0.7.0 was first published.

## [0.7.0] - 2026-07-15

### Changed
- Review progress is tracked by each hunk's content digest instead of its
  position in the diff, so completed hunks stay completed when other hunks are
  added, removed, or shift around them.

## [0.6.0] - 2026-07-13

### Changed
- Container rows (chapter, folder, Unassigned) now carry a checkbox that
  completes every file review unit beneath them in one step.
- Issues carry a checkbox too: ticking one marks it resolved and writes the
  status back to the manifest, so completing a finding works like completing a
  file. Chapter and issue completion are tracked independently.

### Removed
- The separate inline "resolve issue" action, now that issues use the checkbox.

## [0.5.0] - 2026-07-07

### Added
- Stale-review detection: the Chapters view flags when the branch has moved past
  the commit its chapters were generated against, with the reason and the fix in
  the tooltip. Re-checks live on commit, amend, rebase or checkout.

## [0.4.0] - 2026-07-06

### Added
- Open the working file from a chapter-scoped diff via an editor-title button.

### Changed
- The install/update skill action reflects the installed state (semver-aware)
  and hides when the bundled skill is already current.
- Refactored the extension into focused modules.

### Fixed
- chapter-review skill friction: a working-directory footgun, a spurious
  `--hunk` warning, and `generatedAt` precision.

## [0.3.0] - 2026-07-06

### Changed
- The skill now talks to the extension through the `chapter-review` command
  instead of hand-editing `chapters.json`. Findings are managed granularly and
  preserved across manifest regeneration.

## [0.2.1] - 2026-07-03

### Changed
- The bundled skill's version is stamped from the extension version.

## [0.2.0] - 2026-07-03

### Added
- Review issues and focus-driven follow-up.
- A dedicated activity-bar icon.

## [0.1.0] - 2026-07-03

### Added
- Initial release: the **Chapters** view (chapters → files → hunks) with an
  Unassigned bucket, chapter-scoped diffs, per-hunk review progress, and a
  tree/list toggle.
- Skill installer: the extension bundles the chapter-review skill and installs
  it into your coding agent, consent-gated.

[0.12.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.12.0
[0.10.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.10.0
[0.8.1]: https://github.com/kevinboss/chapter-review/releases/tag/v0.8.1
[0.8.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.8.0
[0.7.3]: https://github.com/kevinboss/chapter-review/releases/tag/v0.7.3
[0.7.2]: https://github.com/kevinboss/chapter-review/releases/tag/v0.7.2
[0.7.1]: https://github.com/kevinboss/chapter-review/releases/tag/v0.7.1
[0.7.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.7.0
[0.6.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.6.0
[0.5.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.5.0
[0.4.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.4.0
[0.3.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.3.0
[0.2.1]: https://github.com/kevinboss/chapter-review/releases/tag/v0.2.1
[0.2.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.2.0
[0.1.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.1.0
