// Unit tests for the publish-version guard. Everything here is the pure half:
// the version list is passed in, so no test reaches the Marketplace.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  formatVersion,
  isLane,
  laneError,
  parseVersion,
  prereleaseVersion,
  publishBlocker,
  tagBlocker,
  type Version,
} from "../scripts/publish-version.ts";

const v = (major: number, minor: number, patch: number): Version => ({ major, minor, patch });

test("only the two lanes are accepted as a mode", () => {
  assert.ok(isLane("stable"));
  assert.ok(isLane("prerelease"));
  // A missing argument reaches this as undefined despite argv's `string` type.
  for (const bad of ["", "pre-release", "release", "Stable"]) {
    assert.equal(isLane(bad), false, `${bad} names no lane`);
  }
});

test("parseVersion takes a bare major.minor.patch", () => {
  assert.deepEqual(parseVersion("0.8.0"), v(0, 8, 0));
  assert.deepEqual(parseVersion("1.10.214"), v(1, 10, 214));
  assert.deepEqual(parseVersion(" 0.8.0\n"), v(0, 8, 0), "surrounding whitespace is trimmed");
});

test("parseVersion rejects anything the Marketplace would reject", () => {
  // The reason this is strict: none of these can be published, so accepting one
  // here would only move the failure to a place that cannot be undone.
  for (const bad of ["0.8.0-beta.1", "0.8.0+build7", "2026.7.0-dev", "0.8", "0.8.0.1", "v0.8.0", ""]) {
    assert.equal(parseVersion(bad), undefined, `${bad} must not parse`);
  }
});

test("compareVersions orders major, then minor, then patch", () => {
  assert.ok(compareVersions(v(0, 9, 2), v(0, 8, 99)) > 0, "minor outranks patch");
  assert.ok(compareVersions(v(1, 0, 0), v(0, 99, 99)) > 0, "major outranks minor");
  assert.ok(compareVersions(v(0, 9, 13), v(0, 9, 100)) < 0, "patch compares numerically, not as text");
  assert.equal(compareVersions(v(0, 8, 1), v(0, 8, 1)), 0);
});

test("an even minor anchors the lanes; an odd one is refused", () => {
  assert.equal(laneError(v(0, 8, 0)), undefined);
  assert.equal(laneError(v(0, 10, 3)), undefined);
  const odd = laneError(v(0, 7, 3));
  assert.ok(odd?.includes("odd"), "the message has to say what is wrong with 0.7.3");
});

test("a pre-release sits one minor above its stable, with the build as patch", () => {
  const pre = prereleaseVersion(v(0, 8, 0), 214);
  assert.deepEqual(pre, v(0, 9, 214));
  assert.equal(pre.minor % 2, 1, "the derived lane must land odd");
  // Which is the whole point of requiring an even stable minor: the two lanes can
  // never name the same version.
  assert.notEqual(formatVersion(pre), formatVersion(v(0, 8, 0)));
});

test("nothing published means anything may be published", () => {
  assert.equal(publishBlocker(v(0, 9, 1), []), undefined);
});

test("a version already on the Marketplace is refused", () => {
  const blocker = publishBlocker(v(0, 9, 214), ["0.8.0", "0.9.214"]);
  assert.ok(blocker?.includes("already published"));
});

test("a version at or below its lane's highest is refused", () => {
  const below = publishBlocker(v(0, 9, 100), ["0.9.214"]);
  assert.ok(below?.includes("not above"), "100 is behind 214");
  const equal = publishBlocker(v(0, 9, 214), ["0.9.214", "0.9.213"]);
  assert.ok(equal?.includes("already published"), "an exact match is caught as a duplicate first");
});

test("the lanes are compared independently", () => {
  // A pre-release far ahead of every stable must not block the next stable patch,
  // and vice versa. Folding both into one ordering would reject good numbers.
  assert.equal(publishBlocker(v(0, 8, 1), ["0.8.0", "0.9.1047"]), undefined);
  assert.equal(publishBlocker(v(0, 9, 1048), ["0.8.0", "0.8.1", "0.9.1047"]), undefined);
  // A different major is a different lane too.
  assert.equal(publishBlocker(v(1, 9, 1), ["0.9.9999"]), undefined);
});

test("a stable version below an existing tag is refused", () => {
  // Git is the complete record the Marketplace query is not: it returns only the
  // four most recent versions, which a busy pre-release lane fills on its own.
  const blocker = tagBlocker(v(0, 8, 1), ["v0.7.3", "v0.8.0", "v0.10.0"]);
  assert.ok(blocker?.includes("v0.10.0"), "the message names the tag it is behind");
});

test("a stable version above every tag is allowed", () => {
  assert.equal(tagBlocker(v(0, 10, 0), ["v0.7.3", "v0.8.0"]), undefined);
  assert.equal(tagBlocker(v(0, 8, 0), []), undefined, "the first release has no tags to clear");
});

test("the tag being released does not block itself", () => {
  // release.yml runs on the tag, so it is always present by then. Only a strictly
  // higher tag counts.
  assert.equal(tagBlocker(v(0, 8, 0), ["v0.7.3", "v0.8.0"]), undefined);
});

test("tags that are not versions are ignored", () => {
  assert.equal(tagBlocker(v(0, 8, 0), ["nightly", "v", "release-candidate"]), undefined);
});

test("published entries that do not parse are ignored, not fatal", () => {
  // The Marketplace has held odd values in the past; one unreadable row must not
  // stop a release, and must not be mistaken for the lane's highest either.
  assert.equal(publishBlocker(v(0, 9, 2), ["not-a-version", "0.9.1"]), undefined);
});
