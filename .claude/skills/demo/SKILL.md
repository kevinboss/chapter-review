---
name: demo
description: Rebuild the C# demo repo, generate its chapters.json via the chapter-review skill in a sub-agent, and launch the extension dev host on it. Use when the user wants a fresh end-to-end demo run of chapter-review.
---

# Demo run

End-to-end demo: fresh demo repo → skill-generated manifest → extension dev host. Repo root is the directory containing this `.claude/` folder; all paths below are relative to it.

## Steps

1. **Rebuild the demo repo.** `node scripts/make-demo.mjs`. This recreates `demo/` (before/after C# fixture commits on `main` and `feat/queue-notifications`) without a manifest.

2. **Generate the manifest in a sub-agent.** Spawn a general-purpose sub-agent with `model: opus` (deliberate: matches what most devs run, so demo output reflects real-world skill quality) so the diff and JSON never enter the main context. Instruct it to:
   - Overwrite any existing `demo/.git/chapter-review/chapters.json` without reading it first — a previous run must not anchor the partition.
   - Follow `.claude/skills/chapter-review/SKILL.md` literally against the `demo/` repo (default branch `main`, no origin remote).
   - Read `.claude/skills/chapter-review/chapters.schema.json` for field semantics before writing.
   - Write `demo/.git/chapter-review/chapters.json` and run `node .claude/skills/chapter-review/validate.mjs demo/.git/chapter-review/chapters.json` until it passes.
   - Return only: the skill's one-line summary, the chapter list (id, title, file count), unassigned entries with reasons, and a FRICTION section listing anything ambiguous or wrong in the skill instructions (or "none"). No diff, no JSON, in the reply.

3. **Verify from the outside.** Run `node .claude/skills/chapter-review/validate.mjs demo/.git/chapter-review/chapters.json` yourself; do not trust the sub-agent's claim alone.

4. **Launch the dev host.** `code --new-window --extensionDevelopmentPath="<repo-root>/extension" "<repo-root>/demo"` (build first via `npm run build` in `extension/` if `extension/out/extension.js` or `extension/skill/` is missing). Tell the user: click the "Chapter Review" icon in the activity bar → "Chapters" view.

5. **Report.** Relay the chapter list and any FRICTION findings — those drive edits to the chapter-review skill. If the run surfaced skill-prompt gaps, propose the fix instead of just noting it.

## Notes

- Review progress in the dev host is keyed by hunk coordinates, so it survives rebuilds as long as the fixture diff is unchanged.
- `node scripts/make-demo.mjs --manifest` writes a scripted reference manifest instead; useful to compare against the skill's output.
