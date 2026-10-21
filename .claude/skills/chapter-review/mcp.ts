// chapter-review's MCP server: the CLI's commands as typed tools over stdio, so
// an agent calls them without assembling a `node <path>/chapter-review` line.
//
// Each tool call runs the CLI as a child process rather than importing the
// commands. They report by printing and exiting, and `write` reads its draft
// from stdin, which here carries the protocol: run in-process, the first exit
// would end the server and `write` would consume the protocol stream as a draft.
//
// Calls run synchronously, so the server handles one at a time. That is the
// CLI's own contract (each command reads the manifest, changes one thing and
// writes it back), enforced here instead of left to the caller.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { errorMessage, isRecord, tryReadJson } from "./util.ts";

const CLI = path.join(import.meta.dirname, "chapter-review");

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;

interface Invocation {
  args: string[];
  input?: string;
}

interface Tool {
  name: string;
  description: string;
  readOnly: boolean;
  properties: Record<string, object>;
  required: string[];
  invocation: (args: Args) => Invocation;
}

function optString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function reqString(args: Args, key: string): string {
  const value = optString(args, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function optBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

const HUNK_KEYS = ["oldStart", "oldLines", "newStart", "newLines"] as const;

/** A hunk object in the CLI's `--hunk` spelling. The CLI validates the numbers. */
function hunkSpec(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${key} must be an object`);
  const parts = HUNK_KEYS.map((k) => value[k]);
  if (!parts.every((n): n is number => typeof n === "number")) {
    throw new Error(`${key} needs numeric ${HUNK_KEYS.join(", ")}`);
  }
  return parts.map(String).join(",");
}

const optHunk = (args: Args): string | undefined => hunkSpec(args.hunk, "hunk");

function optLine(args: Args): string | undefined {
  const value = args.line;
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("line must be a number");
  return String(value);
}

function causeFlags(args: Args): string[] {
  const value = args.cause;
  if (value === undefined) return [];
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new Error("cause must be an object with a path");
  }
  return [
    "--cause-path",
    value.path,
    ...flag("--cause-hunk", hunkSpec(value.hunk, "cause.hunk")),
  ];
}

const flag = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [name, value];

const issueFlags = (args: Args): string[] => [
  ...flag("--path", optString(args, "path")),
  ...flag("--severity", optString(args, "severity")),
  ...flag("--note", optString(args, "note")),
  ...flag("--confidence", optString(args, "confidence")),
  ...flag("--chapter", optString(args, "chapter")),
  ...flag("--hunk", optHunk(args)),
  ...flag("--old-path", optString(args, "old_path")),
  ...flag("--status", optString(args, "status")),
  ...flag("--line", optLine(args)),
  ...causeFlags(args),
];

const ACTIONS = ["resolve", "reopen", "verify", "unverify", "rm"];

const PATH = { type: "string", description: "Repo-relative path of a file in the diff." };
const HUNK = {
  type: "object",
  description: "A hunk range copied from the diff's @@ header, as in the manifest's `hunks`.",
  properties: Object.fromEntries(HUNK_KEYS.map((k) => [k, { type: "integer", minimum: 0 }])),
  required: HUNK_KEYS,
  additionalProperties: false,
};
const ID = { type: "string", description: "A finding id, e.g. iss-2.1." };
const ISSUE_FIELDS = {
  path: {
    type: "string",
    description:
      "Repo-relative path of the file the finding is about: a file in the diff, or with `line` a file the branch left wrong without changing it.",
  },
  line: {
    type: "integer",
    minimum: 1,
    description:
      "The line the finding is about, in `path` at the reviewed commit; the extension opens the finding there. Required for a `path` outside the diff. In the diff it also picks the range, so `hunk` can be left out.",
  },
  cause: {
    type: "object",
    description:
      "For a finding outside the diff: the change in the diff that left the file wrong. Its chapter becomes the finding's.",
    properties: { path: PATH, hunk: HUNK },
    required: ["path"],
    additionalProperties: false,
  },
  severity: { type: "string", enum: ["critical", "high", "low"] },
  note: { type: "string", description: "One problem, one line." },
  confidence: { type: "string", enum: ["suspected", "verified"] },
  chapter: { type: "string", pattern: "^ch-[0-9]+$", description: "Owning chapter, e.g. ch-2." },
  hunk: HUNK,
  old_path: { type: "string", description: "The path before a rename." },
};

const TOOLS: Tool[] = [
  {
    name: "focus",
    description: "What the reviewer is looking at in the extension. Same as `chapter-review focus`.",
    readOnly: true,
    properties: {},
    required: [],
    invocation: () => ({ args: ["focus"] }),
  },
  {
    name: "show",
    description: "The current manifest as JSON. Same as `chapter-review show`.",
    readOnly: true,
    properties: {},
    required: [],
    invocation: () => ({ args: ["show"] }),
  },
  {
    name: "base_check",
    description:
      "Whether the review base is fresh, as JSON with an `action`. Read-only, never fetches. Same as `chapter-review base-check [base]`.",
    readOnly: true,
    properties: {
      base: { type: "string", description: "The base you resolved. Omit to let the command resolve it." },
    },
    required: [],
    invocation: (a) => {
      const base = optString(a, "base");
      return { args: base === undefined ? ["base-check"] : ["base-check", base] };
    },
  },
  {
    name: "write",
    description:
      "Validate a partition draft and install it. Pass the draft inline as `draft` or as a `file` path, not both. Same as `chapter-review write [file] [--dry-run]`.",
    readOnly: false,
    properties: {
      draft: { type: "object", description: "The partition draft (chapters, unassigned, meta; no issues)." },
      file: { type: "string", description: "Path to a draft file, absolute or relative to `repo`." },
      dry_run: { type: "boolean", description: "Run every check and print the report, install nothing." },
    },
    required: [],
    invocation: (a) => {
      const file = optString(a, "file");
      const { draft } = a;
      if ((file === undefined) === (draft === undefined)) {
        throw new Error("pass exactly one of draft or file");
      }
      const dryRun = optBoolean(a, "dry_run") === true ? ["--dry-run"] : [];
      return file === undefined
        ? { args: ["write", ...dryRun], input: JSON.stringify(draft) }
        : { args: ["write", file, ...dryRun] };
    },
  },
  {
    name: "uncheck",
    description: "Clear the reviewer's checkmark on a file, or one hunk of it. Same as `chapter-review uncheck`.",
    readOnly: false,
    properties: { path: PATH, hunk: HUNK },
    required: ["path"],
    invocation: (a) => ({
      args: ["uncheck", "--path", reqString(a, "path"), ...flag("--hunk", optHunk(a))],
    }),
  },
  {
    name: "issue_add",
    description: "Record a finding. The id and owning chapter are assigned for you. Same as `chapter-review issue add`.",
    readOnly: false,
    properties: ISSUE_FIELDS,
    required: ["path", "severity", "note"],
    invocation: (a) => ({ args: ["issue", "add", ...issueFlags(a)] }),
  },
  {
    name: "issue_set",
    description: "Revise a finding's fields. Needs at least one field. Same as `chapter-review issue set <id>`.",
    readOnly: false,
    properties: { id: ID, ...ISSUE_FIELDS, status: { type: "string", enum: ["open", "resolved"] } },
    required: ["id"],
    invocation: (a) => ({ args: ["issue", "set", reqString(a, "id"), ...issueFlags(a)] }),
  },
  {
    name: "issue_update",
    description:
      "Resolve, reopen, verify, unverify or remove a finding. Same as `chapter-review issue <action> <id>`.",
    readOnly: false,
    properties: { id: ID, action: { type: "string", enum: ACTIONS } },
    required: ["id", "action"],
    invocation: (a) => {
      const action = reqString(a, "action");
      if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
      return { args: ["issue", action, reqString(a, "id")] };
    },
  },
  {
    name: "issue_list",
    description: "List the findings. Same as `chapter-review issue list`.",
    readOnly: true,
    properties: {},
    required: [],
    invocation: () => ({ args: ["issue", "list"] }),
  },
];

const REPO = {
  type: "string",
  description:
    "Absolute path of the repository under review. The server's own working directory is wherever the agent was launched, so it is never assumed.",
};

function describe(tool: Tool): object {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: { repo: REPO, ...tool.properties },
      required: ["repo", ...tool.required],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: tool.readOnly },
  };
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

const result = (text: string, isError: boolean): ToolResult => ({
  content: [{ type: "text", text }],
  isError,
});

function requireRepo(args: Args): string {
  const repo = reqString(args, "repo");
  if (!path.isAbsolute(repo)) throw new Error(`repo must be an absolute path (got "${repo}")`);
  const stat = statSync(repo, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`repo is not a directory: ${repo}`);
  return repo;
}

function call(tool: Tool, args: Args): ToolResult {
  const prepared = (() => {
    try {
      return { repo: requireRepo(args), run: tool.invocation(args) };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  })();
  if ("error" in prepared) return result(`chapter-review: ${prepared.error}`, true);

  const r = spawnSync(process.execPath, [CLI, ...prepared.run.args], {
    cwd: prepared.repo,
    input: prepared.run.input ?? "",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) return result(`chapter-review: could not run the CLI: ${errorMessage(r.error)}`, true);
  const text = [r.stdout, r.stderr].map((s) => s.trimEnd()).filter((s) => s !== "").join("\n");
  return result(text === "" ? "(no output)" : text, r.status !== 0);
}

/** The bundle's content hash, which is the skill's only identity; see bundle-skill.mts. */
function serverVersion(): string {
  try {
    const skillMd = readFileSync(path.join(import.meta.dirname, "SKILL.md"), "utf8");
    return /^\s*contentHash:\s*["']?([^"'\s]+)/m.exec(skillMd)?.[1] ?? "unbundled";
  } catch {
    return "unbundled";
  }
}

type Id = string | number;

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const reply = (id: Id, value: object): void => {
  send({ jsonrpc: "2.0", id, result: value });
};
const fail = (id: Id | null, code: number, message: string): void => {
  send({ jsonrpc: "2.0", id, error: { code, message } });
};

function negotiate(params: unknown): string {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSIONS[0];
}

function handle(message: unknown): void {
  if (!isRecord(message) || typeof message.method !== "string") return;
  const { id, method, params } = message;
  if (typeof id !== "string" && typeof id !== "number") return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: negotiate(params),
        capabilities: { tools: {} },
        serverInfo: { name: "chapter-review", version: serverVersion() },
        instructions:
          "The chapter-review skill's commands as tools. Every tool takes `repo`, the absolute path of the repository under review.",
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS.map(describe) });
      return;
    case "tools/call": {
      const name = isRecord(params) ? params.name : undefined;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool || !isRecord(params)) {
        fail(id, -32602, `unknown tool: ${String(name)}`);
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      reply(id, call(tool, args));
      return;
    }
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "") return;
  const parsed = tryReadJson(() => line);
  if (parsed.ok) {
    handle(parsed.value);
  } else {
    fail(null, -32700, "parse error");
  }
});
