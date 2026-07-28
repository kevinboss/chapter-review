// Builds a throwaway git repo for the integration tests: two commits, a branch
// that modifies two files, and a manifest partitioning that diff. Mirrors the
// CLI's own test fixture so both halves of the protocol are exercised against
// the same shape.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Manifest } from "../model";

export interface Fixture {
  dir: string;
  gitDir: string;
  manifest: Manifest;
  mergeBase: string;
  headSha: string;
  git: (...a: string[]) => string;
  writeManifest: (m: Manifest) => void;
  cleanup: () => void;
}

/**
 * Run `body` against a fresh fixture repo, cleaning up after. Mirrors the CLI
 * suite's `withRepo`, and keeps tests free of a rebindable fixture handle.
 */
export async function withFixture(body: (fx: Fixture) => void | Promise<void>): Promise<void> {
  const fx = makeFixture();
  try {
    await body(fx);
  } finally {
    fx.cleanup();
  }
}

export function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-ext-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8" });

  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
  writeFileSync(path.join(dir, "b.txt"), "b1\n");
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "feat");
  writeFileSync(path.join(dir, "a.txt"), "l1\nL2\nl3\nl4\nL5\nl6\n");
  writeFileSync(path.join(dir, "b.txt"), "B1\n");
  git("add", "-A");
  git("commit", "-m", "work");

  const gitDir = git("rev-parse", "--absolute-git-dir").trim();
  const mergeBase = git("merge-base", "main", "HEAD").trim();
  const headSha = git("rev-parse", "HEAD").trim();

  const manifest: Manifest = {
    version: 1,
    base: "main",
    head: "feat",
    mergeBase,
    headSha,
    generatedAt: "2026-07-27T10:00:00Z",
    chapters: [
      {
        id: "ch-1",
        title: "edit a top",
        files: [
          {
            path: "a.txt",
            status: "modified",
            hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }],
          },
        ],
      },
      {
        id: "ch-2",
        title: "edit a bottom and b",
        files: [
          {
            path: "a.txt",
            status: "modified",
            hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
          },
          { path: "b.txt", status: "modified" },
        ],
      },
    ],
    unassigned: [],
  };

  const writeManifest = (m: Manifest): void => {
    const dest = path.join(gitDir, "chapter-review");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "chapters.json"), JSON.stringify(m, null, 2) + "\n");
  };
  writeManifest(manifest);

  return {
    dir,
    gitDir,
    manifest,
    mergeBase,
    headSha,
    git,
    writeManifest,
    // The extension's git calls are async, so a spawned git can still hold a
    // handle here; git also marks pack files read-only, which Windows reports as
    // EPERM. Retry, then give up: a lingering temp dir is not a test failure.
    cleanup: (): void => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* the OS reclaims it */
      }
    },
  };
}
