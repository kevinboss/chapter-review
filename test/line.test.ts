// Findings pinned to a line of a file in the diff: the line picks the range and
// the chapter, and moves with the code across regeneration. Drives the CLI
// against throwaway repos.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cli, draft, OK_CHAPTERS, type TestRepo, withRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

const add = (repo: TestRepo, ...args: string[]): ReturnType<typeof cli> =>
  cli(["issue", "add", "--severity", "low", "--note", "n", ...args], { cwd: repo.dir });

/** `count` distinct lines of about 60 bytes each. */
const bulk = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1).padStart(6, "0")} ${"x".repeat(44)}`);

/** The fixture branch plus a commit adding `name`, partitioned with it in a chapter of its own. */
function withAddedFile(name: string, text: string, body: (repo: TestRepo) => void): void {
  withRepo((repo) => {
    writeFileSync(path.join(repo.dir, name), text);
    repo.git("add", name);
    repo.git("commit", "-qm", `add ${name}`);
    const chapters: Chapter[] = [
      ...OK_CHAPTERS,
      { id: "ch-3", title: `add ${name}`, files: [{ path: name, status: "added" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, chapters) });
    assert.equal(r.code, 0, `setup write failed: ${r.all}`);
    body(repo);
  });
}

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

test("a line is checked in a file larger than a child process's default output buffer", () => {
  withAddedFile("big.md", bulk(50_000, "line").join("\n") + "\n", (repo) => {
    const r = add(repo, "--path", "big.md", "--line", "50000");
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Added iss-3\.1 .* on big\.md:50000 in ch-3\./);
    assert.match(add(repo, "--path", "big.md", "--line", "50001").err, /big\.md has 50000 lines/);
    const set = cli(["issue", "set", "iss-3.1", "--line", "49999"], { cwd: repo.dir });
    assert.equal(set.code, 0, set.all);
  });
});

test("blank lines at either end of a file count as lines", () => {
  withAddedFile("blank.md", "\n\nmiddle\n\n\n", (repo) => {
    assert.equal(add(repo, "--path", "blank.md", "--line", "5").code, 0);
    assert.match(add(repo, "--path", "blank.md", "--line", "6").err, /blank\.md has 5 lines/);
  });
});

test("a commit under review that is not in the repo is not reported as a missing file", () => {
  withWrittenRepo((repo) => {
    repo.writeManifest({ ...repo.readManifest(), headSha: "0123456789abcdef0123456789abcdef01234567" });
    const r = add(repo, "--path", "doc.md", "--line", "1");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /0123456 is not a commit in this repository/);
    assert.doesNotMatch(r.err, /does not exist/);
  });
});

test("write moves a line through a diff larger than a child process's default output buffer", () => {
  const anchor = "the line the finding is about";
  const before = [...bulk(100, "old"), anchor, ...bulk(20_000, "old")];
  withAddedFile("big.md", before.join("\n") + "\n", (repo) => {
    assert.equal(add(repo, "--path", "big.md", "--line", "101").code, 0);
    const after = ["top1", "top2", ...bulk(100, "new"), anchor, ...bulk(20_000, "new")];
    writeFileSync(path.join(repo.dir, "big.md"), after.join("\n") + "\n");
    repo.git("commit", "-qam", "rewrite big.md");
    const chapters: Chapter[] = [
      { id: "ch-1", title: "rewrite big.md", files: [{ path: "big.md", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, chapters) });
    assert.equal(r.code, 0, r.all);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual({ round: issue.round, line: issue.line }, { round: 2, line: 103 });
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
