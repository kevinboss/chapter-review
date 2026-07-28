// `write` and the top-level command surface: installing a draft, refusing an
// invalid or foreign one, checking the partition against the real diff, and the
// commit pin. Drives the CLI as a subprocess against throwaway git repos.

import test from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { cli, draft, makeNonGitDir, OK_CHAPTERS, withRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

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

test("write re-pins a HEAD-relative head to the real branch", () => {
  withRepo((repo) => {
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS, { head: "@" }) });
    assert.equal(r.code, 0, r.all);
    // "@" is accepted here only because headSha matches; stored verbatim it
    // would show up as the branch name in the extension.
    assert.equal(repo.readManifest().head, "feat");
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

// ---- coverage: the partition against the real diff --------------------------

test("write refuses a partition that leaves a file unclaimed", () => {
  withRepo((repo) => {
    // The structural pass sees a double claim but not a missing one, so this
    // shipped a review with changes absent from every chapter, looking complete.
    const gap: Chapter[] = [{ id: "ch-1", title: "just a", files: [{ path: "a.txt", status: "modified" }] }];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, gap) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /the partition does not match the diff/);
    assert.match(r.err, /b\.txt is in the diff but no chapter or unassigned entry claims it/);
    assert.ok(!repo.manifestExists(), "a refused write must install nothing");
  });
});

test("write refuses a partition that leaves one hunk of a file unclaimed", () => {
  withRepo((repo) => {
    // a.txt's two edits are three lines apart, so --unified=3 emits them as one
    // hunk. A genuinely two-hunk file needs its changes far apart, and it has to
    // exist at the merge base, so it goes on main first.
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    repo.git("checkout", "main");
    writeFileSync(`${repo.dir}/big.txt`, lines);
    repo.git("add", "-A");
    repo.git("commit", "-m", "add big.txt");
    repo.git("checkout", "feat");
    repo.git("merge", "main", "--no-edit");
    writeFileSync(
      `${repo.dir}/big.txt`,
      lines.replace("line 2\n", "LINE 2\n").replace("line 35\n", "LINE 35\n")
    );
    repo.git("commit", "-am", "edit big.txt top and bottom");

    const partial: Chapter[] = [
      ...OK_CHAPTERS,
      {
        id: "ch-3",
        title: "only the top of big",
        files: [{ path: "big.txt", status: "modified", hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5 }] }],
      },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, partial) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /big\.txt @@ -\d+,\d+ \+\d+,\d+ @@ is in the diff but unclaimed/);
  });
});

test("write refuses a hunk coordinate that is a line out", () => {
  withRepo((repo) => {
    // a.txt's diff is one hunk covering both edits; claiming from line 3 still
    // overlaps it, so an overlap test reads the draft as complete and writes the
    // wrong number through to the extension, which renders from exactly these.
    const offByOne: Chapter[] = [
      { id: "ch-1", title: "off by one", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }, { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] }] },
      { id: "ch-2", title: "b", files: [{ path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, offByOne) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /a\.txt @@ .* is only partly claimed: old line 2 is changed here but falls in no claimed range/);
  });
});

test("a sub-hunk split of one merged hunk is still accepted", () => {
  withRepo((repo) => {
    // git merges a.txt's two edits into one hunk, so these ranges match no `@@`
    // header. Splitting them across chapters is legitimate and must stay so:
    // exact-header matching would refuse this.
    const split: Chapter[] = [
      { id: "ch-1", title: "top edit", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }] },
      { id: "ch-2", title: "bottom edit + b", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] }, { path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, split) });
    assert.equal(r.code, 0, r.all);
  });
});

test("write refuses a symbolic headSha, which vouches for any tree", () => {
  withRepo((repo) => {
    // "HEAD" resolves to whatever tree you are standing in, so accepting it as
    // proof let a draft from another repo install here — the wrong-directory
    // footgun the belongs-here check exists to stop.
    const r = cli(["write"], {
      cwd: repo.dir,
      input: draft(repo, OK_CHAPTERS, { headSha: "HEAD", head: "somewhere-else" }),
    });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /headSha "HEAD" is not a commit id/);
    assert.ok(!repo.manifestExists(), "a refused write must install nothing");
  });
});

test("write names a chapter that disappeared", () => {
  withWrittenRepo((repo) => {
    const merged: Chapter[] = [
      { id: "ch-1", title: "everything", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, merged) });
    assert.equal(r.code, 0, r.all);
    // Only the kept/total ratio moved before; nothing named the chapter that went.
    assert.match(r.out, /dropped ch-2/);
  });
});

test("write refuses a status the diff contradicts", () => {
  withRepo((repo) => {
    // The extension gives an "added" entry an empty left-hand side, so a
    // modified file mislabelled that way renders with its before-diff missing.
    const mislabelled: Chapter[] = [
      { id: "ch-1", title: "wrong status", files: [{ path: "a.txt", status: "added" }] },
      { id: "ch-2", title: "b", files: [{ path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, mislabelled) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /a\.txt is claimed as "added" but the diff has it as "modified"/);
  });
});

test("write refuses a claim the diff does not have", () => {
  withRepo((repo) => {
    const phantom: Chapter[] = [
      { id: "ch-1", title: "phantom range", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }, { oldStart: 90, oldLines: 2, newStart: 90, newLines: 2 }] }] },
      { id: "ch-2", title: "b", files: [{ path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, phantom) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /a\.txt claims @@ -90,2 \+90,2 @@, which the diff does not have/);
  });
});

test("write refuses a path that is not in the diff at all", () => {
  withRepo((repo) => {
    const extra: Chapter[] = [
      ...OK_CHAPTERS,
      { id: "ch-3", title: "ghost", files: [{ path: "ghost.txt", status: "added" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, extra) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /ghost\.txt is claimed but does not appear in the diff/);
  });
});

test("a whole-file claim covers every hunk of that file", () => {
  withRepo((repo) => {
    // a.txt has two hunks; claiming it without `hunks` takes both, so coverage
    // must not demand they be enumerated.
    const whole: Chapter[] = [
      { id: "ch-1", title: "all of a and b", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, whole) });
    assert.equal(r.code, 0, r.all);
  });
});

test("a hunk quarantined in unassigned counts as claimed", () => {
  withRepo((repo) => {
    const split: Chapter[] = [
      { id: "ch-1", title: "edit a top", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }] },
      { id: "ch-2", title: "b", files: [{ path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], {
      cwd: repo.dir,
      input: draft(repo, split, {
        unassigned: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }], reason: "autoformat" },
        ],
      }),
    });
    assert.equal(r.code, 0, r.all);
  });
});

// ---- reading commands and the command surface ------------------------------

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
    const bad = cli(["issue", "frob"], { cwd: repo.dir });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown issue command/);
    assert.match(bad.err, /usage: chapter-review issue/, "an unknown subcommand must show the subcommand usage");
  });
});
