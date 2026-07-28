import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";

// A workspace the extension will actually activate against. Without one,
// activate() registers the skill commands and returns at its `if (!folder)`
// guard, so every watcher, the tree and the persistence path never run — and a
// test asserting "the extension activated" would be saying almost nothing.
function reviewWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-ws-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
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
  mkdirSync(path.join(gitDir, "chapter-review"), { recursive: true });
  writeFileSync(
    path.join(gitDir, "chapter-review", "chapters.json"),
    JSON.stringify(
      {
        version: 1,
        base: "main",
        head: "feat",
        mergeBase: git("merge-base", "main", "HEAD").trim(),
        headSha: git("rev-parse", "HEAD").trim(),
        generatedAt: "2026-07-27T10:00:00Z",
        summary: "the workspace the host tests activate against",
        chapters: [
          {
            id: "ch-1",
            title: "edit a and b",
            files: [
              { path: "a.txt", status: "modified" },
              { path: "b.txt", status: "modified" },
            ],
          },
        ],
        unassigned: [],
      },
      null,
      2
    ) + "\n"
  );
  return dir;
}

// Only the suites that genuinely need the editor: the tree provider (TreeItem,
// checkbox state) and activation. Everything else runs under `npm test` without
// launching anything. Each test builds its own throwaway git repo, so the
// launch workspace is irrelevant.
export default defineConfig({
  files: "out/test/host/**/*.test.js",
  workspaceFolder: reviewWorkspace(),
  mocha: { ui: "tdd", timeout: 30000 },
});
