// packs the cli and protocol tarballs installs them into a clean dir and runs the installed binary
// validates the published artifact instead of the source tree so failures surface before publish run: node packages/cli/scripts/smoke-pack.mjs
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, "..");
const protocolDir = path.resolve(scriptDir, "..", "..", "protocol");
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

// runs a shell command so npm pnpm corepack and git all resolve cross platform
function sh(command, cwd) {
  execSync(command, { cwd, stdio: "inherit" });
}

function quote(value) {
  return `"${value}"`;
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "breadcrumb-smoke-"));
const packDir = path.join(tmpRoot, "pack");
const installDir = path.join(tmpRoot, "install");
const repoDir = path.join(tmpRoot, "repo");

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  console.log("building protocol and cli...");
  sh("corepack pnpm --filter @adikuma/breadcrumb-protocol build", repoRoot);
  sh("corepack pnpm --filter @adikuma/breadcrumb build", repoRoot);

  console.log("packing tarballs...");
  sh(`corepack pnpm pack --pack-destination ${quote(packDir)}`, protocolDir);
  sh(`corepack pnpm pack --pack-destination ${quote(packDir)}`, cliDir);

  const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
  const protocolTar = tarballs.find((file) => file.includes("breadcrumb-protocol"));
  const cliTar = tarballs.find((file) => !file.includes("breadcrumb-protocol"));
  if (!protocolTar || !cliTar) {
    throw new Error(`expected both tarballs, found: ${tarballs.join(", ")}`);
  }

  console.log(`installing ${cliTar} into a clean dir...`);
  writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "smoke", version: "0.0.0", private: true }, null, 2)}\n`,
    "utf8",
  );
  const cliPath = quote(path.join(packDir, cliTar));
  const protocolPath = quote(path.join(packDir, protocolTar));
  sh(`npm install --no-audit --no-fund ${cliPath} ${protocolPath}`, installDir);

  console.log("running the installed cli in a fresh repo...");
  writeFileSync(path.join(repoDir, "README.md"), "# smoke\n", "utf8");
  sh("git init -b main", repoDir);
  sh('git config user.email "smoke@example.com"', repoDir);
  sh('git config user.name "Smoke"', repoDir);
  sh("git add .", repoDir);
  sh('git commit -m "chore: init"', repoDir);

  const installedCli = path.join(
    installDir,
    "node_modules",
    "@adikuma",
    "breadcrumb",
    "dist",
    "index.js",
  );
  sh(`node ${quote(installedCli)} init --agent claude,codex`, repoDir);

  const expected = [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/skills/breadcrumb-handoff/SKILL.md",
    ".codex/skills/breadcrumb-handoff/SKILL.md",
    ".agents/skills/breadcrumb-handoff/SKILL.md",
  ];
  const missing = expected.filter((relative) => !existsSync(path.join(repoDir, relative)));
  if (missing.length > 0) {
    throw new Error(`packaged cli did not create: ${missing.join(", ")}`);
  }

  console.log("\nsmoke test passed: packaged cli works end to end.");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
