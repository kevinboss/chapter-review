// The MCP server: the CLI's commands as tools over stdio JSON-RPC. Drives the
// server as a subprocess, started outside the repo under review, the way an
// agent launched elsewhere would start it.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  draft,
  makeNonGitDir,
  OK_CHAPTERS,
  parseJsonAs,
  SKILL_DIR,
  withRepo,
  withWrittenRepo,
} from "./helpers.ts";

const SERVER = path.join(SKILL_DIR, "mcp.ts");

/** Every reply shape these tests read, merged: each test reads only its own fields. */
interface Response {
  id: unknown;
  result?: {
    protocolVersion?: string;
    capabilities?: unknown;
    tools?: { name: string; inputSchema: { required: string[] } }[];
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

interface ToolOutput {
  text: string;
  isError: boolean;
}

/** Send `messages` as one stdin session, closing it after, and return every reply line. */
function session(messages: object[], cwd?: string): Response[] {
  const outside = makeNonGitDir();
  try {
    const r = spawnSync(process.execPath, [SERVER], {
      cwd: cwd ?? outside.dir,
      input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => parseJsonAs<Response>(l));
  } finally {
    outside.cleanup();
  }
}

const request = (id: number, method: string, params?: object): object => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

const toolCall = (id: number, name: string, args: object): object =>
  request(id, "tools/call", { name, arguments: args });

/** Run tool calls in order within one session and return each one's text and error flag. */
function tools(calls: [string, object][]): ToolOutput[] {
  const replies = session(calls.map(([name, args], i) => toolCall(i + 1, name, args)));
  return calls.map((_, i) => {
    const reply = replies.find((r) => r.id === i + 1);
    const { content, isError } = reply?.result ?? {};
    assert.ok(content && isError !== undefined, `no tool result for call ${String(i + 1)}: ${JSON.stringify(reply)}`);
    return { text: content.map((c) => c.text).join("\n"), isError };
  });
}

test("initialize answers with tools and the protocol version the client asked for", () => {
  const [init, list] = session([
    request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request(2, "tools/list"),
  ]);
  assert.equal(init.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });

  const listed = list.result?.tools ?? [];
  assert.deepEqual(
    listed.map((t) => t.name),
    ["focus", "show", "base_check", "write", "uncheck", "issue_add", "issue_set", "issue_update", "issue_list"]
  );
  for (const t of listed) {
    assert.ok(t.inputSchema.required.includes("repo"), `${t.name} must require repo`);
  }
});

test("an unknown protocol version gets the newest one the server speaks", () => {
  const [init] = session([request(1, "initialize", { protocolVersion: "1999-01-01" })]);
  assert.equal(init.result?.protocolVersion, "2025-11-25");
});

test("a notification gets no reply, and an unknown method or tool is a JSON-RPC error", () => {
  const replies = session([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request(1, "resources/list"),
    toolCall(2, "nope", {}),
  ]);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].error?.code, -32601);
  assert.equal(replies[1].error?.code, -32602);
});

test("a line that is not JSON is a parse error, and the session carries on", () => {
  const outside = makeNonGitDir();
  try {
    const r = spawnSync(process.execPath, [SERVER], {
      cwd: outside.dir,
      input: `not json\n${JSON.stringify(request(1, "ping"))}\n`,
      encoding: "utf8",
    });
    const [parseError, ping] = r.stdout.trim().split("\n").map((l) => parseJsonAs<Response>(l));
    assert.equal(parseError.error?.code, -32700);
    assert.deepEqual(ping.result, {});
  } finally {
    outside.cleanup();
  }
});

test("write installs an inline draft into the repo named, not the server's cwd", () => {
  withRepo((repo) => {
    const inline = parseJsonAs<object>(draft(repo, OK_CHAPTERS));
    const [dry, real] = tools([
      ["write", { repo: repo.dir, draft: inline, dry_run: true }],
      ["write", { repo: repo.dir, draft: inline }],
    ]);
    assert.equal(dry.isError, false, dry.text);
    assert.match(dry.text, /^Would write/m);
    assert.equal(real.isError, false, real.text);
    assert.equal(repo.readManifest().chapters.length, 2);
  });
});

test("write takes a draft file relative to the repo", () => {
  withRepo((repo) => {
    writeFileSync(path.join(repo.dir, "draft.json"), draft(repo, OK_CHAPTERS));
    const [r] = tools([["write", { repo: repo.dir, file: "draft.json", dry_run: true }]]);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^Would write/m);
    assert.equal(repo.manifestExists(), false, "a dry run installs nothing");
  });
});

test("write refuses both or neither of draft and file", () => {
  withRepo((repo) => {
    const [neither, both] = tools([
      ["write", { repo: repo.dir }],
      ["write", { repo: repo.dir, file: "x.json", draft: {} }],
    ]);
    assert.equal(neither.isError, true);
    assert.match(neither.text, /exactly one of draft or file/);
    assert.equal(both.isError, true);
  });
});

test("the issue tools record, revise and resolve a finding, hunk given as an object", () => {
  withWrittenRepo((repo) => {
    const hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 };
    const [add, set, resolve, list] = tools([
      ["issue_add", { repo: repo.dir, path: "a.txt", severity: "low", note: "smell", hunk }],
      ["issue_set", { repo: repo.dir, id: "iss-2.1", severity: "high" }],
      ["issue_update", { repo: repo.dir, id: "iss-2.1", action: "resolve" }],
      ["issue_list", { repo: repo.dir }],
    ]);
    for (const r of [add, set, resolve, list]) assert.equal(r.isError, false, r.text);
    const [issue] = repo.readManifest().issues ?? [];
    assert.equal(issue.id, "iss-2.1");
    assert.equal(issue.chapterId, "ch-2");
    assert.equal(issue.severity, "high");
    assert.equal(issue.status, "resolved");
    assert.deepEqual(issue.hunk, hunk);
  });
});

test("issue_update refuses an action outside its list", () => {
  withWrittenRepo((repo) => {
    const [r] = tools([["issue_update", { repo: repo.dir, id: "iss-2.1", action: "add" }]]);
    assert.equal(r.isError, true);
    assert.match(r.text, /action must be one of/);
  });
});

test("a CLI failure comes back as a tool error carrying the CLI's message", () => {
  withWrittenRepo((repo) => {
    const [r] = tools([["issue_add", { repo: repo.dir, path: "b.txt", severity: "blocker", note: "z" }]]);
    assert.equal(r.isError, true);
    assert.match(r.text, /--severity/);
  });
});

test("repo must be an absolute path to a directory", () => {
  withRepo((repo) => {
    const [missing, relative, notDir] = tools([
      ["show", {}],
      ["show", { repo: "." }],
      ["show", { repo: path.join(repo.dir, "a.txt") }],
    ]);
    assert.match(missing.text, /repo is required/);
    assert.match(relative.text, /absolute path/);
    assert.match(notDir.text, /not a directory/);
    for (const r of [missing, relative, notDir]) assert.equal(r.isError, true);
  });
});

test("the read-only tools report the repo's state", () => {
  withWrittenRepo((repo) => {
    const [show, focus, base] = tools([
      ["show", { repo: repo.dir }],
      ["focus", { repo: repo.dir }],
      ["base_check", { repo: repo.dir, base: "main" }],
    ]);
    assert.equal(parseJsonAs<{ chapters: unknown[] }>(show.text).chapters.length, 2);
    assert.match(focus.text, /No focus yet/);
    assert.equal(parseJsonAs<{ action: string }>(base.text).action, "ok");
  });
});
