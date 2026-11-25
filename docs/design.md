# Design decisions

## Every hunk in one place

Each hunk lives in exactly one chapter, or in `unassigned`. A counter such as
"12 of 47 hunks reviewed" then adds up, and no hunk appears twice in the tree.

## Diffed from the merge base

The skill diffs `merge-base(base, HEAD)..HEAD`, so chapters show what the branch
added and leave out whatever `main` gained since. Once the branch moves, the
next review round partitions only what changed since the last one, and earlier
rounds stay readable with their checkmarks.

## Noise goes to quarantine

Lockfiles and other generated or autoformat-only hunks go in `unassigned` with a
`reason`, instead of under a made-up "Misc cleanup" chapter.

## No commit-splitting

This tooling only describes the diff. Rewriting history into one commit per
chapter would be a separate and riskier tool.

## Protocol and contract

Tool state lives under `<git-dir>/chapter-review/` (inside `.git`), so the
working tree and `git status` stay clean. The full procedure, command reference,
and manifest schema live inside the skill directory:

- [SKILL.md](../.claude/skills/chapter-review/SKILL.md) — skill procedure.
- [COMMANDS.md](../.claude/skills/chapter-review/COMMANDS.md) — CLI and MCP
command reference.
- [chapters.schema.json](../.claude/skills/chapter-review/chapters.schema.json)
— draft-07 JSON Schema for `chapters.json`.
- [validate.ts](../.claude/skills/chapter-review/validate.ts) — zero-dependency
validator, authoritative where it and the schema differ.
- [example-chapters.json](../.claude/skills/chapter-review/example-chapters.json)
— worked manifest example.
