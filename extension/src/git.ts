// Git queries the review logic needs. Deliberately free of the vscode API, so
// the modules built on it (fingerprint, staleness) can be exercised under plain
// node without launching an editor.

import { execFile, spawn } from "node:child_process";

const MAX_BLOB = 64 * 1024 * 1024;

/** Absolute git dir of the repo at cwd (worktree-safe); undefined if not a repo. */
export function resolveGitDir(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd },
      (err, stdout) => { resolve(err ? undefined : stdout.trim()); }
    );
  });
}

/** `git show <ref>:<path>`; empty ref or a missing file yields "". */
export function gitShow(repoRoot: string, ref: string, path: string): Promise<string> {
  if (!ref) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["show", `${ref}:${path}`],
      { cwd: repoRoot, maxBuffer: MAX_BLOB },
      // File absent at ref (e.g. stale manifest): empty side beats an error.
      (err, stdout) => { resolve(err ? "" : stdout); }
    );
  });
}

/**
 * gitShow for many blobs at once, through a single `git cat-file --batch`. A
 * process per blob is what a large branch cannot afford: on Windows, starting
 * git dominates the read, and a thousand-file manifest needs two per file.
 * Same contract per blob as gitShow: an empty ref, a path absent at its ref, or
 * a failed read yields "".
 */
export function gitShowMany(
  repoRoot: string,
  blobs: { ref: string; path: string }[]
): Promise<string[]> {
  const out = blobs.map(() => "");
  // cat-file takes one request per line and strips a trailing CR, so a path
  // holding either goes through gitShow instead.
  const odd = (b: { ref: string; path: string }): boolean => /[\r\n]/.test(b.ref + b.path);
  const batched = blobs.flatMap((b, i) => (b.ref && !odd(b) ? [i] : []));
  const single = blobs.flatMap((b, i) => (b.ref && odd(b) ? [i] : []));

  const viaShow = Promise.all(
    single.map(async (i) => {
      out[i] = await gitShow(repoRoot, blobs[i].ref, blobs[i].path);
    })
  );
  const viaBatch = new Promise<void>((resolve) => {
    if (batched.length === 0) {
      resolve();
      return;
    }
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.on("error", () => { resolve(); });
    child.on("close", () => { resolve(); });
    child.stdin.on("error", () => { /* git exited early; close resolves */ });
    const output = new BatchOutput((n, text) => {
      out[batched[n]] = text;
    });
    child.stdout.on("data", (chunk: Buffer) => { output.push(chunk); });
    child.stdin.end(batched.map((i) => `${blobs[i].ref}:${blobs[i].path}\n`).join(""));
  });
  return Promise.all([viaShow, viaBatch]).then(() => out);
}

/**
 * Splits `git cat-file --batch` output back into one text per request. It comes
 * in request order: a header line per request, then for a found object its
 * bytes and a newline. Chunks are joined only once a whole blob is in, so a
 * large blob is not re-copied with every chunk that arrives.
 */
class BatchOutput {
  private chunks: Buffer[] = [];
  private have = 0;
  private next = 0;
  private body: { size: number; blob: boolean } | undefined;

  constructor(private readonly found: (request: number, text: string) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.have += chunk.length;
    for (;;) {
      if (!this.body) {
        const buf = this.joined();
        const nl = buf.indexOf(10);
        if (nl < 0) {
          return;
        }
        // "<oid> <type> <size>" for a found object; "<request> missing" (or
        // "ambiguous") otherwise, which leaves that side empty.
        const header = /^[0-9a-f]+ (\S+) ([0-9]+)$/.exec(buf.toString("utf8", 0, nl));
        this.keep(buf.subarray(nl + 1));
        if (!header) {
          this.next++;
          continue;
        }
        this.body = { size: Number(header[2]), blob: header[1] === "blob" };
      }
      if (this.have < this.body.size + 1) {
        return;
      }
      const buf = this.joined();
      if (this.body.blob && this.body.size <= MAX_BLOB) {
        this.found(this.next, buf.toString("utf8", 0, this.body.size));
      }
      this.keep(buf.subarray(this.body.size + 1));
      this.next++;
      this.body = undefined;
    }
  }

  private joined(): Buffer {
    if (this.chunks.length > 1) {
      this.chunks = [Buffer.concat(this.chunks)];
    }
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private keep(rest: Buffer): void {
    this.chunks = rest.length > 0 ? [rest] : [];
    this.have = rest.length;
  }
}

/** `git rev-parse <ref>` → full SHA, or undefined if it can't be resolved. */
export function gitRevParse(repoRoot: string, ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", ref], { cwd: repoRoot }, (err, stdout) =>
      { resolve(err ? undefined : stdout.trim() || undefined); }
    );
  });
}

/**
 * Tracked files with uncommitted changes, or undefined if the query can't run.
 * `--untracked-files=no`: a new file nobody staged is not part of the diff.
 */
export function gitDirtyCount(repoRoot: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? undefined : stdout.split("\n").filter((l) => l.trim() !== "").length);
      }
    );
  });
}

// Where the CLI pins the commits each round's diff is read from, per worktree.
const PIN_PREFIX = "refs/worktree/chapter-review/";

/**
 * Drop every pin the CLI made for this worktree's review, so a discarded review
 * leaves nothing behind for gc to keep. Failures are swallowed: an unreleased
 * pin keeps a commit alive, it breaks nothing.
 */
export function releasePins(repoRoot: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["for-each-ref", "--format=delete %(refname)", PIN_PREFIX],
      { cwd: repoRoot },
      (err, stdout) => {
        if (err || stdout.trim() === "") {
          resolve();
          return;
        }
        const child = execFile("git", ["update-ref", "--stdin"], { cwd: repoRoot }, () => {
          resolve();
        });
        child.stdin?.end(stdout);
      }
    );
  });
}

/** `git merge-base <a> <b>` → SHA, or undefined if there is no common ancestor. */
export function gitMergeBase(
  repoRoot: string,
  a: string,
  b: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["merge-base", a, b], { cwd: repoRoot }, (err, stdout) =>
      { resolve(err ? undefined : stdout.trim() || undefined); }
    );
  });
}
