// Shared helpers for the node:test suites: locate the CLI, build throwaway git
// repos, and drive the CLI as a subprocess. Not a test file itself (the `test`
// script globs *.test.ts), so it never runs on its own.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Type-only, so it erases at runtime: the tests describe the same manifest the
// CLI does, and reusing its types keeps the two from drifting.
import type { Chapter, Manifest, ReviewedUnit } from "../.claude/skills/chapter-review/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.join(here, "..", ".claude", "skills", "chapter-review");
export const CLI = path.join(SKILL_DIR, "chapter-review");

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** stdout + stderr, for assertions that don't care which stream carried it. */
  all: string;
}

export interface CliOptions {
  cwd?: string;
  input?: string;
}

/**
 * Run the CLI in `cwd`, optionally feeding `input` on stdin. Uses the same node
 * binary running the tests, so the .ts modules are type-stripped as at runtime.
 */
export function cli(args: string[], { cwd, input }: CliOptions = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8" });
  // @types/node types both as string, but they are null when the process fails
  // to spawn at all (ENOENT, EACCES), so these fallbacks are load-bearing and
  // the rule's "always defined" reading of them is wrong.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const out = r.stdout ?? "";
  const err = r.stderr ?? "";
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  return { code: r.status ?? 1, out, err, all: out + err };
}

export interface TestRepo {
  dir: string;
  git: (...a: string[]) => string;
  gitDir: string;
  manifestPath: string;
  progressPath: string;
  mergeBase: string;
  headSha: string;
  readManifest: () => Manifest;
  readProgress: () => ReviewedUnit[];
  writeProgress: (units: ReviewedUnit[]) => void;
  writeManifest: (m: unknown) => void;
  manifestExists: () => boolean;
  clean: () => boolean;
  cleanup: () => void;
}

/**
 * Create a throwaway git repo with a base commit on `main` and a `feat` branch
 * that modifies two files. Returns the paths, resolved refs, and a `cleanup()`
 * the caller must run.
 */
export function makeRepo(): TestRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-test-"));
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
  const manifestPath = path.join(gitDir, "chapter-review", "chapters.json");
  const progressPath = path.join(gitDir, "chapter-review", "progress.json");
  return {
    dir,
    git,
    gitDir,
    manifestPath,
    progressPath,
    mergeBase: git("merge-base", "main", "HEAD").trim(),
    headSha: git("rev-parse", "HEAD").trim(),
    // The CLI validated whatever it wrote, so trusting the shape here is safe;
    // a test asserting on a malformed manifest wants the cast to fail loudly.
    readManifest: (): Manifest => JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest,
    // `unknown` on purpose: tests deliberately write malformed manifests too.
    writeManifest: (m: unknown): void =>
      { writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n"); },
    // Checkmarks live in their own document, written by the extension and by
    // `uncheck`; the manifest no longer carries them.
    readProgress: (): ReviewedUnit[] =>
      existsSync(progressPath)
        ? ((JSON.parse(readFileSync(progressPath, "utf8")) as { reviewed?: ReviewedUnit[] })
            .reviewed ?? [])
        : [],
    writeProgress: (units: ReviewedUnit[]): void => {
      writeFileSync(progressPath, JSON.stringify({ version: 1, reviewed: units }, null, 2) + "\n");
    },
    manifestExists: (): boolean => existsSync(manifestPath),
    clean: (): boolean => git("status", "--porcelain").trim() === "",
    cleanup: (): void => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** An empty (no commits, not a git) throwaway dir; returns {dir, cleanup}. */
export function makeNonGitDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-nongit-"));
  return { dir, cleanup: (): void => { rmSync(dir, { recursive: true, force: true }); } };
}

/** A partition draft over the fixture's diff, with optional extra top-level keys. */
export function draft(
  repo: TestRepo,
  chapters: Chapter[],
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    version: 1,
    base: "main",
    head: "feat",
    mergeBase: repo.mergeBase,
    headSha: repo.headSha,
    generatedAt: "2026-07-24T10:00:00Z",
    chapters,
    unassigned: [],
    ...extra,
  });
}

/** A valid two-chapter partition: a.txt split across ch-1/ch-2, b.txt in ch-2. */
export const OK_CHAPTERS: Chapter[] = [
  {
    id: "ch-1",
    title: "edit a top",
    files: [{ path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }],
  },
  {
    id: "ch-2",
    title: "edit a bottom + b",
    files: [
      { path: "a.txt", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }] },
      { path: "b.txt", status: "modified" },
    ],
  },
];
