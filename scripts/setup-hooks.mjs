import { execFileSync } from "node:child_process";

function runGit(args) {
  execFileSync("git", args, { stdio: "ignore" });
}

try {
  runGit(["rev-parse", "--is-inside-work-tree"]);
  runGit(["config", "--local", "core.hooksPath", ".githooks"]);
} catch {
  // Skip hook setup outside a git working tree.
}
