// generates throwaway fake repos under testbeds/ for manual and agent testing
// run: node packages/cli/scripts/make-testbeds.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const testbedsRoot = path.join(repoRoot, "testbeds");

// a tiny fake app so breadcrumb check has real changed files to compare against
const appFiles = {
  "package.json": `${JSON.stringify(
    { name: "fake-app", version: "0.0.0", private: true },
    null,
    2,
  )}\n`,
  "src/index.ts": "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
  "src/total.ts":
    "export function total(values: number[]) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n",
};

const cases = [
  { name: "none", files: {} },
  {
    name: "has-agents",
    files: { "AGENTS.md": "# AGENTS.md\n\nUse pnpm. Run tests before pushing.\n" },
  },
  {
    name: "has-claude",
    files: { "CLAUDE.md": "# CLAUDE.md\n\nUse pnpm. Keep modules small.\n" },
  },
  {
    name: "has-both",
    files: {
      "AGENTS.md": "# AGENTS.md\n\nUse pnpm.\n",
      "CLAUDE.md": "# CLAUDE.md\n\nUse pnpm.\n",
    },
  },
  { name: "app", files: {} },
];

// writes a map of relative paths into a directory creating parent dirs
function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

// initializes a git repo with one commit so diffs and default branch work
function initGit(dir) {
  const opts = { cwd: dir, stdio: "ignore" };
  execFileSync("git", ["init", "-b", "main"], opts);
  execFileSync("git", ["config", "user.email", "testbed@example.com"], opts);
  execFileSync("git", ["config", "user.name", "Testbed"], opts);
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-m", "chore: init"], opts);
}

rmSync(testbedsRoot, { recursive: true, force: true });

for (const testCase of cases) {
  const dir = path.join(testbedsRoot, testCase.name);
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, appFiles);
  writeFiles(dir, testCase.files);
  initGit(dir);
  console.log(`created testbeds/${testCase.name}`);
}

console.log("\nrun the interactive picker:");
console.log("  cd testbeds/none && node ../../packages/cli/dist/index.js init");
