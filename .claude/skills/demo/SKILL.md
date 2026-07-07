---
name: demo
description: Rebuild the C# demo repo, generate its chapters.json via the chapter-review skill in a sub-agent, and launch the extension dev host on it. Use when the user wants a fresh end-to-end demo run of chapter-review.
---

# Demo run

End-to-end demo: fresh demo repo → skill-generated manifest → extension dev host. Repo root is the directory containing this `.claude/` folder; all paths below are relative to it.

## Steps

1. **Rebuild the demo repo.** `node scripts/make-demo.mjs`. This recreates `demo/` (before/after C# fixture commits on `main` and `feat/queue-notifications`) without a manifest.

2. **Generate the manifest in a sub-agent.** Spawn a general-purpose sub-agent with `model: opus` (deliberate: matches what most devs run, so demo output reflects real-world skill quality) so the diff and JSON never enter the main context. Instruct it to:
   - Follow `.claude/skills/chapter-review/SKILL.md` against the `demo/` repo: default branch `main`, branch under review `feat/queue-notifications`, no origin remote. The skill is CLI-driven. It builds a partition draft and installs it with `chapter-review write <draft>`, records any findings with `chapter-review issue add`, and never hand-writes `chapters.json` or runs `validate.mjs` itself.
   - **Run the `chapter-review` command with the current directory inside `demo/`.** It resolves its manifest destination from `git rev-parse --absolute-git-dir` at the cwd, so calling it from the outer repo writes into the wrong `.git` (the nested-repo trap the skill warns about). `cd demo` before calling it, use an absolute or skill-relative path to the command itself, and confirm `write`'s printed path is under `demo/.git`.
   - Build the draft fresh from the diff and don't read any existing manifest, so a previous run can't anchor the partition.
   - Read `.claude/skills/chapter-review/chapters.schema.json` for field semantics before building the draft.
   - Return only: the skill's one-line summary, the chapter list (id, title, file count), unassigned entries with reasons, and a FRICTION section listing anything ambiguous or wrong in the skill instructions (or "none"). No diff, no JSON, in the reply.

3. **Verify from the outside.** Run `node .claude/skills/chapter-review/validate.mjs demo/.git/chapter-review/chapters.json` yourself and confirm it passes; do not trust the sub-agent's claim alone. Then confirm the write hit the demo repo, not the outer one (this project keeps its own dogfood manifest at the repo root's `.git/chapter-review/chapters.json`, and a wrong-cwd `chapter-review write` would clobber it): check the path `write` reported is under `demo/.git`, or that the demo manifest's `head` is `feat/queue-notifications`.

4. **Launch the dev host.** `code --new-window --extensionDevelopmentPath="<repo-root>/extension" "<repo-root>/demo"` (build first via `npm run build` in `extension/` if `extension/out/extension.js` or `extension/skill/` is missing). Tell the user: click the "Chapter Review" icon in the activity bar → "Chapters" view.

5. **Report.** Relay the chapter list and any FRICTION findings — those drive edits to the chapter-review skill. If the run surfaced skill-prompt gaps, propose the fix instead of just noting it.

## Notes

- Review progress in the dev host is keyed by hunk coordinates, so it survives rebuilds as long as the fixture diff is unchanged.
- `node scripts/make-demo.mjs --manifest` writes a scripted reference manifest instead; useful to compare against the skill's output.
