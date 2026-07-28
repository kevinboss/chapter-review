// Review checkmarks and regeneration: what survives a rewrite of the partition,
// what is pruned, and how the CLI behaves when its own state is damaged. Drives
// the CLI as a subprocess against throwaway git repos.

import test from "node:test";
import { writeFileSync } from "node:fs";
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
    assert.match(r.err, /not in the current manifest/);
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

test("a rename carries findings and checkmarks to the new path", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    repo.writeProgress([{ path: "b.txt", digest: "cc33" }]);

    // Carry-forward matched the path string alone, so `git mv` read as a
    // deletion and destroyed the file's finding and every checkmark on it.
    // A pure rename: b.txt is one line, so -M only reports R100 when the content
    // is identical to the merge-base side. With an edit on top of it git calls a
    // file this small a delete plus an add, and there is no rename to follow.
    repo.git("mv", "b.txt", "c.txt");
    writeFileSync(`${repo.dir}/c.txt`, "b1\n");
    repo.git("commit", "-am", "rename b to c");
    const renamed: Chapter[] = [
      OK_CHAPTERS[0],
      {
        id: "ch-2",
        title: "edit a bottom + rename b",
        files: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] },
          { path: "c.txt", status: "renamed", oldPath: "b.txt" },
        ],
      },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, renamed) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /followed rename iss-1: b\.txt -> c\.txt/);
    assert.doesNotMatch(r.out, /pruned/);

    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.path, "c.txt", "the finding must follow the rename");
    assert.equal(issue.chapterId, "ch-2");
    assert.deepEqual(repo.readProgress(), [{ path: "c.txt", digest: "cc33" }]);
  });
});

test("a finding's hunk is re-keyed onto the range that now covers it", () => {
  withWrittenRepo((repo) => {
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "5,1,5,1", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    // Insert above, so the same content sits two lines further down.
    writeFileSync(`${repo.dir}/a.txt`, "top1\ntop2\nl1\nL2\nl3\nl4\nL5\nl6\n");
    repo.git("commit", "-am", "prepend two lines");

    const shifted: Chapter[] = [
      { id: "ch-1", title: "edit a top", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }] }] },
      {
        id: "ch-2",
        title: "edit a bottom + b",
        files: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 7, newLines: 1 }] },
          { path: "b.txt", status: "modified" },
        ],
      },
    ];
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, shifted) }).code, 0);

    // Left alone, a stale anchor never self-corrects: nothing else rewrites it,
    // so it survives every later regeneration pointing at the wrong lines.
    const { hunk } = repo.readManifest().issues?.[0] ?? {};
    assert.deepEqual(hunk, { oldStart: 5, oldLines: 1, newStart: 7, newLines: 1 });
  });
});

test("a second rename still carries the finding, via the merge-base name", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "keep me"], { cwd: repo.dir });
    repo.writeProgress([{ path: "b.txt", digest: "cc33" }]);

    const renameTo = (name: string, from: string): void => {
      repo.git("mv", from, name);
      repo.git("commit", "-am", `rename to ${name}`);
    };
    const chaptersWith = (path: string): Chapter[] => [
      OK_CHAPTERS[0],
      {
        id: "ch-2",
        title: "edit a bottom + rename b",
        files: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] },
          { path, status: "renamed", oldPath: "b.txt" },
        ],
      },
    ];

    writeFileSync(`${repo.dir}/b.txt`, "b1\n"); // identical content, so -M reports R100
    repo.git("commit", "-am", "restore b content");
    renameTo("c.txt", "b.txt");
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, chaptersWith("c.txt")) }).code, 0);
    assert.equal(repo.readManifest().issues?.[0].path, "c.txt");

    // git diffs against the merge base, so after a second move it reports
    // b.txt -> d.txt and the intermediate c.txt never appears. Matching the
    // stored path alone lost the file here.
    renameTo("d.txt", "c.txt");
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, chaptersWith("d.txt")) });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /pruned/);
    assert.equal(repo.readManifest().issues?.[0].path, "d.txt", "the finding must survive a second rename");
    assert.deepEqual(repo.readProgress(), [{ path: "d.txt", digest: "cc33" }]);
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

test("a path that genuinely leaves the diff is still pruned", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "drop me"], { cwd: repo.dir });
    // Put b.txt back to its base content, so it drops out of mergeBase..HEAD.
    writeFileSync(`${repo.dir}/b.txt`, "b1\n");
    repo.git("commit", "-am", "revert b");
    const withoutB: Chapter[] = [OK_CHAPTERS[0], { ...OK_CHAPTERS[1], files: [OK_CHAPTERS[1].files[0]] }];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, withoutB) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /pruned 1 \(iss-1\)/);
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
