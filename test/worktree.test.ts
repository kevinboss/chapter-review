// Worktree reviews: a review of a snapshot of the working tree, one round, that
// parks the branch review it displaces and gives it back once a branch review is
// written again. Drives the CLI against throwaway repos.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cli, draft, parseJsonAs, type TestRepo, withRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

interface Check {
  installed?: string;
  openChanges: number;
  branchCommits?: number;
  parked?: { name: string; head?: string; round?: number; openFindings?: number; branchExists: boolean }[];
  round?: { number: number; new: boolean; mode?: string; fromSha: string; headSha?: string; diff: string; chapters: { id: string }[] };
}

const check = (repo: TestRepo, ...args: string[]): Check =>
  parseJsonAs<Check>(cli(["base-check", "main", ...args], { cwd: repo.dir }).out);

const parkedDir = (repo: TestRepo, name: string): string => path.join(repo.gitDir, "chapter-review-parked", name);

/** Edit a tracked file and add an untracked one, leaving both uncommitted. */
const openChanges = (repo: TestRepo): void => {
  writeFileSync(path.join(repo.dir, "doc.md"), "# Doc\n\nb.txt says B1.\n");
  writeFileSync(path.join(repo.dir, "new.txt"), "n1\n");
};

const OPEN_CHAPTERS: Chapter[] = [
  { id: "ch-1", title: "fix the doc", files: [{ path: "doc.md", status: "modified" }] },
  { id: "ch-2", title: "add new", files: [{ path: "new.txt", status: "added" }] },
];

const worktreeDraft = (repo: TestRepo, round: NonNullable<Check["round"]>, chapters: Chapter[]): string =>
  draft(repo, chapters, { mode: "worktree", headSha: round.headSha, fromSha: round.fromSha });

test("base-check reports open changes, the branch's own commits and what is installed", () => {
  withWrittenRepo((repo) => {
    assert.deepEqual(
      (({ installed, openChanges: open, branchCommits }) => ({ installed, open, branchCommits }))(check(repo)),
      { installed: "branch", open: 0, branchCommits: 1 }
    );
    openChanges(repo);
    assert.equal(check(repo).openChanges, 2, "the untracked file counts too");
  });
});

test("base-check --worktree snapshots the working tree without touching it", () => {
  withRepo((repo) => {
    openChanges(repo);
    repo.git("add", "doc.md");
    const status = repo.git("status", "--porcelain");
    const { round } = check(repo, "--worktree", "open");
    assert.ok(round?.headSha !== undefined, "a worktree round names its snapshot");
    assert.deepEqual(
      { number: round.number, fresh: round.new, mode: round.mode, fromSha: round.fromSha },
      { number: 1, fresh: true, mode: "worktree", fromSha: repo.headSha }
    );
    assert.equal(repo.git("rev-parse", `${round.headSha}^`).trim(), repo.headSha, "the snapshot sits on HEAD");
    assert.equal(repo.git("diff", "--name-only", round.fromSha, round.headSha).trim(), "doc.md\nnew.txt");
    assert.equal(round.diff, `git diff -M --unified=3 ${repo.headSha}..${round.headSha}`);
    assert.equal(repo.git("status", "--porcelain"), status, "the index and the files are as they were");
    assert.equal(check(repo, "--worktree=open").round?.headSha, round.headSha, "the same tree yields the same snapshot");
  });
});

test("--worktree all reviews the branch's commits and the open changes together", () => {
  withRepo((repo) => {
    openChanges(repo);
    const { round } = check(repo, "--worktree", "all");
    assert.equal(round?.fromSha, repo.mergeBase);
    assert.equal(repo.git("diff", "--name-only", round.fromSha, round.headSha ?? "").trim(), "a.txt\nb.txt\ndoc.md\nnew.txt");
  });
});

test("a worktree review parks the branch review, and a branch write brings it back", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "on the branch"], { cwd: repo.dir });
    openChanges(repo);
    const { round } = check(repo, "--worktree", "open");
    assert.ok(round !== undefined);
    const w = cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, round, OPEN_CHAPTERS) });
    assert.equal(w.code, 0, w.all);
    assert.match(w.out, /a review of the working tree: the open changes alone/);
    assert.match(w.out, /parked the review of feat \(round 1, 1 open finding\) as "feat"; .*so does discarding this working-tree review/);
    const installed = repo.readManifest();
    assert.deepEqual(
      { mode: installed.mode, round: installed.round, headSha: installed.headSha, issues: installed.issues },
      { mode: "worktree", round: 1, headSha: round.headSha, issues: undefined }
    );
    assert.ok(existsSync(path.join(parkedDir(repo, "feat"), "chapters.json")));
    assert.deepEqual(check(repo).parked?.map((p) => [p.name, p.round, p.openFindings, p.branchExists]), [["feat", 1, 1, true]]);

    const add = cli(["issue", "add", "--path", "new.txt", "--line", "1", "--severity", "low", "--note", "scratch"], { cwd: repo.dir });
    assert.equal(add.code, 0, add.all);

    const branchRound = check(repo).round;
    assert.deepEqual({ number: branchRound?.number, fresh: branchRound?.new }, { number: 1, fresh: false }, "feat's round 1 goes on");
    const b = cli(["write"], { cwd: repo.dir, input: draft(repo, [{ id: "ch-1", title: "a and b", files: [{ path: "a.txt", status: "modified" }, { path: "b.txt", status: "modified" }] }]) });
    assert.equal(b.code, 0, b.all);
    assert.match(b.out, /dropped the working-tree review of feat \(1 open finding\)/);
    assert.match(b.out, /brought back the review of feat parked earlier \(round 1, 1 open finding\)/);
    const back = repo.readManifest();
    assert.equal(back.mode, undefined);
    assert.deepEqual(back.issues?.map((i) => i.note), ["on the branch"]);
    assert.ok(!existsSync(parkedDir(repo, "feat")));
    assert.equal(check(repo).parked, undefined);
  });
});

test("re-running a worktree review over edited files re-partitions it and carries its findings", () => {
  withRepo((repo) => {
    openChanges(repo);
    const first = check(repo, "--worktree", "open").round;
    assert.ok(first !== undefined);
    assert.equal(cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, first, OPEN_CHAPTERS) }).code, 0);
    assert.equal(cli(["issue", "add", "--path", "new.txt", "--line", "1", "--severity", "low", "--note", "n1"], { cwd: repo.dir }).code, 0);

    writeFileSync(path.join(repo.dir, "new.txt"), "n0\nn1\n");
    const second = check(repo, "--worktree", "open").round;
    assert.ok(second !== undefined);
    assert.notEqual(second.headSha, first.headSha);
    assert.deepEqual({ number: second.number, fresh: second.new, ids: second.chapters.map((c) => c.id) }, { number: 1, fresh: true, ids: ["ch-1", "ch-2"] });
    const r = cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, second, OPEN_CHAPTERS) });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /re-partitioned/);
    assert.deepEqual(repo.readManifest().issues?.map((i) => [i.id, i.line]), [["iss-2.1", 2]], "the finding follows its line");
  });
});

test("write refuses a worktree draft whose fromSha is neither HEAD nor the merge base", () => {
  withRepo((repo) => {
    openChanges(repo);
    const { round } = check(repo, "--worktree", "open");
    assert.ok(round !== undefined);
    const r = cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, { ...round, fromSha: round.headSha ?? "" }, OPEN_CHAPTERS) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /fromSha is HEAD \(the open changes alone\) or the merge base/);
    assert.ok(!repo.manifestExists());
  });
});

test("a worktree draft over a clean tree has nothing to partition", () => {
  withRepo((repo) => {
    const { round } = check(repo, "--worktree", "open");
    assert.ok(round !== undefined);
    const r = cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, round, OPEN_CHAPTERS) });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /the working tree has no open changes to review/);
  });
});

test("parked lists the parked reviews and drops one whose branch is gone", () => {
  withWrittenRepo((repo) => {
    openChanges(repo);
    const { round } = check(repo, "--worktree", "open");
    assert.ok(round !== undefined);
    assert.equal(cli(["write"], { cwd: repo.dir, input: worktreeDraft(repo, round, OPEN_CHAPTERS) }).code, 0);
    repo.git("checkout", "-q", "-b", "next");
    repo.git("branch", "-D", "feat");
    const listed = parseJsonAs<{ name: string; branchExists: boolean }[]>(cli(["parked"], { cwd: repo.dir }).out);
    assert.deepEqual(listed.map((p) => [p.name, p.branchExists]), [["feat", false]]);
    const d = cli(["parked", "drop", "feat"], { cwd: repo.dir });
    assert.equal(d.code, 0, d.all);
    assert.ok(!existsSync(parkedDir(repo, "feat")));
    assert.equal(repo.git("for-each-ref", "refs/worktree/chapter-review-parked/").trim(), "");
    assert.equal(cli(["parked", "drop", "feat"], { cwd: repo.dir }).code, 1);
  });
});
