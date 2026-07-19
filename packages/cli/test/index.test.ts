import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  checkTask,
  createTask,
  initProject,
  isCliEntryPoint,
  runCli,
  type CliResult,
} from "../src/index";

const execFileAsync = promisify(execFile);

const CLAUDE_SKILL = ".claude/skills/breadcrumb-handoff/SKILL.md";
const CODEX_SKILL = ".codex/skills/breadcrumb-handoff/SKILL.md";
const AGENTS_SKILL = ".agents/skills/breadcrumb-handoff/SKILL.md";

// creates an empty temporary repository
async function createRepo(branch = "main"): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "breadcrumb-cli-"));

  await execFileAsync("git", ["init", "-b", branch], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "chore: init"], { cwd });

  return cwd;
}

// returns a fresh cli result for direct command calls
function createOutput(): CliResult {
  return {
    exitCode: 0,
    stdout: [],
    stderr: [],
  };
}

// checks whether a path exists
async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// reads a file by repo relative path
function read(cwd: string, rel: string): Promise<string> {
  return readFile(path.join(cwd, rel), "utf8");
}

describe("initProject instruction files", () => {
  it("creates AGENTS.md and CLAUDE.md when none exist", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());

    expect(await read(cwd, "AGENTS.md")).toContain("Breadcrumb Review Handoff");
    expect(await read(cwd, "CLAUDE.md")).toContain("@AGENTS.md");
  });

  it("appends to an existing AGENTS.md without losing content", async () => {
    const cwd = await createRepo();
    await writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS.md\n\nMy own rules.\n", "utf8");

    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());

    const agents = await read(cwd, "AGENTS.md");
    expect(agents).toContain("My own rules.");
    expect(agents).toContain("Breadcrumb Review Handoff");
    expect(await read(cwd, "CLAUDE.md")).toContain("@AGENTS.md");
  });

  it("appends the import to an existing CLAUDE.md without losing content", async () => {
    const cwd = await createRepo();
    await writeFile(path.join(cwd, "CLAUDE.md"), "# CLAUDE.md\n\nUse pnpm.\n", "utf8");

    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());

    const claude = await read(cwd, "CLAUDE.md");
    expect(claude).toContain("Use pnpm.");
    expect(claude).toContain("@AGENTS.md");
    expect(await read(cwd, "AGENTS.md")).toContain("Breadcrumb Review Handoff");
  });

  it("updates both when both already exist", async () => {
    const cwd = await createRepo();
    await writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS.md\n\nKeep me.\n", "utf8");
    await writeFile(path.join(cwd, "CLAUDE.md"), "# CLAUDE.md\n\nKeep me too.\n", "utf8");

    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());

    const agents = await read(cwd, "AGENTS.md");
    const claude = await read(cwd, "CLAUDE.md");
    expect(agents).toContain("Keep me.");
    expect(agents).toContain("Breadcrumb Review Handoff");
    expect(claude).toContain("Keep me too.");
    expect(claude).toContain("@AGENTS.md");
  });

  it("is idempotent: running twice keeps one managed block", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());
    await initProject(cwd, { agents: ["claude", "codex"] }, createOutput());

    const agents = await read(cwd, "AGENTS.md");
    const blocks = agents.split("Breadcrumb Review Handoff").length - 1;
    expect(blocks).toBe(1);
  });

  it("writes a clean @AGENTS.md import with no managed markers", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["claude"] }, createOutput());
    await initProject(cwd, { agents: ["claude"] }, createOutput());

    const claude = await read(cwd, "CLAUDE.md");
    expect(claude).not.toContain("breadcrumb:pointer");
    expect(claude.match(/@AGENTS\.md/g)?.length).toBe(1);
  });

  it("does not create CLAUDE.md when claude is not selected and none exists", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["codex"] }, createOutput());

    expect(await exists(path.join(cwd, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(cwd, "CLAUDE.md"))).toBe(false);
  });

  it("appends to an existing CLAUDE.md even when only codex is selected", async () => {
    const cwd = await createRepo();
    await writeFile(path.join(cwd, "CLAUDE.md"), "# CLAUDE.md\n", "utf8");

    await initProject(cwd, { agents: ["codex"] }, createOutput());

    expect(await read(cwd, "CLAUDE.md")).toContain("@AGENTS.md");
  });
});

describe("initProject skills", () => {
  it("writes the claude skill for the claude agent", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["claude"] }, createOutput());

    const skill = await read(cwd, CLAUDE_SKILL);
    expect(skill).toContain("name: breadcrumb-handoff");
    expect(skill).toContain("description:");
  });

  it("writes codex and agents skill dirs for the codex agent", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: ["codex"] }, createOutput());

    expect(await exists(path.join(cwd, CODEX_SKILL))).toBe(true);
    expect(await exists(path.join(cwd, AGENTS_SKILL))).toBe(true);
    expect(await exists(path.join(cwd, CLAUDE_SKILL))).toBe(false);
  });

  it("writes no skills when agents is empty", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());

    expect(await exists(path.join(cwd, CLAUDE_SKILL))).toBe(false);
    expect(await exists(path.join(cwd, CODEX_SKILL))).toBe(false);
    expect(await exists(path.join(cwd, AGENTS_SKILL))).toBe(false);
  });
});

describe("runCli init", () => {
  it("parses --agent and writes only the chosen skill", async () => {
    const cwd = await createRepo();

    await runCli(["init", "--agent", "claude"], cwd);

    expect(await exists(path.join(cwd, CLAUDE_SKILL))).toBe(true);
    expect(await exists(path.join(cwd, CODEX_SKILL))).toBe(false);
  });

  it("writes no skills for --agent none", async () => {
    const cwd = await createRepo();

    await runCli(["init", "--agent", "none"], cwd);

    expect(await exists(path.join(cwd, CLAUDE_SKILL))).toBe(false);
    expect(await exists(path.join(cwd, CODEX_SKILL))).toBe(false);
    expect(await read(cwd, "AGENTS.md")).toContain("Breadcrumb Review Handoff");
  });

  it("defaults to claude and codex when no flag and not a tty", async () => {
    const cwd = await createRepo();

    await runCli(["init"], cwd);

    expect(await exists(path.join(cwd, CLAUDE_SKILL))).toBe(true);
    expect(await exists(path.join(cwd, CODEX_SKILL))).toBe(true);
  });
});

describe("createTask", () => {
  it("creates a task review file", async () => {
    const cwd = await createRepo();
    const output = createOutput();

    await initProject(cwd, { agents: [] }, output);
    await createTask(cwd, "quote-add-ons", output);

    const review = await readFile(
      path.join(cwd, ".breadcrumb", "tasks", "quote-add-ons", "review.yml"),
      "utf8",
    );

    expect(review).toContain("id: quote-add-ons");
  });
});

describe("checkTask", () => {
  it("passes for a valid handoff that matches the git diff", async () => {
    const cwd = await createRepo();
    const output = createOutput();

    await initProject(cwd, { agents: [] }, output);
    await execFileAsync("git", ["checkout", "-b", "feature/test"], { cwd });
    await writeFile(path.join(cwd, "src.ts"), "export const value = 1;\n", "utf8");
    await createTask(cwd, "quote-add-ons", output);
    await writeFile(
      path.join(cwd, ".breadcrumb", "tasks", "quote-add-ons", "review.yml"),
      getValidReviewYaml(),
      "utf8",
    );

    const checkOutput = createOutput();
    await checkTask(cwd, "quote-add-ons", { json: false, strict: false }, checkOutput);

    expect(checkOutput.exitCode).toBe(0);
    expect(checkOutput.stdout).toContain("breadcrumb check passed");
  });

  it("returns json errors for invalid yaml", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());
    await createTask(cwd, "bad", createOutput());
    await writeFile(
      path.join(cwd, ".breadcrumb", "tasks", "bad", "review.yml"),
      "version: [",
      "utf8",
    );

    const output = createOutput();
    await checkTask(cwd, "bad", { json: true, strict: false }, output);

    const parsed = JSON.parse(output.stdout[0] ?? "{}") as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(output.exitCode).toBe(1);
  });
});

describe("runCli", () => {
  it("shows help when no command is passed", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("breadcrumb init");
  });
});

describe("isCliEntryPoint", () => {
  it("detects direct node execution", () => {
    const modulePath = path.join(os.tmpdir(), "breadcrumb", "dist", "index.js");
    const moduleUrl = pathToFileURL(modulePath).href;

    expect(isCliEntryPoint(modulePath, moduleUrl)).toBe(true);
  });

  it("detects symlinked package entrypoints", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "breadcrumb-entry-"));
    const storeDir = path.join(cwd, "store", "@adikuma", "breadcrumb", "dist");
    const linkDir = path.join(cwd, "global", "node_modules", "@adikuma", "breadcrumb", "dist");

    await mkdir(storeDir, { recursive: true });
    await mkdir(linkDir, { recursive: true });

    const realEntry = path.join(storeDir, "index.js");
    const linkedEntry = path.join(linkDir, "index.js");

    await writeFile(realEntry, "", "utf8");

    try {
      await symlink(realEntry, linkedEntry, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }

      throw error;
    }

    const moduleUrl = pathToFileURL(realEntry).href;

    expect(isCliEntryPoint(linkedEntry, moduleUrl)).toBe(true);
  });

  it("does not match unrelated breadcrumb-named files", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "breadcrumb-entry-"));
    const modulePath = path.join(cwd, "package", "dist", "index.js");
    const otherPath = path.join(cwd, "bin", "breadcrumb");

    await mkdir(path.dirname(modulePath), { recursive: true });
    await mkdir(path.dirname(otherPath), { recursive: true });
    await writeFile(modulePath, "", "utf8");
    await writeFile(otherPath, "", "utf8");

    expect(isCliEntryPoint(otherPath, pathToFileURL(modulePath).href)).toBe(false);
  });
});

// runs a callback with temporary env values restored afterwards
async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// commits everything in the repo with one message
async function commitAll(cwd: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", message], { cwd });
}

// creates a feature branch with one source change and a filled handoff
async function createCiRepo(id = "quote-add-ons"): Promise<string> {
  const cwd = await createRepo();

  await initProject(cwd, { agents: [] }, createOutput());
  await commitAll(cwd, "chore: breadcrumb init");
  await execFileAsync("git", ["checkout", "-b", "feature/ci"], { cwd });
  await writeFile(path.join(cwd, "src.ts"), "export const value = 1;\n", "utf8");
  await createTask(cwd, id, createOutput());
  await writeFile(
    path.join(cwd, ".breadcrumb", "tasks", id, "review.yml"),
    getValidReviewYaml(),
    "utf8",
  );
  await commitAll(cwd, "feat: add value");

  return cwd;
}

describe("runCli check --ci", () => {
  it("discovers the task from the branch diff and passes", async () => {
    const cwd = await createCiRepo();

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("breadcrumb check passed");
    });
  });

  it("fails when the pull request has no handoff", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());
    await commitAll(cwd, "chore: breadcrumb init");
    await execFileAsync("git", ["checkout", "-b", "feature/ci"], { cwd });
    await writeFile(path.join(cwd, "src.ts"), "export const value = 1;\n", "utf8");
    await commitAll(cwd, "feat: add value");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.join("\n")).toContain("no handoff");
      expect(result.stdout.join("\n")).toContain("::error title=breadcrumb::");
    });
  });

  it("fails when two handoffs are touched on one branch", async () => {
    const cwd = await createCiRepo();

    await createTask(cwd, "second-task", createOutput());
    await commitAll(cwd, "chore: second handoff");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.join("\n")).toContain("exactly one handoff");
    });
  });

  it("is strict and annotates undescribed changed files", async () => {
    const cwd = await createCiRepo();

    await writeFile(path.join(cwd, "extra.ts"), "export const extra = 2;\n", "utf8");
    await commitAll(cwd, "feat: extra file");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout.join("\n")).toContain(
        "::error file=.breadcrumb/tasks/quote-add-ons/review.yml",
      );
      expect(result.stdout.join("\n")).toContain("extra.ts");
    });
  });

  it("writes a step summary when the env var points at a file", async () => {
    const cwd = await createCiRepo();
    const summaryPath = path.join(cwd, "summary.md");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summaryPath }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(0);
    });

    expect(await readFile(summaryPath, "utf8")).toContain("breadcrumb check passed");
  });

  it("keeps json output parseable and free of annotation lines", async () => {
    const cwd = await createCiRepo();

    await writeFile(path.join(cwd, "extra.ts"), "export const extra = 2;\n", "utf8");
    await commitAll(cwd, "feat: extra file");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci", "--json"], cwd);

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.join("\n")) as { ok: boolean };
      expect(parsed.ok).toBe(false);
      expect(result.stdout.join("\n")).not.toContain("::error");
    });
  });

  it("emits json for a discovery failure under --json", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());
    await commitAll(cwd, "chore: breadcrumb init");
    await execFileAsync("git", ["checkout", "-b", "feature/ci"], { cwd });
    await writeFile(path.join(cwd, "src.ts"), "export const value = 1;\n", "utf8");
    await commitAll(cwd, "feat: add value");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci", "--json"], cwd);

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.join("\n")) as {
        ok: boolean;
        errors: { code: string }[];
      };
      expect(parsed.errors[0]?.code).toBe("handoff_missing");
    });
  });

  it("fails friendly when the base ref does not resolve", async () => {
    const cwd = await createCiRepo();

    await withEnv({ GITHUB_BASE_REF: "ghost", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.join("\n")).toContain("was not found in this checkout");
      expect(result.stderr.join("\n")).toContain("fetch-depth");
    });
  });

  it("fails friendly for an unsafe task directory name", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());
    await commitAll(cwd, "chore: breadcrumb init");
    await execFileAsync("git", ["checkout", "-b", "feature/ci"], { cwd });
    await mkdir(path.join(cwd, ".breadcrumb", "tasks", "my task"), { recursive: true });
    await writeFile(
      path.join(cwd, ".breadcrumb", "tasks", "my task", "review.yml"),
      getValidReviewYaml(),
      "utf8",
    );
    await commitAll(cwd, "feat: odd handoff dir");

    await withEnv({ GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: undefined }, async () => {
      const result = await runCli(["check", "--ci"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.join("\n")).toContain("not a safe task directory name");
    });
  });

  it("reports a friendly error for a missing review file with --task", async () => {
    const cwd = await createRepo();

    await initProject(cwd, { agents: [] }, createOutput());

    const result = await runCli(["check", "--task", "ghost"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("was not found");
  });
});

describe("runCli init --workflow", () => {
  it("writes the pr gate workflow", async () => {
    const cwd = await createRepo();

    await runCli(["init", "--agent", "none", "--workflow"], cwd);

    const workflow = await read(cwd, ".github/workflows/breadcrumb.yml");
    expect(workflow).toContain("check --ci");
    expect(workflow).toContain("breadcrumb-skip");
  });

  it("never overwrites an existing workflow file", async () => {
    const cwd = await createRepo();
    const target = path.join(cwd, ".github", "workflows", "breadcrumb.yml");

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "name: mine\n", "utf8");

    const result = await runCli(["init", "--agent", "none", "--workflow"], cwd);

    expect(await read(cwd, ".github/workflows/breadcrumb.yml")).toBe("name: mine\n");
    expect(result.stdout.join("\n")).toContain("left unchanged");
  });

  it("skips the workflow without the flag when not a tty", async () => {
    const cwd = await createRepo();

    await runCli(["init", "--agent", "none"], cwd);

    expect(await exists(path.join(cwd, ".github", "workflows", "breadcrumb.yml"))).toBe(false);
  });
});

// returns a valid review yaml for the temp repository
function getValidReviewYaml(): string {
  return `version: 1
id: quote-add-ons
title: Add quote add-ons
user_goal: Add quote add-ons.
summary: Adds one source file.
review_sequence:
  - title: Source
    why: This file contains the behavior.
    files:
      - src.ts
files:
  - path: src.ts
    why: Adds the behavior.
    risk: low
    change: feature
    unknowns: []
    tests: []
`;
}
