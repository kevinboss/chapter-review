# Installation

## Requirements

- A git repository open in VS Code, with `git` on `PATH`.
- Node.js 22.18 or newer on `PATH`, required by the skill CLI and MCP server.
- A coding agent that loads Claude Code skills (Claude Code today) to generate
the manifest.

## Extension

Install Chapter Review from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kevinboss.chapter-review).

To install from a GitHub Release instead, download
`chapter-review-<version>.vsix` from
[Releases](https://github.com/kevinboss/chapter-review/releases) and run
"Extensions: Install from VSIX…" in VS Code, or install it from a terminal:

```bash
code --install-extension chapter-review-<version>.vsix
```

## Skill and MCP server

The extension bundles the `chapter-review` skill. Run
`Chapter Review: Install Skill` from the Command Palette (or click
"Install the skill" in the empty Chapters view) and pick a destination:
`~/.claude/skills/` for every repository, or the current workspace only.

The same step registers the skill's MCP server with Claude Code via
`claude mcp add` (at user scope for a global install, or at local scope for a
workspace install) so the agent can call review commands as typed tools. If the
`claude` command is not on `PATH`, the skill still installs and the notification
offers the registration command to copy.

Restart your coding agent so it loads the skill. Whenever your installed copy
differs from the one the extension carries, the extension prompts you to update
it.

## Manual skill installation

Copy `.claude/skills/chapter-review/` into your repository's `.claude/skills/`
directory, or unzip `chapter-review-skill.zip` from a
[GitHub Release](https://github.com/kevinboss/chapter-review/releases) there.
The skill runs from its own folder with no install or build step and requires
`git` and Node.js 22.18 or newer on `PATH`.

Registering the MCP server is optional; the skill works without it:

```bash
claude mcp add --scope user chapter-review -- node <path>/mcp.ts
```

## Pre-releases

Every push to `main` that passes CI publishes a pre-release build to the
Marketplace. Open the extension's Marketplace page in VS Code and select
"Switch to Pre-Release Version" to use it, or "Switch to Release Version" to
return to stable releases.
