// A large branch is where reading blobs one git process at a time cost minutes:
// two per file, every one of them started at once. The batch read has to give
// each blob exactly what gitShow gave, or every recorded checkmark re-opens.

import { describe, it, mock } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { computeDigests } from "../../fingerprint";
import { gitShow, gitShowMany } from "../../git";
import type { FileEntry, Manifest } from "../../model";
import { withFixture } from "../fixture";

// The module object git.ts calls into, which an `import * as` namespace is not:
// mocking a method on the namespace would leave git.ts's calls untouched.
const childProcess = process.getBuiltinModule("node:child_process");

describe("batch blob reads", () => {
  it("give each blob what gitShow gives, and an absent path or empty ref as empty", () =>
    withFixture(async (fx) => {
      mkdirSync(path.join(fx.dir, "dir"));
      writeFileSync(path.join(fx.dir, "dir", "sp ä.txt"), "umlaut ü\n");
      writeFileSync(path.join(fx.dir, "big.txt"), "0123456789abcdef\n".repeat(64 * 1024));
      writeFileSync(path.join(fx.dir, "bytes.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
      fx.git("add", "-A");
      fx.git("commit", "-m", "awkward files");
      const head = fx.git("rev-parse", "HEAD").trim();

      const asks = [
        { ref: fx.mergeBase, path: "a.txt" },
        { ref: head, path: "a.txt" },
        { ref: head, path: "dir/sp ä.txt" },
        { ref: head, path: "big.txt" },
        { ref: head, path: "bytes.bin" },
        { ref: fx.mergeBase, path: "big.txt" },
        { ref: head, path: "no/such/file.txt" },
        { ref: "", path: "a.txt" },
        { ref: head, path: "dir" },
        { ref: head, path: "b.txt" },
      ];
      const batched = await gitShowMany(fx.dir, asks);
      const single = await Promise.all(asks.map((a) => gitShow(fx.dir, a.ref, a.path)));
      for (const [i, a] of asks.entries()) {
        if (a.path === "dir") {
          assert.equal(batched[i], "", "a tree is not a file side");
          continue;
        }
        assert.equal(batched[i], single[i], `${a.ref.slice(0, 7)}:${a.path}`);
      }
      assert.equal(batched[6], "");
      assert.equal(batched[7], "");
      assert.equal(batched[3].length, 17 * 64 * 1024);
    }));

  it("read a 1,000-file manifest through one git process", async (t) => {
    const repo = largeRepo(1000);
    const spawned = mock.method(childProcess, "spawn");
    const shown = mock.method(childProcess, "execFile");
    try {
      const started = performance.now();
      const digests = await computeDigests(repo.dir, repo.manifest);
      t.diagnostic(`computeDigests over 1,000 files: ${(performance.now() - started).toFixed(0)} ms`);

      assert.equal(digests.size, 1000);
      assert.equal(spawned.mock.callCount(), 1);
      assert.equal(shown.mock.callCount(), 0);
      const unit = (key: string): string | undefined => digests.get(key)?.unit;
      assert.notEqual(unit("src/new/n2.txt#whole"), unit("src/new/n102.txt#whole"), "an add reads its head side");
      assert.notEqual(unit("src/m1/f1.txt#whole"), unit("src/m1/f101.txt#whole"), "a delete reads its base side");
    } finally {
      mock.restoreAll();
      rmSync(repo.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/**
 * A branch touching `n` files across ten chapters: mostly edits, plus files it
 * adds and deletes so both kinds of absent side are in the read.
 */
function largeRepo(n: number): { dir: string; manifest: Manifest } {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-large-"));
  const git = (...a: string[]): string => childProcess.execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");

  const indices = Array.from({ length: n }, (_, i) => i);
  const file = (i: number): string => `src/m${i % 20}/f${i}.txt`;
  const body = (i: number, rev: string): string =>
    Array.from({ length: 40 }, (_, l) => `file ${i} line ${l} ${l === 20 ? rev : ""}`).join("\n") + "\n";
  for (const i of indices) {
    mkdirSync(path.join(dir, path.dirname(file(i))), { recursive: true });
    writeFileSync(path.join(dir, file(i)), body(i, "base"));
  }
  git("add", "-A");
  git("commit", "-m", "base");
  const mergeBase = git("rev-parse", "HEAD").trim();

  git("checkout", "-b", "feat");
  mkdirSync(path.join(dir, "src/new"));
  const entries = indices.map((i): FileEntry => {
    if (i % 100 === 1) {
      rmSync(path.join(dir, file(i)));
      return { path: file(i), status: "deleted" };
    }
    if (i % 100 === 2) {
      writeFileSync(path.join(dir, `src/new/n${i}.txt`), body(i, "new"));
      return { path: `src/new/n${i}.txt`, status: "added" };
    }
    writeFileSync(path.join(dir, file(i)), body(i, "feat"));
    return { path: file(i), status: "modified" };
  });
  git("add", "-A");
  git("commit", "-m", "feat");
  const headSha = git("rev-parse", "HEAD").trim();

  const manifest: Manifest = {
    version: 2,
    round: 1,
    base: "main",
    head: "feat",
    mergeBase,
    fromSha: mergeBase,
    headSha,
    generatedAt: "2026-10-23T10:00:00Z",
    chapters: Array.from({ length: 10 }, (_, c) => ({
      id: `ch-${String(c + 1)}`,
      title: `part ${String(c + 1)}`,
      files: entries.slice((c * n) / 10, ((c + 1) * n) / 10),
    })),
    unassigned: [],
  };
  return { dir, manifest };
}
