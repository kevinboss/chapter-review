// Findings pinned to a line of a file in the diff: the line picks the range and
// the chapter, and moves with the code across regeneration. Drives the CLI
// against throwaway repos.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cli, draft, type TestRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

const add = (repo: TestRepo, ...args: string[]): ReturnType<typeof cli> =>
  cli(["issue", "add", "--severity", "low", "--note", "n", ...args], { cwd: repo.dir });

// a.txt gains two lines on top, so L5 now sits on line 7. The partition is round
// 2's, which holds only what this commit changed.
const prepended = (repo: TestRepo, bottom = "L5"): Chapter[] => {
  writeFileSync(path.join(repo.dir, "a.txt"), `top1\ntop2\nl1\nL2\nl3\nl4\n${bottom}\nl6\n`);
  repo.git("commit", "-qam", "prepend to a");
  return [{ id: "ch-2", title: "prepend to a", files: [{ path: "a.txt", status: "modified" }] }];
};

test("a line in the diff picks the range holding it, and that range's chapter", () => {
  withWrittenRepo((repo) => {
    const r = add(repo, "--path", "a.txt", "--line", "5");
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Added iss-2\.1 .* on a\.txt:5 @@ -5,1 \+5,1 @@ in ch-2\./);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { line: issue.line, hunk: issue.hunk, chapterId: issue.chapterId },
      { line: 5, hunk: { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }, chapterId: "ch-2" }
    );
  });
});

test("a line on a file claimed whole is kept without a range", () => {
  withWrittenRepo((repo) => {
    const r = add(repo, "--path", "b.txt", "--line", "1");
    assert.equal(r.code, 0, r.all);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual({ line: issue.line, hunk: issue.hunk, chapterId: issue.chapterId }, { line: 1, hunk: undefined, chapterId: "ch-2" });
  });
});

test("an unchanged line of a split file says its chapter was guessed", () => {
  withWrittenRepo((repo) => {
    const r = add(repo, "--path", "a.txt", "--line", "1");
    assert.equal(r.code, 0, r.all);
    assert.match(r.err, /no range of it holds line 1\. pass --chapter to choose/);
  });
});

test("a line in a range unassigned claims belongs to no chapter", () => {
  withWrittenRepo((repo) => {
    const quarantined: Chapter[] = [
      { id: "ch-1", title: "edit a top", files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }] },
      { id: "ch-2", title: "edit b", files: [{ path: "b.txt", status: "modified" }] },
    ];
    const unassigned = [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }], reason: "noise" }];
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, quarantined, { unassigned }) }).code, 0);
    const r = add(repo, "--path", "a.txt", "--line", "5");
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Added iss-0\.1 .* on a\.txt:5 @@ -5,1 \+5,1 @@\./);
    assert.match(r.err, /a\.txt is quarantined as noise/);
  });
});

test("a line must exist and sit inside a --hunk given with it", () => {
  withWrittenRepo((repo) => {
    assert.match(add(repo, "--path", "a.txt", "--line", "9").err, /a\.txt has 6 lines/);
    assert.match(add(repo, "--path", "a.txt", "--line", "2", "--hunk", "5,1,5,1").err, /--line 2 is not inside @@ -5,1 \+5,1 @@/);
    assert.equal(repo.readManifest().issues, undefined, "nothing refused may be written");
  });
});

test("set --line re-picks the range and re-homes the finding", () => {
  withWrittenRepo((repo) => {
    add(repo, "--path", "a.txt", "--line", "5");
    const r = cli(["issue", "set", "iss-2.1", "--line", "2"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /It is now iss-1\.1/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(issue.hunk, { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 });
  });
});

test("write moves a line with the code around it", () => {
  withWrittenRepo((repo) => {
    add(repo, "--path", "a.txt", "--line", "5");
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, prepended(repo)) });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /edited since/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { round: issue.round, line: issue.line, hunk: issue.hunk, chapterId: issue.chapterId },
      { round: 2, line: 7, hunk: undefined, chapterId: "ch-2" }
    );
  });
});

test("write says when a finding's own line was removed, apart from edited ones", () => {
  withWrittenRepo((repo) => {
    add(repo, "--path", "a.txt", "--line", "5");
    writeFileSync(path.join(repo.dir, "a.txt"), "l1\nL2\nl3\nl4\nl6\n");
    repo.git("commit", "-qam", "drop L5");
    const whole: Chapter[] = [
      { id: "ch-1", title: "drop L5", files: [{ path: "a.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, whole) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 finding whose own line was removed:\n {4}iss-1\.1: a\.txt:5, now a gap between lines 4 and 5/);
    assert.doesNotMatch(r.out, /edited since/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.equal(issue.line, undefined, "the line beside the gap is not what the note is about");
  });
});

test("a resolved finding's moved line is not reported", () => {
  withWrittenRepo((repo) => {
    add(repo, "--path", "a.txt", "--line", "5");
    cli(["issue", "resolve", "iss-2.1"], { cwd: repo.dir });
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, prepended(repo, "L5 fixed")) });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /edited since/);
  });
});

test("write says when a finding's own line was edited", () => {
  withWrittenRepo((repo) => {
    add(repo, "--path", "a.txt", "--line", "5");
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, prepended(repo, "L5 fixed")) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 finding whose own line was edited since \(old line -> its replacement, where the finding now sits\):\n {4}iss-2\.1: a\.txt:5 -> 7/);
  });
});
