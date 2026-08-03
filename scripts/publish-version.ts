// Decides and validates the version a publish may use, so a wrong number is a
// red build rather than something the Marketplace keeps forever.
//
// CLI (prints the version on stdout, diagnostics on stderr):
//   node scripts/publish-version.ts prerelease      -> 0.9.214
//   node scripts/publish-version.ts stable v0.8.0   -> 0.8.0
//
// The Marketplace rejects semver pre-release tags, so the two channels are kept
// apart by the parity of the minor: stable even, pre-release the next odd one.
//
// The build number is the commit count, not a CI counter. GITHUB_RUN_NUMBER
// restarts at 1 when a workflow file is renamed, which would attempt to republish
// a number the Marketplace already holds.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { die, errorMessage, isArray, isRecord } from "../.claude/skills/chapter-review/util.ts";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** The two publish lanes. */
export type Lane = "stable" | "prerelease";

/** Takes `unknown` because argv yields undefined for a missing argument. */
export const isLane = (x: unknown): x is Lane => x === "stable" || x === "prerelease";

/** Why something may not be published; `undefined` is the go-ahead. */
export type Refusal = string | undefined;

/** The fields this script needs from extension/package.json. */
interface PackageJson {
  publisher: string;
  name: string;
  version: string;
}

const isPackageJson = (x: unknown): x is PackageJson =>
  isRecord(x) &&
  typeof x.publisher === "string" &&
  typeof x.name === "string" &&
  typeof x.version === "string";

/** What extension/package.json says about the extension and its stable version. */
interface ExtensionManifest {
  /** `publisher.name`, the Marketplace's identifier for this extension. */
  id: string;
  /** The stable version the repo currently declares. */
  version: Version;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * A strict `major.minor.patch`, or undefined. Deliberately rejects every suffix:
 * a `-dev` or `+build` tail cannot be published, so accepting one here would only
 * defer the failure to the Marketplace.
 */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) {
    return undefined;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export const formatVersion = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/** Negative, zero or positive, comparing major then minor then patch. */
export function compareVersions(a: Version, b: Version): number {
  const diff = [a.major - b.major, a.minor - b.minor, a.patch - b.patch].find((d) => d !== 0);
  if (diff === undefined) {
    return 0;
  }
  return diff < 0 ? -1 : 1;
}

/**
 * Why this version cannot anchor the two lanes, or undefined when it can. Stable
 * must sit on an even minor, because the pre-release lane is derived as the next
 * one up and has to land odd. An odd stable minor means the lanes would collide.
 */
export function laneError(stable: Version): Refusal {
  if (stable.minor % 2 === 0) {
    return undefined;
  }
  return (
    `extension/package.json is ${formatVersion(stable)}, whose minor is odd.\n` +
    "  Stable releases live on even minors; odd minors belong to the pre-release\n" +
    "  channel. Cut an even-minor release before publishing either lane."
  );
}

/** The pre-release counterpart of a stable version: next minor up, build as patch. */
export const prereleaseVersion = (stable: Version, build: number): Version => ({
  major: stable.major,
  minor: stable.minor + 1,
  patch: build,
});

/**
 * Why `target` must not be published, or undefined when it may be.
 *
 * Compared only against versions sharing its major.minor. The lanes advance
 * independently, so the newest stable says nothing about which pre-release comes
 * next, and folding them into one ordering would reject perfectly good numbers.
 */
export function publishBlocker(target: Version, published: readonly string[]): Refusal {
  const wanted = formatVersion(target);
  if (published.some((p) => p.trim() === wanted)) {
    return (
      `${wanted} is already published.\n` +
      "  Marketplace versions are permanent and cannot be replaced."
    );
  }
  const lane = published
    .flatMap((p) => {
      const v = parseVersion(p);
      return v === undefined ? [] : [v];
    })
    .filter((v) => v.major === target.major && v.minor === target.minor);
  const highest = lane.reduce<Version | undefined>(
    (max, v) => (max === undefined || compareVersions(v, max) > 0 ? v : max),
    undefined
  );
  if (highest !== undefined && compareVersions(target, highest) <= 0) {
    return (
      `${wanted} is not above ${formatVersion(highest)}, the highest published ` +
      `${target.major}.${target.minor}.x.\n` +
      "  Users never move backwards, so a lower number would reach nobody."
    );
  }
  return undefined;
}

/**
 * Why a stable version must not be released given the tags this repo already
 * carries, or undefined when it may.
 *
 * Git is the complete record of stable releases; the Marketplace query is not,
 * because it returns only the four most recent versions and a busy pre-release
 * lane can fill that window entirely. Tags are what actually rule out a stable
 * release that would land below one already cut.
 */
export function tagBlocker(target: Version, tags: readonly string[]): Refusal {
  const higher = tags
    .flatMap((t) => {
      const v = parseVersion(t.trim().replace(/^v/, ""));
      return v === undefined ? [] : [v];
    })
    .filter((v) => compareVersions(v, target) > 0);
  const highest = higher.reduce<Version | undefined>(
    (max, v) => (max === undefined || compareVersions(v, max) > 0 ? v : max),
    undefined
  );
  if (highest === undefined) {
    return undefined;
  }
  return (
    `${formatVersion(target)} is behind v${formatVersion(highest)}, already tagged here.\n` +
    "  Users never move to a lower version, so the release would reach nobody."
  );
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(repoRoot, "extension");

/** `publisher`, `name` and `version` from extension/package.json. */
function readManifest(): ExtensionManifest {
  const pkg: unknown = JSON.parse(
    readFileSync(path.join(extensionDir, "package.json"), "utf8")
  );
  if (!isPackageJson(pkg)) {
    die("publish-version: extension/package.json needs string publisher, name and version");
  }
  const version = parseVersion(pkg.version);
  if (version === undefined) {
    die(
      `publish-version: extension/package.json version "${pkg.version}" is not major.minor.patch`
    );
  }
  return { id: `${pkg.publisher}.${pkg.name}`, version };
}

/**
 * Commits reachable from HEAD, used as the pre-release patch. Monotonic on a
 * branch that only grows, and a property of the code rather than of the pipeline
 * that happens to be building it.
 */
function commitCount(): number {
  const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const n = Number(out.trim());
  if (!Number.isInteger(n) || n <= 0) {
    die(`publish-version: could not read a commit count from git (got "${out.trim()}")`);
  }
  return n;
}

/** Every `v*` tag in this repo, the complete record of stable releases. */
function gitTags(): string[] {
  return execFileSync("git", ["tag", "--list", "v*"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/**
 * The versions the Marketplace reports for `id`: the four most recent, which is
 * all the gallery returns whatever flags it is asked for. Enough to catch a
 * collision with something just published, not a substitute for tagBlocker.
 *
 * Fails closed, because a publish cannot be taken back.
 */
function publishedVersions(id: string): string[] {
  // node against vsce's own entry script, not `npx vsce`: on Windows the npx
  // shim is a .cmd, which execFile refuses to spawn (EINVAL), so going through
  // it would make this fail closed on every local run.
  const vsce = path.join(extensionDir, "node_modules", "@vscode", "vsce", "vsce");
  const out = ((): string => {
    try {
      return execFileSync(process.execPath, [vsce, "show", id, "--json"], {
        cwd: extensionDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (e) {
      return die(
        `publish-version: could not read the published versions of ${id} ` +
          `(${errorMessage(e)}).\n` +
          "  Refusing to publish: a duplicate or backwards version cannot be ruled out."
      );
    }
  })();
  const doc: unknown = JSON.parse(out);
  if (!isRecord(doc) || !isArray(doc.versions)) {
    die(`publish-version: unexpected \`vsce show ${id} --json\` output (no versions array)`);
  }
  return doc.versions.flatMap((v) =>
    isRecord(v) && typeof v.version === "string" ? [v.version] : []
  );
}

function usage(): never {
  return die(
    [
      "usage: node scripts/publish-version.ts <mode> [tag]",
      "",
      "  prerelease        print the next pre-release version (odd minor, commit count as patch)",
      "  stable <vX.Y.Z>   print the stable version, checking the tag matches package.json",
    ].join("\n"),
    2
  );
}

/** The version a lane wants, before it is checked against the Marketplace. */
function target(lane: Lane, tag: string | undefined, stable: Version): Version {
  if (lane === "prerelease") {
    return prereleaseVersion(stable, commitCount());
  }
  if (tag === undefined) {
    usage();
  }
  const expected = `v${formatVersion(stable)}`;
  if (tag !== expected) {
    die(
      `publish-version: tag ${tag} does not match extension/package.json.\n` +
        `  expected ${expected}. Bump the version and the tag together.`
    );
  }
  return stable;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lane = isLane(process.argv[2]) ? process.argv[2] : usage();
  const { id, version: stable } = readManifest();
  const parity = laneError(stable);
  if (parity !== undefined) {
    die(`publish-version: ${parity}`);
  }
  const wanted = target(lane, process.argv[3], stable);
  // Stable only: a pre-release is already monotonic by construction, since the
  // commit count only grows, and pre-releases are never tagged.
  const behindTag = lane === "stable" ? tagBlocker(wanted, gitTags()) : undefined;
  if (behindTag !== undefined) {
    die(`publish-version: ${behindTag}`);
  }
  const blocker = publishBlocker(wanted, publishedVersions(id));
  if (blocker !== undefined) {
    die(`publish-version: ${blocker}`);
  }
  console.error(`publish-version: ${lane} -> ${formatVersion(wanted)} (${id})`);
  console.log(formatVersion(wanted));
}
