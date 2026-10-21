// Findings on a file the branch left wrong without changing it: anchored by path
// and line outside the diff, filed under the chapter of the change that caused
// them, and carried across regeneration. Drives the CLI against throwaway repos.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cli, draft, type TestRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

const outside = (repo: TestRepo, ...extra: string[]): ReturnType<typeof cli> =>
  cli(
    ["issue", "add", "--path", "doc.md", "--line", "3", "--severity", "low", "--note", "doc still says b1", ...extra],
    { cwd: repo.dir }
  );

const write = (repo: TestRepo, chapters: Chapter[]): ReturnType<typeof cli> =>
  cli(["write"], { cwd: repo.dir, input: draft(repo, chapters) });

test("a finding outside the diff takes its chapter from its cause", () => {
  withWrittenRepo((repo) => {
    const r = outside(repo, "--cause-path", "b.txt");
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Added iss-2\.1 \(low, suspected\) on doc\.md:3 in ch-2\./);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { path: issue.path, line: issue.line, cause: issue.cause, chapterId: issue.chapterId },
      { path: "doc.md", line: 3, cause: { path: "b.txt" }, chapterId: "ch-2" }
    );
    const list = cli(["issue", "list"], { cwd: repo.dir });
    assert.match(list.out, /iss-2\.1 .* doc\.md:3 \(ch-2, outside the diff, caused by b\.txt\)/);
  });
});

test("a cause hunk picks between the chapters splitting its file", () => {
  withWrittenRepo((repo) => {
    const top = outside(repo, "--cause-path", "a.txt", "--cause-hunk", "2,1,2,1");
    const bottom = outside(repo, "--cause-path", "a.txt", "--cause-hunk", "5,1,5,1");
    assert.match(top.out, /iss-1\.1 .* in ch-1\./);
    assert.match(bottom.out, /iss-2\.1 .* in ch-2\./);
    const list = cli(["issue", "list"], { cwd: repo.dir });
    assert.match(list.out, /caused by a\.txt @@ -2,1 \+2,1 @@/);
  });
});

test("without a cause, a finding outside the diff has no chapter", () => {
  withWrittenRepo((repo) => {
    const r = outside(repo);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Added iss-0\.1 .* on doc\.md:3\./);
    const list = cli(["issue", "list"], { cwd: repo.dir });
    assert.match(list.out, /doc\.md:3 \(no chapter, outside the diff\)/);
  });
});

test("a finding outside the diff is refused when it points at nothing", () => {
  withWrittenRepo((repo) => {
    const add = (...args: string[]): string =>
      cli(["issue", "add", "--severity", "low", "--note", "n", ...args], { cwd: repo.dir }).err;
    assert.match(add("--path", "doc.md", "--line", "9"), /doc\.md has 3 lines/);
    assert.match(add("--path", "nope.md", "--line", "1"), /nope\.md does not exist at/);
    assert.match(add("--path", "doc.md", "--line", "1", "--hunk", "1,1,1,1"), /no change for --hunk or --old-path/);
    assert.match(add("--path", "doc.md", "--line", "0"), /--line must be a line number from 1/);
    assert.match(add("--path", "b.txt", "--cause-path", "a.txt"), /--cause-path is for a finding on a file the branch does not change/);
    assert.match(add("--path", "doc.md", "--line", "1", "--chapter", "ch-1"), /takes its chapter from --cause-path/);
    assert.match(add("--path", "doc.md", "--line", "1", "--cause-hunk", "1,1,1,1"), /--cause-hunk needs --cause-path/);
    assert.match(add("--path", "doc.md", "--line", "1", "--cause-path", "doc.md"), /--cause-path "doc\.md" is not in the current manifest/);
    assert.match(add("--path", "doc.md"), /takes --line/);
    assert.equal(repo.readManifest().issues, undefined, "nothing refused may be written");
  });
});

test("set moves a finding into the diff and back out", () => {
  withWrittenRepo((repo) => {
    outside(repo, "--cause-path", "b.txt");
    const inside = cli(["issue", "set", "iss-2.1", "--path", "a.txt", "--hunk", "2,1,2,1"], { cwd: repo.dir });
    assert.equal(inside.code, 0, inside.all);
    assert.match(inside.out, /It is now iss-1\.1/);
    assert.match(inside.out, /Its line was cleared/);
    const [moved] = repo.readManifest().issues ?? [];
    assert.equal(moved.line, undefined);
    assert.equal(moved.cause, undefined);
    assert.equal(moved.chapterId, "ch-1");

    const back = cli(
      ["issue", "set", "iss-1.1", "--path", "doc.md", "--line", "1", "--cause-path", "b.txt"],
      { cwd: repo.dir }
    );
    assert.equal(back.code, 0, back.all);
    assert.match(back.out, /It is now iss-2\.2/);
    const [returned] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { line: returned.line, hunk: returned.hunk, cause: returned.cause, chapterId: returned.chapterId },
      { line: 1, hunk: undefined, cause: { path: "b.txt" }, chapterId: "ch-2" }
    );
  });
});

test("write keeps a finding outside the diff and re-reads its chapter off the cause", () => {
  withWrittenRepo((repo) => {
    outside(repo, "--cause-path", "b.txt");
    const r = write(repo, [
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
    ]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /renumbered iss-2\.1 -> iss-1\.1 \(ch-1\)/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { id: issue.id, path: issue.path, line: issue.line, cause: issue.cause },
      { id: "iss-1.1", path: "doc.md", line: 3, cause: { path: "b.txt" } }
    );
  });
});

test("once the branch changes the file, the finding becomes an ordinary one on it", () => {
  withWrittenRepo((repo) => {
    outside(repo, "--cause-path", "b.txt");
    writeFileSync(path.join(repo.dir, "doc.md"), "# Doc\n\nb.txt says B1.\n");
    repo.git("commit", "-qam", "fix the doc");
    const r = write(repo, [
      {
        id: "ch-1",
        title: "edit a top",
        files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }],
      },
      {
        id: "ch-2",
        title: "edit a bottom, b and the doc",
        files: [
          { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] },
          { path: "b.txt", status: "modified" },
          { path: "doc.md", status: "modified" },
        ],
      },
    ]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 finding outside the diff on a file the branch now changes/);
    assert.match(r.out, /iss-2\.1: doc\.md/);
    assert.match(r.out, /1 finding whose own line was edited since/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { path: issue.path, line: issue.line, cause: issue.cause, chapterId: issue.chapterId },
      { path: "doc.md", line: 3, cause: undefined, chapterId: "ch-2" }
    );
  });
});

test("a cause that leaves the diff leaves the finding with no chapter", () => {
  withWrittenRepo((repo) => {
    outside(repo, "--cause-path", "b.txt");
    writeFileSync(path.join(repo.dir, "b.txt"), "b1\n");
    repo.git("commit", "-qam", "revert b");
    const r = write(repo, [
      {
        id: "ch-1",
        title: "edit a top",
        files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }],
      },
      {
        id: "ch-2",
        title: "edit a bottom",
        files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] }],
      },
    ]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /renumbered iss-2\.1 -> iss-0\.1 \(no chapter\)/);
    assert.match(r.out, /lost its cause iss-0\.1: b\.txt left the diff/);
    const [issue] = repo.readManifest().issues ?? [];
    assert.deepEqual(
      { path: issue.path, line: issue.line, cause: issue.cause, chapterId: issue.chapterId },
      { path: "doc.md", line: 3, cause: undefined, chapterId: undefined }
    );
  });
});
