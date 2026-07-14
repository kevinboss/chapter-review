# Publishing checklist

Tracking what it takes to publish Chapter Review to a real marketplace with a
professional listing. Mechanical prep is done; what remains needs an account, a
decision, or a recording.

## Done (mechanical prep)

- [x] Removed `"private": true` from `extension/package.json` (it blocks `vsce`).
- [x] Added a 128x128 gallery icon: `extension/media/icon.png` (source kept at
      `extension/media/icon.svg`, re-render with headless Chrome). Same glyph as
      the activity-bar icon so the product reads as one.
- [x] Wired the `"icon"` field in `package.json`.
- [x] Added listing metadata: `keywords`, `galleryBanner`, `homepage`, `bugs`.
- [x] Added `extension/CHANGELOG.md` (backfilled from the tagged releases; the
      Marketplace renders it as a Changelog tab).
- [x] Fixed the README: corrected the view location (its own Chapter Review
      activity-bar container, not the Source Control panel), refreshed the
      limitations, and listed staleness detection as a shipped feature.
- [x] Confirmed `npm run package` builds a clean `.vsix` with the icon and
      changelog included.

## Remaining — decisions (settle these first)

- [ ] **Make the GitHub repo public?** The listing's Repository / homepage / bugs
      links point at `github.com/kevinboss/chapter-review`, which is private today,
      so they 404 for anyone but you. Either make it public or strip those links
      before publishing.
- [ ] **Publish to Open VSX too?** Your audience skews to Cursor / Windsurf /
      VSCodium, none of which use the Microsoft Marketplace. Same `.vsix`,
      separate account and token (see below).
- [ ] **Set expectations in the short description?** The extension is inert
      without the companion skill and a coding agent. Consider saying so in the
      `description` field so a cold Marketplace visitor is not surprised by an
      empty view.

## Remaining — manual work

### Marketplace listing content

- [ ] Record a short GIF of the flow (tree -> click a file -> chapter-scoped diff
      -> tick a checkbox) and add it near the top of `extension/README.md`. This is
      the single biggest lever on the listing. Images must be absolute URLs (raw
      GitHub or a `media/` asset referenced by full URL), not relative paths.
- [ ] Add one or two still screenshots (the Chapters tree; a scoped diff).

### VS Code Marketplace account + publish

- [ ] Create an Azure DevOps organization and a Marketplace **publisher** with id
      `kevinboss` (matches `package.json`): https://marketplace.visualstudio.com/manage
- [ ] Generate a Personal Access Token (scope: Marketplace > Manage) and
      `npx vsce login kevinboss`.
- [ ] Publish: `cd extension && npx vsce publish` (or publish the built `.vsix`).

### Open VSX (optional, for Cursor / Windsurf / VSCodium)

- [ ] Create an Open VSX account, sign the publisher agreement, generate a token.
- [ ] `npx ovsx publish extension/chapter-review-<version>.vsix -p <token>`.

### Fold into the release flow

- [ ] Once publishing works by hand, add the Marketplace (and Open VSX) publish
      steps to `.github/workflows/release.yml` so a `v*` tag ships the `.vsix` to
      GitHub Releases and both marketplaces in one go. Store tokens as repo
      secrets. Update the `/release` skill notes to match.
