// The `issue` family: recording a finding, where it anchors, revising it, and
// how it is stored. Drives the CLI as a subprocess against throwaway git repos.

import test from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { cli, draft, OK_CHAPTERS, withRepo, withWrittenRepo } from "./helpers.ts";
import type { Chapter } from "../.claude/skills/chapter-review/types.ts";

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

test("issue --help lists the subcommands and their flags, with no manifest needed", () => {
  withRepo((repo) => {
    const r = cli(["issue", "--help"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /usage: chapter-review issue/);
    assert.match(r.out, /set\s+<id> <flags>\s+revise a finding; takes the same flags as `add`/);
    assert.match(r.out, /--confidence/);
  });
});

// ---- anchoring: which chapter owns it, and which range ---------------------

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

test("issue add refuses a path that is not in the diff", () => {
  withWrittenRepo((repo) => {
    const r = cli(
      ["issue", "add", "--path", "typo.txt", "--severity", "high", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /not in the current manifest/);
    assert.equal((repo.readManifest().issues ?? []).length, 0, "no finding should be recorded");
  });
});

test("issue add refuses a hunk the partition does not claim", () => {
  withWrittenRepo((repo) => {
    // Stored as the anchor, so a typo'd range points the extension at lines the
    // diff never had — and on a single-owner path nothing warned about it.
    const bogus = cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "100,5,100,5", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(bogus.code, 1, bogus.all);
    assert.match(bogus.err, /--hunk is not a range claimed for a\.txt/);

    // Overlap was not enough: a range this large touches every hunk in the file.
    const huge = cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "1,999999999,1,999999999", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(huge.code, 1, huge.all);
    assert.match(huge.err, /is not a range claimed for a\.txt/);

    // b.txt is claimed whole, so its legal ranges come from the diff instead;
    // 5,2,5,2 is in neither place.
    const whole = cli(
      ["issue", "add", "--path", "b.txt", "--hunk", "5,2,5,2", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(whole.code, 1, whole.all);
    assert.match(whole.err, /--hunk is not a hunk of b\.txt in this diff/);
    assert.equal((repo.readManifest().issues ?? []).length, 0);
  });
});

test("a finding pins to a hunk of a file claimed whole", () => {
  withWrittenRepo((repo) => {
    // Without this, two findings about different parts of a wholly-claimed file
    // both anchor to the bare path and `issue list` shows one location twice.
    const hunk = ["--hunk", "1,1,1,1"];
    const first = cli(
      ["issue", "add", "--path", "b.txt", ...hunk, "--severity", "low", "--note", "one"],
      { cwd: repo.dir }
    );
    assert.equal(first.code, 0, first.all);

    // Two findings may share a range: a hunk can hold a bug and a smell.
    const second = cli(
      ["issue", "add", "--path", "b.txt", ...hunk, "--severity", "low", "--note", "another"],
      { cwd: repo.dir }
    );
    assert.equal(second.code, 0, second.all);

    const issues = repo.readManifest().issues ?? [];
    assert.equal(issues.length, 2);
    for (const i of issues) {
      assert.deepEqual(i.hunk, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    }
    assert.match(cli(["issue", "list"], { cwd: repo.dir }).out, /b\.txt @@ -1,1 \+1,1 @@/);
  });
});

test("a finding on a quarantined path is recorded, and listed as unassigned", () => {
  withRepo((repo) => {
    const chapters: Chapter[] = [
      { id: "ch-1", title: "edit a", files: [{ path: "a.txt", status: "modified" }] },
    ];
    const w = cli(["write"], {
      cwd: repo.dir,
      input: draft(repo, chapters, {
        unassigned: [{ path: "b.txt", status: "modified", reason: "generated" }],
      }),
    });
    assert.equal(w.code, 0, w.all);

    const add = cli(
      ["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(add.code, 0, add.all);
    assert.ok(!repo.readManifest().issues?.[0].chapterId, "a quarantined path has no owning chapter");
    assert.match(cli(["issue", "list"], { cwd: repo.dir }).out, /\(unassigned\)/);
  });
});

test("issue list shows the hunk a finding is pinned to", () => {
  withWrittenRepo((repo) => {
    // a.txt spans ch-1 and ch-2, so --hunk both picks the owner and pins the range.
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "5,1,5,1", "--severity", "low", "--note", "pinned"],
      { cwd: repo.dir }
    );
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "whole file"], { cwd: repo.dir });

    const { out } = cli(["issue", "list"], { cwd: repo.dir });
    // Both findings sit in ch-2, so they take that chapter's sequence in turn.
    assert.match(out, /iss-2\.1.*a\.txt @@ -5,1 \+5,1 @@ \(ch-2\)/);
    assert.match(out, /iss-2\.2.*b\.txt \(ch-2\)/);
    assert.doesNotMatch(out, /b\.txt @@/);
  });
});

// ---- revising and removing --------------------------------------------------

test("issue lifecycle: set / verify / unverify / resolve / reopen / rm", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    assert.match(cli(["issue", "set", "iss-2.1", "--confidence", "verified"], { cwd: repo.dir }).out, /Updated iss-2\.1/);
    assert.match(cli(["issue", "verify", "iss-2.1"], { cwd: repo.dir }).out, /Marked iss-2\.1 verified/);
    assert.match(cli(["issue", "unverify", "iss-2.1"], { cwd: repo.dir }).out, /Marked iss-2\.1 suspected/);
    assert.match(cli(["issue", "resolve", "iss-2.1"], { cwd: repo.dir }).out, /Resolved iss-2\.1/);
    assert.match(cli(["issue", "reopen", "iss-2.1"], { cwd: repo.dir }).out, /Reopened iss-2\.1/);
    assert.match(cli(["issue", "rm", "iss-2.1"], { cwd: repo.dir }).out, /Removed iss-2\.1/);
    assert.doesNotMatch(cli(["issue", "list"], { cwd: repo.dir }).out, /^iss-2\.1\b/m);
  });
});

test("issue set refuses a path that is not in the diff, and a call with no fields", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "real"], { cwd: repo.dir });

    const moved = cli(["issue", "set", "iss-2.1", "--path", "typo.txt"], { cwd: repo.dir });
    assert.equal(moved.code, 1, moved.all);
    assert.equal(repo.readManifest().issues?.[0].path, "b.txt", "the finding must not move");

    const empty = cli(["issue", "set", "iss-2.1"], { cwd: repo.dir });
    assert.equal(empty.code, 1, empty.all);
    assert.match(empty.err, /needs at least one field to change/);
  });
});

test("issue set drops a hunk that belonged to the path it moved off, and says so", () => {
  withWrittenRepo((repo) => {
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "5,1,5,1", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    const r = cli(["issue", "set", "iss-2.1", "--path", "b.txt"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.path, "b.txt");
    assert.ok(!Object.hasOwn(issue, "hunk"), "the old file's range must not follow the finding");
    // Dropping it silently left no sign the finding had ever been pinned.
    assert.match(r.out, /hunk was cleared/);
  });
});

test("issue add refuses an old-path the partition does not record", () => {
  withRepo((repo) => {
    // b.txt renamed to c.txt with identical content, so -M reports R100.
    repo.git("mv", "b.txt", "c.txt");
    writeFileSync(`${repo.dir}/c.txt`, "b1\n");
    repo.git("commit", "-am", "rename b to c");
    const renamed: Chapter[] = [
      { id: "ch-1", title: "a", files: [{ path: "a.txt", status: "modified" }] },
      { id: "ch-2", title: "rename", files: [{ path: "c.txt", status: "renamed", oldPath: "b.txt" }] },
    ];
    assert.equal(cli(["write"], { cwd: repo.dir, input: draft(repo, renamed) }).code, 0);

    // Stored unchecked, an invented origin sat in the finding looking like the
    // file's history while the manifest beside it said otherwise.
    const wrong = cli(
      ["issue", "add", "--path", "c.txt", "--old-path", "nope.txt", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(wrong.code, 1, wrong.all);
    assert.match(wrong.err, /was renamed from "b\.txt", not "nope\.txt"/);

    const notRenamed = cli(
      ["issue", "add", "--path", "a.txt", "--old-path", "b.txt", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(notRenamed.code, 1, notRenamed.all);
    assert.match(notRenamed.err, /not recorded as renamed/);

    const right = cli(
      ["issue", "add", "--path", "c.txt", "--old-path", "b.txt", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(right.code, 0, right.all);
  });
});

test("a removed issue id is retired, not handed out again", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "one"], { cwd: repo.dir });
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "two"], { cwd: repo.dir });
    const rm = cli(["issue", "rm", "iss-2.2"], { cwd: repo.dir });
    assert.equal(rm.code, 0, rm.all);

    const add = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "three"], { cwd: repo.dir });
    assert.equal(add.code, 0, add.all);
    assert.match(add.out, /Added iss-2\.3\b/);

    // And the mark survives regeneration, including for a pruned id.
    cli(["issue", "rm", "iss-2.3"], { cwd: repo.dir });
    const w = cli(["write"], { cwd: repo.dir, input: draft(repo, OK_CHAPTERS) });
    assert.equal(w.code, 0, w.all);
    const after = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "four"], { cwd: repo.dir });
    assert.match(after.out, /Added iss-2\.4\b/);
  });
});

test("findings are numbered inside their chapter, so the number names the chapter", () => {
  withWrittenRepo((repo) => {
    // a.txt is split: hunk 2 belongs to ch-1, hunk 5 to ch-2. b.txt is ch-2's.
    const top = cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "2,1,2,1", "--severity", "low", "--note", "top"],
      { cwd: repo.dir }
    );
    assert.match(top.out, /Added iss-1\.1 .* in ch-1\./);
    const bottom = cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "5,1,5,1", "--severity", "low", "--note", "bottom"],
      { cwd: repo.dir }
    );
    assert.match(bottom.out, /Added iss-2\.1 .* in ch-2\./);
    // The two chapters count separately: a global counter made this one iss-3.
    const second = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "b"], { cwd: repo.dir });
    assert.match(second.out, /Added iss-2\.2 .* in ch-2\./);
  });
});

test("a finding with no owning chapter is numbered in the chapter-0 sequence", () => {
  withRepo((repo) => {
    const chapters: Chapter[] = [
      { id: "ch-1", title: "edit a", files: [{ path: "a.txt", status: "modified" }] },
    ];
    const w = cli(["write"], {
      cwd: repo.dir,
      input: draft(repo, chapters, {
        unassigned: [{ path: "b.txt", status: "modified", reason: "generated" }],
      }),
    });
    assert.equal(w.code, 0, w.all);
    const add = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    assert.match(add.out, /Added iss-0\.1\b/);
    assert.equal(repo.readManifest().issueSeq?.["0"], 1);
    // Recorded, but not in silence: the confirmation reads like any other add, so
    // without this nothing said the finding had landed on quarantined noise.
    assert.match(add.err, /b\.txt is quarantined as noise \(generated\)/);
    assert.match(add.err, /chapter-0 sequence/);

    // And no chapter can be named for it, since none holds the path.
    const forced = cli(
      ["issue", "add", "--path", "b.txt", "--chapter", "ch-1", "--severity", "low", "--note", "y"],
      { cwd: repo.dir }
    );
    assert.equal(forced.code, 1, forced.all);
    assert.match(forced.err, /quarantined in unassigned/);
  });
});

test("issue add and set refuse a chapter that does not hold the path", () => {
  withWrittenRepo((repo) => {
    // ch-1 holds only a.txt's top hunk; b.txt lives in ch-2 alone. Filing a b.txt
    // finding under ch-1 used to be stored and then silently reverted by the next
    // `write`, which reads the owner back off the path.
    const add = cli(
      ["issue", "add", "--path", "b.txt", "--chapter", "ch-1", "--severity", "low", "--note", "x"],
      { cwd: repo.dir }
    );
    assert.equal(add.code, 1, add.all);
    assert.match(add.err, /ch-1 does not hold b\.txt/);
    assert.match(add.err, /b\.txt is in ch-2/);
    assert.equal((repo.readManifest().issues ?? []).length, 0, "nothing should be recorded");

    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    const set = cli(["issue", "set", "iss-2.1", "--chapter", "ch-1"], { cwd: repo.dir });
    assert.equal(set.code, 1, set.all);
    assert.match(set.err, /does not hold b\.txt/);
    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.id, "iss-2.1", "the finding must not move");
    assert.equal(issue.chapterId, "ch-2");

    // A split path is what --chapter is for, so either of its owners is accepted.
    const split = cli(
      ["issue", "add", "--path", "a.txt", "--chapter", "ch-1", "--severity", "low", "--note", "top"],
      { cwd: repo.dir }
    );
    assert.equal(split.code, 0, split.all);
    assert.match(split.out, /Added iss-1\.1 .* in ch-1\./);
  });
});

test("issue set says to re-read the note when a hunk re-anchors the finding", () => {
  withWrittenRepo((repo) => {
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "2,1,2,1", "--severity", "low", "--note", "top"],
      { cwd: repo.dir }
    );
    // Reaching for --hunk to change chapters moves the anchor too, so the note
    // can be left describing code the finding no longer points at.
    const r = cli(["issue", "set", "iss-1.1", "--hunk", "5,1,5,1"], { cwd: repo.dir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Check the note still describes the range it now points at/);
  });
});

test("moving a finding to another chapter renumbers it, retiring both ids", () => {
  withWrittenRepo((repo) => {
    cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "2,1,2,1", "--severity", "low", "--note", "top"],
      { cwd: repo.dir }
    );
    // Re-anchoring to ch-2's hunk moves the finding, so its number moves with it:
    // an iss-1.1 sitting under chapter two is the confusion this rules out.
    const moved = cli(["issue", "set", "iss-1.1", "--hunk", "5,1,5,1"], { cwd: repo.dir });
    assert.equal(moved.code, 0, moved.all);
    assert.match(moved.out, /It is now iss-2\.1/);
    const issue = repo.readManifest().issues?.[0];
    assert.equal(issue?.id, "iss-2.1");
    assert.equal(issue.chapterId, "ch-2");

    // Neither number is handed out again: the vacated ch-1 slot least of all,
    // since "1.1" may already be quoted in a PR comment.
    const next = cli(
      ["issue", "add", "--path", "a.txt", "--hunk", "2,1,2,1", "--severity", "low", "--note", "another"],
      { cwd: repo.dir }
    );
    assert.match(next.out, /Added iss-1\.2\b/);
    const again = cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "more"], { cwd: repo.dir });
    assert.match(again.out, /Added iss-2\.2\b/);
  });
});

test("default status and confidence are stored one way, however they were set", () => {
  withWrittenRepo((repo) => {
    cli(["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "x"], { cwd: repo.dir });
    // A round trip must not leave `"status": "open"` where an untouched finding
    // has no status key at all.
    cli(["issue", "resolve", "iss-2.1"], { cwd: repo.dir });
    cli(["issue", "reopen", "iss-2.1"], { cwd: repo.dir });
    cli(["issue", "verify", "iss-2.1"], { cwd: repo.dir });
    cli(["issue", "unverify", "iss-2.1"], { cwd: repo.dir });

    const issue = repo.readManifest().issues?.[0];
    assert.ok(issue);
    assert.ok(!Object.hasOwn(issue, "status"), "an open finding must not store a status");
    assert.ok(!Object.hasOwn(issue, "confidence"), "a suspected finding must not store a confidence");
    // Resolved is not the default, so it is still written.
    cli(["issue", "resolve", "iss-2.1"], { cwd: repo.dir });
    assert.equal(repo.readManifest().issues?.[0].status, "resolved");
  });
});
