// End-to-end tests: drive the CLI as a subprocess against throwaway git repos
// and assert exit code, stdout/stderr, and the on-disk manifest. Each test owns
// its own repo and cleans up.

import test from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { cli, draft, makeNonGitDir, makeRepo, OK_CHAPTERS } from "./helpers.ts";
import type { TestRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

/** Run `body(repo)` against a fresh fixture repo, always cleaning up after. */
function withRepo(body: (repo: TestRepo) => void): void {
  const repo = makeRepo();
  try {
    body(repo);
  } finally {
    repo.cleanup();
  }
}

/** A repo with OK_CHAPTERS already installed, ready for issue/uncheck/regen tests. */
function withWrittenRepo(body: (repo: TestRepo) => void): void {
  withRepo((repo) => {
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, `setup write failed: ${r.all}`);
    body(repo);
  });
}

test("write installs a valid partition, worktree stays clean, stderr silent", () => {
  withRepo((repo) => {
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Wrote 2 chapters across 2 files/);
    assert.ok(repo.manifestExists(), "manifest should exist in the git dir");
    assert.ok(repo.clean(), "worktree should be clean after write");
    assert.equal(r.err, "", "a successful command must produce no stderr");
  });
});

test("write re-pins headSha/mergeBase to the working tree", () => {
  withRepo((repo) => {
    // Draft carries a stale-but-real headSha (the merge base); write should
    // overwrite it with live HEAD. It has to be a commit the repo actually has:
    // an unknown sha now means "this draft came from somewhere else" and is
    // refused before re-pinning.
    const bogus = draft(repo, OK_CHAPTERS).replace(repo.headSha, repo.mergeBase);
    const r = cli(["write"], { cwd: repo.dir, input: bogus });
    assert.equal(r.code, 0, r.all);
    assert.equal(repo.readManifest().headSha, repo.headSha);
  });
});

test("write refuses an overlapping partition", () => {
  withRepo((repo) => {
    const overlap: Chapter[] = [
      { id: "ch-1", title: "x", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2 }] }] },
      { id: "ch-2", title: "y", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2 }] }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, overlap) });
    assert.equal(r.code, 1);
    assert.match(r.all, /refused|overlapping/);
  });
});

test("write refuses a draft carrying issues or reviewed", () => {
  withRepo((repo) => {
    const withIssues = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS, { issues: [{ id: "iss-1", path: "b.txt", severity: "low", note: "x" }] }) });
    assert.equal(withIssues.code, 1);
    assert.match(withIssues.err, /partition only/);
    const withReviewed = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS, { reviewed: [{ path: "b.txt", digest: "aa11" }] }) });
    assert.equal(withReviewed.code, 1);
    assert.match(withReviewed.err, /carried forward/);
  });
});

test("issue add defaults to suspected and accepts explicit confidence", () => {
  withWrittenRepo((repo) => {
    const a = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "smell"], { cwd: repo.dir });
    assert.equal(a.code, 0, a.all);
    assert.match(a.out, /\(low, suspected\)/);
    const b = cli(["issue", "add", "--path", "b.txt", "--severity", "high", "--note", "checked", "--confidence", "verified"], { cwd: repo.dir });
    assert.match(b.out, /\(high, verified\)/);
    const list = cli(["issue", "list"], { cwd: repo.dir });
    assert.match(list.out, /\[low\/suspected\/open\]/);
    assert.match(list.out, /\[high\/verified\/open\]/);
  });
});

test("issue add validates flags", () => {
  withWrittenRepo((repo) => {
    assert.match(cli(["issue", "add", "--path", "b.txt", "--severity", "blocker", "--note", "z"], { cwd: repo.dir }).err, /--severity/);
    assert.match(cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "z", "--confidence", "maybe"], { cwd: repo.dir }).err, /--confidence/);
    assert.match(cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "z", "--foo", "1"], { cwd: repo.dir }).err, /unknown flag/);
    assert.match(cli(["issue", "add", "--path", "b.txt", "--severity", "low"], { cwd: repo.dir }).err, /needs --note/);
  });
});

test("issue add on a split path warns and picks the first owner; --hunk disambiguates", () => {
  withWrittenRepo((repo) => {
    const split = cli(["issue", "add", "--path", "a.txt", "--severity", "low", "--note", "which?"], { cwd: repo.dir });
    assert.equal(split.code, 0, split.all);
    assert.match(split.err, /spans ch-1, ch-2/);
    const pick = cli(["issue", "add", "--path", "a.txt", "--severity", "low", "--note", "bottom", "--hunk", "5,1,5,1"], { cwd: repo.dir });
    assert.doesNotMatch(pick.err, /spans/);
    assert.match(pick.out, /in ch-2/);
  });
});

test("issue lifecycle: set / verify / unverify / resolve / reopen / rm", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    assert.match(cli(["issue", "set", "iss-1", "--confidence", "verified"], { cwd: repo.dir }).out, /Updated iss-1/);
    assert.match(cli(["issue", "verify", "iss-1"], { cwd: repo.dir }).out, /Marked iss-1 verified/);
    assert.match(cli(["issue", "unverify", "iss-1"], { cwd: repo.dir }).out, /Marked iss-1 suspected/);
    assert.match(cli(["issue", "resolve", "iss-1"], { cwd: repo.dir }).out, /Resolved iss-1/);
    assert.match(cli(["issue", "reopen", "iss-1"], { cwd: repo.dir }).out, /Reopened iss-1/);
    assert.match(cli(["issue", "rm", "iss-1"], { cwd: repo.dir }).out, /Removed iss-1/);
    assert.doesNotMatch(cli(["issue", "list"], { cwd: repo.dir }).out, /^iss-1\b/m);
  });
});

test("uncheck clears whole-file and single-hunk checkmarks", () => {
  withWrittenRepo((repo) => {
    assert.match(cli(["uncheck"], { cwd: repo.dir }).err, /needs --path/);
    assert.match(cli(["uncheck", "--path", "b.txt"], { cwd: repo.dir }).out, /Nothing to uncheck/);
    repo.writeProgress([
      { path: "b.txt", digest: "aa11" },
      { path: "a.txt", hunk: { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, digest: "bb22" },
    ]);
    assert.match(cli(["uncheck", "--path", "b.txt"], { cwd: repo.dir }).out, /Unchecked b\.txt \(1 unit\)/);
    assert.match(cli(["uncheck", "--path", "a.txt", "--hunk", "2,1,2,1"], { cwd: repo.dir }).out, /Unchecked a\.txt @@.*\(1 unit\)/);
  });
});

test("regeneration keeps chapter ids, preserves issues, carries checkmarks, prunes departed paths", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    repo.writeProgress([
      { path: "b.txt", digest: "cc33" },
      { path: "gone.txt", digest: "ff66" },
    ]);

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /2\/2 chapters kept from last run/);
    assert.match(r.out, /issues preserved/);
    assert.match(r.out, /checkmarks kept/);

    const after = repo.readManifest();
    const reviewed = repo.readProgress();
    assert.ok(reviewed.some((u) => u.path === "b.txt"), "b.txt checkmark should survive");
    assert.ok(!reviewed.some((u) => u.path === "gone.txt"), "gone.txt checkmark should be pruned");
    assert.equal((after.issues ?? []).length, 1);
    assert.ok(
      !Object.hasOwn(after, "reviewed"),
      "the manifest must not carry checkmarks any more"
    );
  });
});

test("an issue command migrates legacy checkmarks instead of dropping them", () => {
  withWrittenRepo((repo) => {
    // The `issue` family rewrites the manifest without going near progress, so
    // it has to rescue checkmarks an older extension left in there. SKILL.md's
    // follow-up flow reaches this with no `write` in between.
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    const legacy = { ...repo.readManifest(), reviewed: [{ path: "b.txt", digest: "ee55" }] };
    repo.writeManifest(legacy);

    const r = cli(["issue", "resolve", "iss-1"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(repo.readProgress(), [{ path: "b.txt", digest: "ee55" }]);
    assert.ok(
      !Object.hasOwn(repo.readManifest(), "reviewed"),
      "the legacy key must be gone from the manifest"
    );
  });
});

test("an unusable progress.json does not outrank legacy checkmarks", () => {
  withWrittenRepo((repo) => {
    const legacy = { ...repo.readManifest(), reviewed: [{ path: "b.txt", digest: "ff66" }] };
    repo.writeManifest(legacy);
    writeFileSync(repo.progressPath, "{{{");

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 checkmarks kept/);
    assert.deepEqual(repo.readProgress(), [{ path: "b.txt", digest: "ff66" }]);
  });
});

test("checkmarks written by an older extension migrate out of the manifest", () => {
  withWrittenRepo((repo) => {
    // An extension predating the split writes `reviewed` into chapters.json.
    // The CLI must still find those checkmarks, and move them on the next write.
    const legacy = { ...repo.readManifest(), reviewed: [{ path: "b.txt", digest: "dd44" }] };
    repo.writeManifest(legacy);
    assert.deepEqual(repo.readProgress(), [], "precondition: no progress.json yet");

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 checkmarks kept/);
    assert.deepEqual(repo.readProgress(), [{ path: "b.txt", digest: "dd44" }]);
    assert.ok(
      !Object.hasOwn(repo.readManifest(), "reviewed"),
      "the legacy key must be gone from the manifest"
    );
  });
});

test("show and base-check", () => {
  withRepo((repo) => {
    const before = cli(["show"], { cwd: repo.dir });
    assert.equal(before.code, 0);
    assert.match(before.err, /no manifest/);
    cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.match(cli(["show"], { cwd: repo.dir }).out, /"version": 1/);
    const bc = cli(["base-check"], { cwd: repo.dir });
    assert.equal(bc.code, 0, bc.all);
    assert.match(bc.out, /"action"/);
  });
});

test("not a git repository: exit 2, our message only, no raw git fatal line", () => {
  const ng = makeNonGitDir();
  try {
    const r = cli(["show"], { cwd: ng.dir });
    assert.equal(r.code, 2);
    assert.match(r.err, /chapter-review: not inside a git repository/);
    assert.doesNotMatch(r.err, /fatal: not a git repository/);
  } finally {
    ng.cleanup();
  }
});

test("unknown command and issue subcommand error with usage", () => {
  withRepo((repo) => {
    const top = cli(["frobnicate"], { cwd: repo.dir });
    assert.equal(top.code, 1);
    assert.match(top.err, /usage: chapter-review/);
    cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.match(cli(["issue", "frob"], { cwd: repo.dir }).err, /unknown issue command/);
  });
});
