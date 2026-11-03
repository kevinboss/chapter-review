import { die } from "./util.ts";
import { gitDir } from "./git.ts";
import { drop, parkedReviews } from "./park.ts";

/**
 * parked: list the branch reviews a worktree review displaced, or drop one. A
 * review parked for a branch that is gone waits forever, since only a write or
 * a discard on that branch brings it back.
 */
export function cmdParked(argv: string[]): void {
  gitDir();
  if (argv.length === 0) {
    process.stdout.write(JSON.stringify(parkedReviews(), null, 2) + "\n");
    return;
  }
  const [action, name] = argv;
  if (action !== "drop" || argv.length !== 2) {
    die("chapter-review: usage: parked [drop <name>]", 2);
  }
  if (!drop(name)) die(`chapter-review: nothing is parked as "${name}".`);
  console.log(`Dropped the review parked as "${name}".`);
}
