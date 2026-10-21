// Review rounds: a write after the head moved partitions only what changed since
// the round before, earlier rounds stay readable with their checkmarks, and the
// commits their diffs are read from stay pinned. Drives the CLI against
// throwaway repos.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cli, draft, parseJsonAs, readJsonAs, type TestRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter, Manifest } from "../.claude/skills/chapter-review/types.ts";

interface Round {
  number: number;
  new: boolean;
  fromSha: string;
  replayConflicts?: string[];
  chapters: { id: string; title: string; rounds: number[]; files: string[] }[];
}

const nextRound = (repo: TestRepo): Round | undefined =>
  parseJsonAs<{ round?: Round }>(cli(["base-check", "main"], { cwd: repo.dir }).out).round;

const roundDir = (repo: TestRepo, n: number): string =>
  path.join(repo.gitDir, "chapter-review", "rounds", String(n));

const pins = (repo: TestRepo): string[] =>
  repo
    .git("for-each-ref", "--format=%(refname:lstrip=3)", "refs/worktree/chapter-review/")
    .split("\n")
    .filter(Boolean);

const commitB = (repo: TestRepo, content: string, message: string): Chapter[] => {
  writeFileSync(path.join(repo.dir, "b.txt"), content);
  repo.git("commit", "-qam", message);
  return [{ id: "ch-2", title: message, files: [{ path: "b.txt", status: "modified" }] }];
};

test("base-check names the round the next write makes", () => {
  withWrittenRepo((repo) => {
    assert.deepEqual(
      (({ number, new: fresh, fromSha }) => ({ number, fresh, fromSha }))(nextRound(repo) ?? { number: 0, new: true, fromSha: "", chapters: [] }),
      { number: 1, fresh: false, fromSha: repo.mergeBase },
      "same head: the same round, re-partitioned"
    );
    commitB(repo, "B2\n", "touch b");
    const round = nextRound(repo);
    assert.equal(round?.number, 2);
    assert.equal(round.new, true);
    assert.equal(round.fromSha, repo.headSha, "round 2 starts where round 1 ended");
    assert.deepEqual(
      round.chapters.map((c) => c.id),
      ["ch-1", "ch-2"],
      "the ids a new round's partition reuses"
    );
  });
});

test("a new round partitions only what changed, and keeps round 1 as it was", () => {
  withWrittenRepo((repo) => {
    repo.writeProgress([{ path: "b.txt", digest: "aa11" }]);
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, commitB(repo, "B2\n", "touch b")) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /round 2: what changed since round 1/);

    const current = repo.readManifest();
    assert.deepEqual(
      { round: current.round, fromSha: current.fromSha, files: current.chapters.flatMap((c) => c.files.map((f) => f.path)) },
      { round: 2, fromSha: repo.headSha, files: ["b.txt"] }
    );
    const round1 = readJsonAs<Manifest>(path.join(roundDir(repo, 1), "chapters.json"));
    assert.deepEqual(
      { round: round1.round, headSha: round1.headSha, chapters: round1.chapters.length, issues: round1.issues },
      { round: 1, headSha: repo.headSha, chapters: 2, issues: undefined }
    );
    assert.deepEqual(readJsonAs<{ reviewed: unknown[] }>(path.join(roundDir(repo, 1), "progress.json")).reviewed, [
      { path: "b.txt", digest: "aa11" },
    ]);
    assert.ok(!existsSync(repo.progressPath), "round 2 starts with no checkmarks");
    const head = repo.git("rev-parse", "HEAD").trim();
    assert.deepEqual(new Set(pins(repo)), new Set([repo.mergeBase, repo.headSha, head]));
  });
});

test("a write refuses a round partitioned against the whole branch", () => {
  withWrittenRepo((repo) => {
    commitB(repo, "B2\n", "touch b");
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, [{ id: "ch-1", title: "all", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] }]) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /a\.txt is claimed but does not appear in the diff/);
    assert.match(r.err, /This is round 2: partition `git diff -M --unified=3 [0-9a-f]+\.\.HEAD`/);
  });
});

test("a finding on a file only round 1 holds is raised and unchecked there", () => {
  withWrittenRepo((repo) => {
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, commitB(repo, "B2\n", "touch b")) }).code, 0);
    const add = cli(["issue", "add", "--path", "a.txt", "--line", "2", "--severity", "low", "--note", "L2"], { cwd: repo.dir });
    assert.equal(add.code, 0, add.all);
    assert.match(add.out, /on a\.txt:2 @@ -2,1 \+2,1 @@ in ch-1 \(round 1\)\./);
    assert.equal(repo.readManifest().issues?.[0].round, 1);
    assert.match(cli(["issue", "list"], { cwd: repo.dir }).out, /\(ch-1, round 1\)/);

    writeFileSync(path.join(roundDir(repo, 1), "progress.json"), JSON.stringify({ version: 1, reviewed: [{ path: "a.txt", digest: "aa11" }] }));
    assert.match(cli(["uncheck", "--path", "a.txt"], { cwd: repo.dir }).out, /Unchecked a\.txt in round 1 \(1 unit\)/);
  });
});

test("a rebase onto a moved base is diffed from the previous head replayed onto it", () => {
  withWrittenRepo((repo) => {
    // main gains a commit, and the branch is rebased onto it with one fix.
    repo.git("checkout", "-q", "main");
    writeFileSync(path.join(repo.dir, "doc.md"), "# Doc\n\nb.txt says b1, still.\n");
    repo.git("commit", "-qam", "base moves on");
    repo.git("checkout", "-q", "-B", "feat", "main");
    writeFileSync(path.join(repo.dir, "a.txt"), "l1\nL2\nl3\nl4\nL5\nl6\n");
    writeFileSync(path.join(repo.dir, "b.txt"), "B2\n");
    repo.git("commit", "-qam", "work, rebased, with a fix to b");

    const round = nextRound(repo);
    assert.equal(round?.number, 2);
    assert.notEqual(round.fromSha, repo.headSha, "the old head carries the old base");
    assert.equal(nextRound(repo)?.fromSha, round.fromSha, "replaying again yields the same commit");
    assert.ok(pins(repo).includes(round.fromSha), "the replayed commit is pinned before the write");
    assert.equal(
      repo.git("diff", "--name-only", round.fromSha, "HEAD").trim(),
      "b.txt",
      "only the author's change, not the base's doc.md"
    );

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, [{ id: "ch-2", title: "fix b", files: [{ path: "b.txt", status: "modified" }] }]) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /round 1's head [0-9a-f]{7} replayed onto the moved base as [0-9a-f]{7}/);
    assert.equal(repo.readManifest().fromSha, round.fromSha);
  });
});

test("a file the replay conflicts on keeps the previous head's version, and says so", () => {
  withWrittenRepo((repo) => {
    // The base rewrites a.txt's first line, next to the branch's own edit on line 2.
    repo.git("checkout", "-q", "main");
    writeFileSync(path.join(repo.dir, "a.txt"), "base1\nl2\nl3\nl4\nl5\nl6\n");
    repo.git("commit", "-qam", "base edits a");
    repo.git("checkout", "-q", "-B", "feat", "main");
    writeFileSync(path.join(repo.dir, "a.txt"), "base1\nL2\nl3\nl4\nL5\nl6\n");
    writeFileSync(path.join(repo.dir, "b.txt"), "B1\n");
    repo.git("commit", "-qam", "work, rebased");

    const round = nextRound(repo);
    assert.deepEqual(round?.replayConflicts, ["a.txt"]);
    assert.equal(repo.git("show", `${round.fromSha}:a.txt`), "l1\nL2\nl3\nl4\nL5\nl6\n");

    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, [{ id: "ch-1", title: "a on the new base", files: [{ path: "a.txt", status: "modified" }] }]) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /did not replay onto it cleanly, so their round diff also shows what the base changed: a\.txt/);
    assert.deepEqual(repo.readManifest().replayConflicts, ["a.txt"]);
  });
});

test("a review of another branch starts at round 1 and drops the earlier rounds", () => {
  withWrittenRepo((repo) => {
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, commitB(repo, "B2\n", "touch b")) }).code, 0);
    assert.ok(existsSync(roundDir(repo, 1)));
    repo.git("checkout", "-q", "-b", "other");
    writeFileSync(path.join(repo.dir, "b.txt"), "B3\n");
    repo.git("commit", "-qam", "diverge");
    const other: Chapter[] = [
      { id: "ch-1", title: "a and b", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] },
    ];
    const r = cli(["write"], { cwd: repo.dir, input: draft(repo, other, { head: "other" }) });
    assert.equal(r.code, 0, r.all);
    assert.equal(repo.readManifest().round, 1);
    assert.ok(!existsSync(path.join(repo.gitDir, "chapter-review", "rounds")));
  });
});
