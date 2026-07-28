// The protocol seam. Everywhere else, each half is tested against its own idea
// of the format: the CLI asserts on drafts it built, the extension renders a
// manifest hand-written in the fixture. Here the real CLI writes the files and
// the real extension reads them, which is the only place the two hand-maintained
// mirrors of the contract (skill/types.ts and src/model.ts) can be caught drifting.

import * as assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeDigests } from "../../fingerprint";
import { parseManifest, reviewKey, Manifest, ReviewedUnit } from "../../model";
import { ReviewProgress } from "../../progress";
import { checkStaleness } from "../../staleness";
import { ChapterTreeProvider, Node } from "../../tree";
import { withFixture, Fixture } from "../fixture";

// The developer's installed skill, not the copy this repo happens to contain.
const SKILL = path.resolve(__dirname, "../../../../.claude/skills/chapter-review");
const CLI = path.join(SKILL, "chapter-review");

// Async on purpose: a synchronous child process blocks the extension host's
// event loop, and VS Code starts profiling it as unresponsive.
function cli(fx: Fixture, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: fx.dir, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${args.join(" ")} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** A partition of the fixture diff, in the form the skill tells an agent to build. */
function draft(fx: Fixture, overrides: Partial<Manifest> = {}): string {
  const { headSha, mergeBase, chapters, unassigned } = fx.manifest;
  return JSON.stringify({
    version: 1,
    base: "main",
    head: "feat",
    mergeBase,
    headSha,
    generatedAt: "2026-07-27T10:00:00Z",
    chapters,
    unassigned,
    ...overrides,
  });
}

const progressPath = (fx: Fixture): string =>
  path.join(fx.gitDir, "chapter-review", "progress.json");

function readManifestFromDisk(fx: Fixture): Manifest {
  return parseManifest(readFileSync(path.join(fx.gitDir, "chapter-review", "chapters.json"), "utf8"));
}

function isReviewedUnits(v: unknown): v is ReviewedUnit[] {
  const hasPath = (u: unknown): boolean =>
    typeof u === "object" && u !== null && "path" in u && typeof u.path === "string";
  return Array.isArray(v) && v.every((u: unknown) => hasPath(u));
}

/** The checkmark rows on disk, however the extension last left them. */
function readProgressFromDisk(fx: Fixture): ReviewedUnit[] {
  const doc: unknown = JSON.parse(readFileSync(progressPath(fx), "utf8"));
  if (typeof doc !== "object" || doc === null || !("reviewed" in doc)) {
    throw new Error("progress.json has no reviewed array");
  }
  const { reviewed } = doc;
  if (!isReviewedUnits(reviewed)) {
    throw new Error("progress.json's reviewed array is not review units");
  }
  return reviewed;
}

function persistProgress(fx: Fixture, progress: ReviewProgress, manifest: Manifest): void {
  writeFileSync(
    progressPath(fx),
    JSON.stringify({ version: 1, reviewed: progress.toReviewedUnits(manifest) }, null, 2) + "\n"
  );
}

async function providerFor(
  fx: Fixture,
  manifest: Manifest,
  progress = new ReviewProgress()
): Promise<ChapterTreeProvider> {
  const p = new ChapterTreeProvider(vscode.Uri.file(fx.dir), progress, manifest, "tree");
  p.digests = await computeDigests(fx.dir, manifest);
  return p;
}

// TreeItem.label is a string or a TreeItemLabel; String() on the latter gives
// "[object Object]".
const labelOf = (item: vscode.TreeItem): string =>
  typeof item.label === "string" ? item.label : (item.label?.label ?? "");

const titles = (p: ChapterTreeProvider): string[] =>
  p.getChildren().map((n: Node) => labelOf(p.getTreeItem(n)));

suite("CLI and extension over the same files", () => {
  test("what the CLI writes, the extension parses and renders", () =>
    withFixture(async (fx) => {
      const out = await cli(fx, ["write"], draft(fx));
      assert.match(out, /Wrote 2 chapters/);

      // parseManifest is the extension's own gate; if the CLI's output shape
      // ever drifts from src/model.ts, this is where it shows.
      const provider = await providerFor(fx, readManifestFromDisk(fx));
      assert.deepEqual(titles(provider), ["edit a top", "edit a bottom and b"]);
    }));

  test("a finding recorded by the CLI shows up under its chapter", () =>
    withFixture(async (fx) => {
      await cli(fx, ["write"], draft(fx));
      await cli(fx, ["issue", "add", "--path", "b.txt", "--severity", "high", "--note", "no guard"]);

      const onDisk = readManifestFromDisk(fx);
      assert.equal(onDisk.issues?.[0].chapterId, "ch-2", "the CLI infers the owning chapter");

      const provider = await providerFor(fx, onDisk);
      const children = provider.getChildren(provider.getChildren()[1]);
      assert.ok(
        children.some((n) => n.kind === "issue" || n.kind === "issuesRoot"),
        "the extension should render the CLI's finding"
      );
    }));

  test("checkmarks the extension writes are the rows the CLI reads back", () =>
    withFixture(async (fx) => {
      await cli(fx, ["write"], draft(fx));
      const onDisk = readManifestFromDisk(fx);
      const progress = new ReviewProgress();
      const provider = await providerFor(fx, onDisk, progress);

      const files = provider.getChildren(provider.getChildren()[1]);
      progress.setReviewed(provider.reviewUnitsFor(files[1]), true);
      persistProgress(fx, progress, onDisk);

      const unchecked = await cli(fx, ["uncheck", "--path", "b.txt"]);
      assert.match(unchecked, /Unchecked b\.txt \(1 unit\)/, "the CLI must find the extension's row");
    }));

  test("a regeneration keeps the untouched file ticked and re-opens the changed one", () =>
    withFixture(async (fx) => {
      await cli(fx, ["write"], draft(fx));
      const first = readManifestFromDisk(fx);
      const progress = new ReviewProgress();

      const digests = await computeDigests(fx.dir, first);
      const aKey = reviewKey("a.txt", first.chapters[0].files[0].hunks?.[0]);
      progress.setReviewed(
        [
          { key: aKey, digest: digests.get(aKey) },
          { key: reviewKey("b.txt"), digest: digests.get(reviewKey("b.txt")) },
        ],
        true
      );
      persistProgress(fx, progress, first);

      // b.txt changes; a.txt does not.
      writeFileSync(path.join(fx.dir, "b.txt"), "B1 revised\n");
      fx.git("commit", "-am", "revise b");
      const summary = await cli(fx, ["write"], draft(fx, { headSha: fx.git("rev-parse", "HEAD").trim() }));
      assert.match(summary, /2 checkmarks carried/, "the CLI carries both rows by path");

      // The extension is what decides whether a carried row still counts.
      const reloaded = new ReviewProgress();
      reloaded.load(readProgressFromDisk(fx));
      const afterDigests = await computeDigests(fx.dir, readManifestFromDisk(fx));

      assert.ok(
        reloaded.isReviewedAt(aKey, afterDigests.get(aKey)),
        "a.txt was untouched, so it stays reviewed"
      );
      assert.equal(
        reloaded.isReviewedAt(reviewKey("b.txt"), afterDigests.get(reviewKey("b.txt"))),
        false,
        "b.txt changed, so its carried row must not count"
      );
    }));

  test("a rename carries the finding, and the extension renders the new path", () =>
    withFixture(async (fx) => {
      await cli(fx, ["write"], draft(fx));
      await cli(fx, ["issue", "add", "--path", "b.txt", "--severity", "low", "--note", "follow me"]);

      fx.git("mv", "b.txt", "c.txt");
      writeFileSync(path.join(fx.dir, "c.txt"), "b1\n");
      fx.git("commit", "-am", "rename b to c");

      const out = await cli(
        fx,
        ["write"],
        draft(fx, {
          headSha: fx.git("rev-parse", "HEAD").trim(),
          chapters: [
            fx.manifest.chapters[0],
            {
              id: "ch-2",
              title: "edit a bottom and rename b",
              files: [
                {
                  path: "a.txt",
                  status: "modified",
                  hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
                },
                { path: "c.txt", status: "renamed", oldPath: "b.txt" },
              ],
            },
          ],
        })
      );
      assert.match(out, /followed rename iss-1: b\.txt -> c\.txt/);

      const onDisk = readManifestFromDisk(fx);
      assert.equal(onDisk.issues?.[0].path, "c.txt");
      const provider = await providerFor(fx, onDisk);
      const files = provider.getChildren(provider.getChildren()[1]);
      assert.ok(
        files.some((n) => n.kind === "file" && n.entry.path === "c.txt"),
        "the tree should show the file under its new name"
      );
    }));

  test("moving HEAD makes the extension stale; the CLI's re-pin clears it", () =>
    withFixture(async (fx) => {
      await cli(fx, ["write"], draft(fx));
      assert.equal((await checkStaleness(fx.dir, readManifestFromDisk(fx))).stale, false);

      writeFileSync(path.join(fx.dir, "b.txt"), "B1 later\n");
      fx.git("commit", "-am", "move head");
      assert.equal(
        (await checkStaleness(fx.dir, readManifestFromDisk(fx))).stale,
        true,
        "the manifest's pin is behind the branch"
      );

      await cli(fx, ["write"], draft(fx, { headSha: fx.git("rev-parse", "HEAD").trim() }));
      assert.equal(
        (await checkStaleness(fx.dir, readManifestFromDisk(fx))).stale,
        false,
        "write re-pins, so the banner clears"
      );
    }));
});

suite("schema conformance between the two halves", () => {
  test("the skill's own example manifest parses in the extension", () => {
    const example = path.join(SKILL, "example-chapters.json");
    assert.ok(existsSync(example), "the skill ships a worked example");
    const parsed = parseManifest(readFileSync(example, "utf8"));
    assert.equal(parsed.version, 1);
    assert.ok(parsed.chapters.length > 0);
  });

  test("a manifest the extension accepts also passes the skill's validator", () =>
    withFixture((fx) => {
      const out = execFileSync(
        process.execPath,
        [path.join(SKILL, "validate.ts"), path.join(fx.gitDir, "chapter-review", "chapters.json")],
        { encoding: "utf8" }
      );
      assert.match(out, /^OK /, out);
    }));
});
