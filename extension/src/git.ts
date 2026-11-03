// Git queries the review logic needs. Deliberately free of the vscode API, so
// the modules built on it (fingerprint, staleness) can be exercised under plain
// node without launching an editor.

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

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

/**
 * Files whose content on disk differs from `commit`, or undefined if the query
 * can't run. A worktree review reads a snapshot, and this is how far the files
 * have moved on from it. The files go into a tree the way the CLI took the
 * snapshot, through a copy of the index, because diffing against the real index
 * counts every file that was untracked then, and still is, as deleted.
 */
export async function gitEditedSince(repoRoot: string, commit: string): Promise<number | undefined> {
  const top = await git(repoRoot, ["rev-parse", "--show-toplevel"]);
  const index = await git(repoRoot, ["rev-parse", "--git-path", "index"]);
  if (!top || !index) {
    return undefined;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "chapter-review-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    const copied = await copyFile(path.resolve(repoRoot, index), env.GIT_INDEX_FILE).then(
      () => true,
      () => false
    );
    const seeded = copied || (await git(top, ["read-tree", "HEAD"], undefined, env)) !== undefined;
    const added = seeded && (await git(top, ["add", "--all"], undefined, env)) !== undefined;
    const tree = added ? await git(top, ["write-tree"], undefined, env) : undefined;
    const names = tree ? await git(top, ["diff", "--name-only", commit, tree], undefined, env) : undefined;
    return names === undefined ? undefined : names.split("\n").filter((l) => l.trim() !== "").length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(
  repoRoot: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd: repoRoot, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
    child.stdin?.end(input);
  });
}

// Where the CLI pins the commits each round's diff is read from, per worktree.
const PIN_PREFIX = "refs/worktree/chapter-review/";
// A parked review's pins, under `<prefix><name>/`.
const PARKED_PIN_PREFIX = "refs/worktree/chapter-review-parked/";

/**
 * The name the CLI parks a review of what is checked out under: the branch with
 * `/` as `-`, or the short commit when there is no usable branch name. Must stay
 * the CLI's `parkName`, or a discard looks for the parked review under another name.
 */
export async function currentParkName(repoRoot: string): Promise<string | undefined> {
  const sha = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!sha) {
    return undefined;
  }
  const branch = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = branch?.replace(/[/\\:*?"<>|]/g, "-");
  const usable =
    name !== undefined &&
    name !== "" &&
    name !== "HEAD" &&
    (await git(repoRoot, ["check-ref-format", `${PARKED_PIN_PREFIX}${name}/x`])) !== undefined;
  return usable ? name : sha.slice(0, 7);
}

/** Move the pins of the review parked as `name` back to where the installed review's pins live. */
export async function restorePins(repoRoot: string, name: string): Promise<void> {
  const prefix = `${PARKED_PIN_PREFIX}${name}/`;
  const listed = await git(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  const ops = (listed ?? "").split("\n").flatMap((line) => {
    const m = /^(\S+) ([0-9a-f]+)$/.exec(line);
    return m?.[1].startsWith(prefix) === true
      ? [`update ${PIN_PREFIX}${m[1].slice(prefix.length)} ${m[2]}`, `delete ${m[1]}`]
      : [];
  });
  if (ops.length > 0) {
    await git(repoRoot, ["update-ref", "--stdin"], ops.join("\n") + "\n");
  }
}

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
