// Argument dispatch and usage for the chapter-review command. Each command lives
// in a sibling cmd-*.ts module over the shared git/manifest/flags helpers.
//
// This is a module rather than the executable itself because the executable has
// to stay extensionless to be run as `chapter-review`, and Node only strips types
// from .ts/.mts/.cts files — so an extensionless entry file cannot carry types,
// and neither tsconfig (`include: ["*.ts"]`) nor ESLint would ever check it.
// Keeping the logic here puts the dispatch under both.

import { cmdBaseCheck } from "./cmd-base-check.ts";
import { cmdFocus, cmdShow } from "./cmd-read.ts";
import { cmdIssue } from "./cmd-issue.ts";
import { cmdUncheck } from "./cmd-uncheck.ts";
import { cmdWrite } from "./cmd-write.ts";

function usage(code: number): never {
  console.error(
    [
      "usage: chapter-review <command>",
      "",
      "  focus                     print what the reviewer is looking at",
      "  show                      print the current manifest",
      "  base-check [base]         report whether the review base is fresh (read-only)",
      "  write [file] [--dry-run]  validate a partition draft, then install it (stdin if no file)",
      "                            --dry-run reports the counts and changes nothing",
      "  uncheck <flags>           clear a review checkmark (--path [--hunk]) so it re-reads",
      "  issue add    <flags>      record a finding (--path --severity --note [--confidence --chapter --hunk --old-path])",
      "  issue set    <id> <flags> revise a finding",
      "  issue resolve <id>        mark a finding resolved",
      "  issue reopen  <id>        reopen a finding",
      "  issue verify  <id>        mark a finding's premise verified",
      "  issue unverify <id>       mark a finding suspected (premise unchecked)",
      "  issue rm     <id>         drop a finding (its id is retired, not reused)",
      "  issue list                list findings",
      "",
      "  issue --help              flags for `issue add` and `issue set`",
    ].join("\n")
  );
  process.exit(code);
}

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "focus":
      cmdFocus();
      break;
    case "show":
      cmdShow();
      break;
    case "base-check":
      cmdBaseCheck(rest[0]);
      break;
    case "write":
      cmdWrite(rest);
      break;
    case "uncheck":
      cmdUncheck(rest);
      break;
    case "issue":
      cmdIssue(rest[0], rest.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      usage(0);
      break;
    default:
      if (cmd) console.error(`chapter-review: unknown command "${cmd}"\n`);
      usage(1);
  }
}
