// Review checkmarks and regeneration: what survives a rewrite of the partition,
// what is pruned, and how the CLI behaves when its own state is damaged. Drives
// the CLI as a subprocess against throwaway git repos.

import test from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { cli, draft, OK_CHAPTERS, readJsonAs, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

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

test("uncheck refuses a path that is not in the manifest", () => {
  withWrittenRepo((repo) => {
    const r = cli(["uncheck", "--path", "nope.txt"], { cwd: repo.dir });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /is in no round's diff/);
  });
});

// ---- regeneration -----------------------------------------------------------

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
    assert.match(r.out, /1 checkmarks carried/);
    assert.match(r.out, /1 checkmarks dropped \(path left the diff\)/);

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

test("a new round follows a rename, and round 1 keeps its checkmarks", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    repo.writeProgress([{ path: "b.txt", digest: "cc33" }]);

    // Carry-forward matched the path string alone, so `git mv` read as a
    // deletion and destroyed the file's finding. A pure rename, since git calls
    // a one-line file with an edit on top a delete plus an add.
    repo.git("mv", "b.txt", "c.txt");
    repo.git("commit", "-am", "rename b to c");
    const renamed: Chapter[] = [
      { id: "ch-2", title: "rename b", files: [{ path: "c.txt", status: "renamed", oldPath: "b.txt" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, renamed) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /followed rename iss-2\.1: b\.txt -> c\.txt/);
    assert.doesNotMatch(r.out, /renumbered/);

    const issue = repo.readManifest().issues?.[0];
    assert.deepEqual(
      { path: issue?.path, round: issue?.round, chapterId: issue?.chapterId },
      { path: "c.txt", round: 2, chapterId: "ch-2" }
    );
    assert.deepEqual(repo.readProgress(), [], "a new round starts unticked");
    assert.deepEqual(
      readJsonAs<{ reviewed: unknown[] }>(path.join(repo.gitDir, "chapter-review", "rounds", "1", "progress.json")).reviewed,
      [{ path: "b.txt", digest: "cc33" }]
    );
  });
});

test("a finding pinned to a range is found again in the new round", () => {
  withWrittenRepo((repo) => {
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "5,1,5,1", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    // Two lines on top and an edit to L5: one hunk in the round's diff.
    writeFileSync(`${repo.dir}/a.txt`, "top1\ntop2\nl1\nL2\nl3\nl4\nL5!\nl6\n");
    repo.git("commit", "-am", "prepend two lines, touch L5");

    const round2: Chapter[] = [
      { id: "ch-2", title: "touch L5", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 8 }] }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, round2) });
    assert.equal(r.code, 0, r.all);

    // Round 1's coordinates mean nothing against round 2's diff, so the range is
    // found through where its first line went.
    const { hunk, round } = repo.readManifest().issues?.[0] ?? {};
    assert.deepEqual({ hunk, round }, { hunk: { oldStart: 1, oldLines: 6, newStart: 1, newLines: 8 }, round: 2 });
  });
});

test("a re-partition that re-homes a finding renumbers it, and says so", () => {
  withWrittenRepo((repo) => {
    // b.txt starts in ch-2, so the finding on it is iss-2.1.
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    assert.equal(repo.readManifest().issues?.[0].id, "iss-2.1");

    // Same diff, b.txt regrouped under ch-1. The finding goes with it, and its
    // number counts in ch-1's sequence: an iss-2.1 under chapter one is the
    // mismatch chapter-scoped ids exist to rule out.
    const regrouped: Chapter[] = [
      {
        id: "ch-1",
        title: "edit a top + b",
        files: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] },
          { path: "b.txt", status: "modified" },
        ],
      },
      {
        id: "ch-2",
        title: "edit a bottom",
        files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] }],
      },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, regrouped) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /renumbered iss-2\.1 -> iss-1\.1 \(ch-1\)/);

    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.id, "iss-1.1");
    assert.equal(issue.chapterId, "ch-1");
    // Both numbers stay retired: the vacated one may be quoted in a PR comment.
    assert.deepEqual(repo.readManifest().issueSeq, { "1": 1, "2": 1 });
    const next = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "another"], { cwd: repo.dir });
    assert.match(next.out, /Added iss-1\.2\b/);
  });
});

test("a finding whose path is quarantined moves into the chapter-0 sequence", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    assert.equal(repo.readManifest().issues?.[0].id, "iss-2.1");

    // b.txt is re-read as noise, so no chapter owns the finding any more. It is
    // renumbered into the sequence the extension shows under its Issues row.
    const quarantined: Chapter[] = [
      OK_CHAPTERS[0],
      { ...OK_CHAPTERS[1], files: [OK_CHAPTERS[1].files[0]] },
    ];
    const r = cli(["write"], {
      cwd: repo.dir,
      input: draft(repo, quarantined, {
        unassigned: [{ path: "b.txt", status: "modified", reason: "generated" }],
      }),
    });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /renumbered iss-2\.1 -> iss-0\.1 \(no chapter\)/);

    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.id, "iss-0.1");
    assert.ok(!Object.hasOwn(issue, "chapterId"), "no chapter owns a quarantined path");
  });
});

test("a finding follows a file renamed again in each round", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });

    const renameTo = (name: string, from: string): ReturnType<typeof cli> => {
      repo.git("mv", from, name);
      repo.git("commit", "-am", `rename to ${name}`);
      const chapters: Chapter[] = [
        { id: "ch-2", title: `rename to ${name}`, files: [{ path: name, status: "renamed", oldPath: from }] },
      ];
      return cli(["write"], { cwd: repo.dir, input: draft(repo, chapters) });
    };

    assert.equal(renameTo("c.txt", "b.txt").code, 0);
    assert.equal(repo.readManifest().issues?.[0].path, "c.txt");
    const r = renameTo("d.txt", "c.txt");
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /pruned/);
    const issue = repo.readManifest().issues?.[0];
    assert.deepEqual({ path: issue?.path, round: issue?.round }, { path: "d.txt", round: 3 });
  });
});

test("write refuses a branch with nothing to review", () => {
  withWrittenRepo((repo) => {
    repo.git("checkout", "-b", "level-with-main", "main");
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS, { head: "level-with-main" }) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /has no changes against main, so there is nothing to partition/);
    // The empty partition used to install, wiping the real review it replaced.
    assert.equal(repo.readManifest().chapters.length, 2);
  });
});

test("write says whose review it is replacing when the branch changed", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    repo.git("checkout", "-b", "other");
    writeFileSync(`${repo.dir}/b.txt`, "B1 changed\n");
    repo.git("commit", "-am", "diverge");
    const other: Chapter[] = [
      { id: "ch-1", title: "a and b", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, other, { head: "other" }) });
    assert.equal(r.code, 0, r.all);
    // One manifest per repo, so this is legitimate but it took the old one with it.
    assert.match(r.err, /replaces the review of "feat" \(2 chapters, 1 findings\)/);
  });
});

test("a round that reverts a file takes its open finding along to the revert", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "drop me"], { cwd: repo.dir });
    // Back to its base content: out of the branch, but in what round 2 changed.
    writeFileSync(`${repo.dir}/b.txt`, "b1\n");
    repo.git("commit", "-am", "revert b");
    const round2: Chapter[] = [{ id: "ch-2", title: "revert b", files: [{ path: "b.txt", status: "modified" }] }];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, round2) });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /pruned/);
    assert.equal(repo.readManifest().issues?.[0].round, 2);
  });
});

// ---- recovering -------------------------------------------------------------

test("an unreadable progress.json is replaced, not left broken", () => {
  withWrittenRepo((repo) => {
    writeFileSync(repo.progressPath, "{ not json !!");
    const r = cli(["uncheck", "--path", "b.txt"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.err, /unreadable, so every checkmark it held is lost; replacing it/);
    // Left in place, the bad bytes made every later run repeat the warning and
    // handed the extension a file it could not write into either.
    assert.deepEqual(repo.readProgress(), []);
    assert.doesNotMatch(cli(["uncheck", "--path", "b.txt"], { cwd: repo.dir }).err, /unreadable/);
  });
});

test("a corrupt manifest does not overwrite the backup, and is recovered from it", () => {
  withWrittenRepo((repo) => {
    // The backup trails by one write, so two adds are needed for it to hold a
    // finding at the moment of corruption.
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "precious"], { cwd: repo.dir });
    cli(["issue", "add", "--path", "a.txt", "--severity", "low", "--note", "second"], { cwd: repo.dir });
    const bak = `${repo.manifestPath}.bak`;
    writeFileSync(repo.manifestPath, "{{{ truncated");

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.err, /keeping the previous backup/);
    // The rebuild used to copy the truncated file over the one good backup,
    // destroying the only copy of the findings on the way to restoring them.
    const saved = readJsonAs<{ issues?: { note: string }[] }>(bak);
    assert.equal(saved.issues?.[0].note, "precious");
    // And having kept it, the write carries those findings back in rather than
    // reporting the loss and moving on.
    assert.match(r.err, /carrying findings and checkmarks forward from the backup/);
    assert.match(cli(["issue", "list"], { cwd: repo.dir }).out, /precious/);
  });
});
