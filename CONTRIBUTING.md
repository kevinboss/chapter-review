# Contributing

## Prerequisites

Install [Git](https://git-scm.com/doc), [Node.js](https://nodejs.org/en/docs)
(see [.nvmrc](.nvmrc); the skill requires 22.18 or newer), and
[VS Code](https://code.visualstudio.com/docs).

## Repository layout

- `.claude/skills/chapter-review/` — the Claude Code skill and the manifest
format it writes. Partitions the current branch's diff into chapters and writes
the manifest to `<git-dir>/chapter-review/chapters.json` in the target repo
(inside `.git`, so the worktree and `git status` stay clean). Bundles everything
it needs: `SKILL.md`, `COMMANDS.md`, the `chapter-review` CLI (TypeScript, no
build step), `mcp.ts` (the same commands as an MCP server, zero dependencies),
`chapters.schema.json` (draft-07 contract), `validate.ts` (zero-dependency
validator, which wins where it and the schema differ), and
`example-chapters.json` (worked example).
- `.claude/skills/demo/` — `/demo` skill: rebuild the C# demo and have a
sub-agent generate its manifest with the chapter-review skill, then launch the
extension dev host on it.
- `.claude/skills/release/` — `/release` skill: bump the version and push a tag
so the Release workflow publishes the `.vsix` and the skill bundle.
- `scripts/` — `make-demo.ts` builds the demo repo, and `publish-version.ts`
refuses a version a publishing lane must not ship.
- `test/` — `node:test` suites: `validate.test.ts` covers the validator;
`write`, `issues`, `line`, `outside`, `rounds`, and `progress` drive the CLI
end-to-end against throwaway git repos; `mcp.test.ts` drives the MCP server the
same way; and `publish-version.test.ts` covers the version guard both publishing
lanes run.
- `extension/` — VS Code extension that shows `chapters.json` as a tree or a
list and tracks review progress per hunk. A click opens the diff in the same
style as native git history.
- Tooling — `eslint.config.ts` (flat config, typescript-eslint
strict-type-checked with typed linting) plus four `tsconfig.json` projects
covering the skill CLI, the extension, the extension's build scripts, and the
root scripts and tests. `npm run lint` and `npm run typecheck` gate both in CI.
These are dev-only: the skill folder still runs with no install.

## Building and testing

Install both root and extension dependencies first. Root lint and type-check
inspect `extension/src` and need `extension/node_modules` installed.

```bash
npm install
npm --prefix extension install
npm run lint
npm run typecheck
npm test
npm --prefix extension run build
npm --prefix extension test
```

To run the VS Code extension host test suite inside Electron:

```bash
npm --prefix extension run test:host
```

To package a `.vsix` archive via `vsce`:

```bash
npm --prefix extension run package
```

## Running the extension locally

Run `npm install && npm run compile` (or `npm run build` to also bundle the
skill) in `extension/` once, then press F5 in VS Code. Two launch targets are
defined in `.vscode/launch.json`:

- `Run Extension (C# demo)` — run `npm run demo` first to build `demo/`, a
throwaway git repo from `demo-fixtures/{before,after}` (an order-service branch
that swaps email for a queue, renames a helper, updates tests, and bumps xunit).
Generating its manifest is the skill's job: run the `chapter-review` skill
against `demo/` (the skill's end-to-end test), or run
`npm run demo -- --manifest` for the scripted reference. Then open the
Chapter Review side bar and select Chapters.
- `Run Extension` — opens this repo itself, showing whatever review its
`.git/chapter-review/` holds.

## CI and releases

The skill runs from its own folder with nothing to install. The extension is
packaged as a `.vsix` via `vsce`.

On every push and pull request, CI runs lint, the type-check, the tests, and a
portability check that the skill runs without `node_modules`, then builds and
tests the extension (unit tests, extension host tests, and `.vsix` skill
verification).

A push to `main` that passes both jobs publishes a pre-release to the
Marketplace. Tagging `vX.Y.Z` (see the `/release` skill) publishes the `.vsix`
and `chapter-review-skill.zip` to a GitHub Release and the extension to the
Marketplace as a stable release.

Both publishing lanes run `scripts/publish-version.ts`. It refuses a version
that is already published or out of lane (stable releases use even minors;
pre-releases use odd minors), and one that is behind a version this repo has
already tagged.
