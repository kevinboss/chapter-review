# Changelog

All notable changes to the Chapter Review extension are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.6.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.6.0
[0.5.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.5.0
[0.4.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.4.0
[0.3.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.3.0
[0.2.1]: https://github.com/kevinboss/chapter-review/releases/tag/v0.2.1
[0.2.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.2.0
[0.1.0]: https://github.com/kevinboss/chapter-review/releases/tag/v0.1.0
