---
name: release
description: Cut a new release of the chapter-review extension and skill. Bumps the version, tags it, and pushes so the Release workflow builds and publishes the .vsix and skill bundle to GitHub Releases. Use when the user wants to ship a release or publish a new version.
---

# Release

Cut a version tag; GitHub Actions (`.github/workflows/release.yml`) does the building and publishing. This skill's job is the local prep and the tag. Run from the repo root.

## Steps

1. **Preflight — abort if any fails.**
   - On `main` and clean: `git status --porcelain` empty, `git rev-parse --abbrev-ref HEAD` is `main`.
   - Up to date with origin: `git fetch` then confirm no unpushed/unpulled commits.
   - Green: `npm test`, and in `extension/` run `npm ci && npm run compile`.

2. **Choose the version.** Read the current version from `extension/package.json`. Bump per semver: patch for fixes, minor for features, major for breaking contract changes. Take the user's explicit version/bump if given. Confirm the target `vX.Y.Z` with the user before writing anything (their preference: confirm before committing).

3. **Bump.** In `extension/`, run `npm version <X.Y.Z> --no-git-tag-version` (updates `package.json` and `package-lock.json`, no commit/tag). The `--no-git-tag-version` matters: this skill controls the commit and tag, not npm.

4. **Commit.** Stage `extension/package.json` and `extension/package-lock.json` only; commit `Release vX.Y.Z` (subject plus a couple of "why" bullets if the release is notable). Do not add a `Co-Authored-By` line.

5. **Tag and push.** Create an *annotated* tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`. This matters: `git push --follow-tags` only pushes annotated tags, so a lightweight `git tag vX.Y.Z` never reaches origin and the workflow silently fails to trigger. Then `git push origin main --follow-tags`. Confirm the tag actually landed with `git ls-remote --tags origin vX.Y.Z` (must be non-empty); if it's empty, push it explicitly with `git push origin vX.Y.Z`. The tag must be exactly `v` + the `extension/package.json` version, or the workflow fails the release.

6. **Watch the pipeline.** The tag push triggers the Release workflow. Report its URL (`gh run list --workflow=Release --limit 1`), optionally `gh run watch <id>`. It builds the `.vsix`, zips the skill, and attaches both to a GitHub Release with auto-generated notes.

7. **Verify.** Once the run succeeds, confirm with `gh release view vX.Y.Z` that the `.vsix` and `chapter-review-skill.zip` are attached. Report the release URL.

## Notes

- Release notes are auto-generated from commits/PRs since the last tag (`--generate-notes`). For curated notes, edit the release after it's created.
- The repo is private; the release and its assets are visible only to those with repo access. Installing the extension = download the `.vsix`, then "Install from VSIX" in VSCode.
- This never publishes to the VS Code Marketplace. Distribution is GitHub Releases only.
