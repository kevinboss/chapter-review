// The CLI writes chapters.json once per command, so a partition followed by a
// round of findings is a burst of writes. Each used to start a full reload of
// its own, all of them reading every blob again, side by side.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { aborted, Coalescer } from "../../coalesce";
import { DigestCache, DigestMap } from "../../fingerprint";
import type { Issue, Manifest } from "../../model";

/** A promise the test resolves by hand, to hold a load or a digest read open. */
function gate(): { open: () => void; passed: Promise<void> } {
  const opener: { open?: () => void } = {};
  const passed = new Promise<void>((resolve) => {
    opener.open = resolve;
  });
  return { open: () => opener.open?.(), passed };
}

const finding = (n: number): Issue => ({
  id: `iss-1.${String(n)}`,
  round: 1,
  path: "a.txt",
  chapterId: "ch-1",
  severity: "low",
  note: `finding ${String(n)}`,
});

const base: Manifest = {
  version: 2,
  round: 1,
  base: "main",
  head: "feat",
  mergeBase: "a".repeat(40),
  fromSha: "a".repeat(40),
  headSha: "b".repeat(40),
  generatedAt: "2026-10-23T10:00:00Z",
  chapters: [
    {
      id: "ch-1",
      title: "edits",
      files: [
        { path: "a.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] },
        { path: "b.txt", status: "modified" },
      ],
    },
  ],
  unassigned: [],
};

describe("coalesced reloads", () => {
  it("a burst during a load ends in one more load, of the final state", async () => {
    const disk = { writes: 1 };
    const held = gate();
    const started: number[] = [];
    const published: number[] = [];
    const loads = new Coalescer(async (signal) => {
      const seen = disk.writes;
      started.push(seen);
      if (started.length === 1) {
        await held.passed;
      }
      if (!signal.aborted) {
        published.push(seen);
      }
    });

    void loads.request();
    const settled = Array.from({ length: 33 }, () => {
      disk.writes++;
      return loads.request();
    }).at(-1);
    held.open();
    await settled;

    assert.deepEqual(started, [1, 34], "the load under way, then one for the whole burst");
    assert.deepEqual(published, [34], "the superseded load publishes nothing");
  });

  it("a request after everything settled starts a load of its own", async () => {
    const started: number[] = [];
    const loads = new Coalescer(() => {
      started.push(started.length);
      return Promise.resolve();
    });
    await loads.request();
    await loads.request();
    assert.equal(started.length, 2);
  });
});

describe("digest reuse", () => {
  const counting = (): { cache: DigestCache; computed: Manifest[] } => {
    const computed: Manifest[] = [];
    const cache = new DigestCache((m) => {
      computed.push(m);
      return Promise.resolve<DigestMap>(new Map());
    });
    return { cache, computed };
  };

  it("a write that only adds findings reuses the round's digests", async () => {
    const { cache, computed } = counting();
    const first = await cache.digestsFor(base);
    const again = await cache.digestsFor({ ...structuredClone(base), issues: [finding(1)], summary: "s" });
    assert.equal(again, first);
    assert.equal(computed.length, 1);
  });

  it("a new partition or a moved head computes them afresh", async () => {
    const { cache, computed } = counting();
    await cache.digestsFor(base);
    const recut = structuredClone(base);
    recut.chapters[0].files[0].hunks = undefined;
    await cache.digestsFor(recut);
    await cache.digestsFor({ ...recut, headSha: "f".repeat(40) });
    assert.equal(computed.length, 3);
  });

  it("known() has the digests only once they are computed", async () => {
    const held = gate();
    const cache = new DigestCache(async (): Promise<DigestMap> => {
      await held.passed;
      return new Map();
    });
    const pending = cache.digestsFor(base);
    assert.equal(cache.known(base), undefined);
    held.open();
    assert.equal(cache.known(base), undefined);
    const digests = await pending;
    assert.equal(cache.known(structuredClone(base)), digests);
    assert.equal(cache.known({ ...base, fromSha: "e".repeat(40) }), undefined);
  });
});

describe("a CLI burst through both", () => {
  it("a partition and the 33 findings written after it read the blobs once", async () => {
    const disk = { manifest: structuredClone(base) };
    const read = gate();
    const computed: Manifest[] = [];
    const cache = new DigestCache(async (m): Promise<DigestMap> => {
      computed.push(m);
      await read.passed;
      return new Map();
    });
    const painted: Manifest[] = [];
    const checked: Manifest[] = [];
    // The shape of the host's loadRounds: paint from the manifest, then the
    // checkmarks once the digests are in, stopping wherever it was superseded.
    const loads = new Coalescer(async (signal) => {
      const m = structuredClone(disk.manifest);
      await tick();
      if (signal.aborted) {
        return;
      }
      painted.push(m);
      if (await Promise.race([cache.digestsFor(m), aborted(signal)])) {
        checked.push(m);
      }
    });

    void loads.request();
    await tick();
    disk.manifest.chapters[0].files[0].hunks = undefined;
    const writes = [loads.request()];
    for (const n of Array.from({ length: 33 }, (_, i) => i + 1)) {
      await tick();
      disk.manifest.issues = [...(disk.manifest.issues ?? []), finding(n)];
      writes.push(loads.request());
    }
    read.open();
    await writes.at(-1);

    assert.equal(computed.length, 2, "the first partition, then the rewritten one; no finding reads blobs");
    assert.equal(checked.length, 1, "checkmarks land once, for the final state");
    assert.equal(checked[0].issues?.length, 33);
    assert.equal(painted.at(-1)?.issues?.length, 33);
  });
});
