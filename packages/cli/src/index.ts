#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compareReviewToChangedFiles,
  isBreadcrumbReviewPath,
  parseBreadcrumbReviewYaml,
  type BreadcrumbIssue,
  type ChangedFile,
  type ChangedFileStatus,
} from "@adikuma/breadcrumb-protocol";

import { cancel, confirm, intro, isCancel, select } from "@clack/prompts";

const execFileAsync = promisify(execFile);

const BREADCRUMB_DIR = ".breadcrumb";
const TASKS_DIR = "tasks";
const TEMPLATES_DIR = "templates";
const REVIEW_FILE = "review.yml";
const CONFIG_FILE = "config.yml";
const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const BREADCRUMB_START = "<!-- breadcrumb:start -->";
const BREADCRUMB_END = "<!-- breadcrumb:end -->";

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

type AgentTarget = "claude" | "codex" | "opencode";

const SKILL_NAME = "breadcrumb-handoff";

// repo local skill dirs per agent
// codex is mid migration so this writes both its current dir and the documented cross agent dir
const SKILL_DIRS: Record<AgentTarget, string[]> = {
  claude: [".claude/skills"],
  codex: [".codex/skills", ".agents/skills"],
  opencode: [".opencode/skills"],
};

type CheckOptions = {
  json: boolean;
  strict: boolean;
  base?: string;
  ci?: boolean;
};

type CheckJsonResult = {
  ok: boolean;
  errors: BreadcrumbIssue[];
  warnings: BreadcrumbIssue[];
  coverage?: ReturnType<typeof compareReviewToChangedFiles>;
};

type ParsedArgs = {
  command: string | undefined;
  rest: string[];
  flags: Set<string>;
};

type GitNameStatus = {
  status: string;
  path: string;
  previousPath?: string;
};

// runs the breadcrumb cli and returns captured output
export async function runCli(args: string[], cwd = process.cwd()): Promise<CliResult> {
  const output: CliResult = {
    exitCode: 0,
    stdout: [],
    stderr: [],
  };

  const parsed = parseArgs(args);

  try {
    if (!parsed.command || parsed.flags.has("help") || parsed.flags.has("h")) {
      output.stdout.push(getHelpText());
      return output;
    }

    if (parsed.command === "init") {
      const agents = await resolveAgents(parsed.rest);
      const promptable = getFlagValue(parsed.rest, "--agent") === undefined;
      const workflow = await resolveWorkflow(parsed.flags, promptable);
      await initProject(cwd, { agents, workflow }, output);
      return output;
    }

    if (parsed.command === "task") {
      await runTaskCommand(parsed.rest, cwd, output);
      return output;
    }

    if (parsed.command === "check") {
      await runCheckCommand(parsed.rest, parsed.flags, cwd, output);
      return output;
    }

    output.exitCode = 1;
    output.stderr.push(`unknown command: ${parsed.command}`);
    output.stdout.push(getHelpText());
    return output;
  } catch (error) {
    output.exitCode = 1;
    output.stderr.push(error instanceof Error ? error.message : String(error));
    return output;
  }
}

// resolves which agents get the handoff skill from a flag a prompt or a default
async function resolveAgents(rest: string[]): Promise<AgentTarget[]> {
  const flag = getFlagValue(rest, "--agent");
  if (flag !== undefined) {
    return parseAgentList(flag);
  }
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return promptAgents();
  }
  return ["claude", "codex"];
}

// turns the agents flag like claude/codex both or none into targets
function parseAgentList(value: string): AgentTarget[] {
  const known: AgentTarget[] = ["claude", "codex", "opencode"];
  const parts = value.split(",").map((part) => part.trim().toLowerCase());
  if (parts.includes("none")) {
    return [];
  }
  if (parts.includes("both")) {
    return ["claude", "codex"];
  }
  return known.filter((agent) => parts.includes(agent));
}

// asks an interactive developer which agents should get the skill
async function promptAgents(): Promise<AgentTarget[]> {
  intro("breadcrumb");
  const choice = await select({
    message: "Add the handoff skill for which agents?",
    initialValue: "both",
    options: [
      { value: "both", label: "Both", hint: "claude + codex (recommended)" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "none", label: "None" },
    ],
  });
  if (isCancel(choice)) {
    cancel("cancelled");
    return [];
  }
  return parseAgentList(String(choice));
}

// asks whether init should also write the pr gate workflow
// prompts only during an interactive init that already prompted for agents
async function resolveWorkflow(flags: Set<string>, promptable: boolean): Promise<boolean> {
  if (flags.has("workflow")) {
    return true;
  }
  if (flags.has("no-workflow")) {
    return false;
  }
  if (promptable && process.stdout.isTTY && process.stdin.isTTY) {
    const choice = await confirm({
      message: "Add the pull request gate workflow to .github/workflows?",
      initialValue: false,
    });
    return isCancel(choice) ? false : choice;
  }
  return false;
}

// creates breadcrumb folders agent instruction files and the handoff skill
export async function initProject(
  cwd: string,
  opts: { agents: AgentTarget[]; workflow?: boolean },
  output: CliResult,
): Promise<void> {
  const breadcrumbDir = path.join(cwd, BREADCRUMB_DIR);
  const templatesDir = path.join(breadcrumbDir, TEMPLATES_DIR);
  const tasksDir = path.join(breadcrumbDir, TASKS_DIR);

  await mkdir(templatesDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  const defaultBranch = await detectDefaultBranch(cwd);
  await writeFileIfMissing(
    path.join(breadcrumbDir, CONFIG_FILE),
    getDefaultConfig(defaultBranch),
  );
  await writeFileIfMissing(path.join(templatesDir, REVIEW_FILE), getReviewTemplate());
  output.stdout.push(`created ${BREADCRUMB_DIR}/${CONFIG_FILE}`);
  output.stdout.push(`created ${BREADCRUMB_DIR}/${TEMPLATES_DIR}/${REVIEW_FILE}`);

  // AGENTS.md always holds the contract as the single source of truth
  await upsertManagedBlock(
    path.join(cwd, AGENTS_FILE),
    getBreadcrumbInstructions(),
    BREADCRUMB_START,
    BREADCRUMB_END,
  );
  output.stdout.push(`updated ${AGENTS_FILE}`);

  // claude does not read AGENTS.md so bridge it with an import when claude is
  // selected or a CLAUDE.md already exists
  const claudePath = path.join(cwd, CLAUDE_FILE);
  if (opts.agents.includes("claude") || (await fileExists(claudePath))) {
    const changed = await ensureClaudeImport(claudePath);
    if (changed) {
      output.stdout.push(`updated ${CLAUDE_FILE}`);
    }
  }

  await writeSkills(cwd, opts.agents, output);

  if (opts.workflow) {
    await writeCiWorkflow(cwd, output);
  }
}

// writes the pr gate workflow unless one already exists
async function writeCiWorkflow(cwd: string, output: CliResult): Promise<void> {
  const relative = ".github/workflows/breadcrumb.yml";
  const target = path.join(cwd, ".github", "workflows", "breadcrumb.yml");

  if (await fileExists(target)) {
    output.stdout.push(`${relative} already exists, left unchanged`);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, getCiWorkflowTemplate(), "utf8");
  output.stdout.push(`created ${relative}`);
}

// writes the handoff skill into each selected agent's repo local skills dir
async function writeSkills(
  cwd: string,
  agents: AgentTarget[],
  output: CliResult,
): Promise<void> {
  const skill = getHandoffSkill();
  const seen = new Set<string>();

  for (const agent of agents) {
    for (const dir of SKILL_DIRS[agent]) {
      const skillRelative = `${dir}/${SKILL_NAME}/SKILL.md`;
      if (seen.has(skillRelative)) {
        continue;
      }
      seen.add(skillRelative);
      const target = path.join(cwd, dir, SKILL_NAME, "SKILL.md");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, skill, "utf8");
      output.stdout.push(`created ${skillRelative}`);
    }
  }
}

// ensures CLAUDE.md imports AGENTS.md since claude does not read it directly
// a bare import line with no managed markers added at most once
async function ensureClaudeImport(claudePath: string): Promise<boolean> {
  if (!(await fileExists(claudePath))) {
    await writeFile(claudePath, "@AGENTS.md\n", "utf8");
    return true;
  }

  const source = await readFile(claudePath, "utf8");
  if (/^@AGENTS\.md\s*$/m.test(source)) {
    return false;
  }

  const base = source.endsWith("\n") ? source : `${source}\n`;
  await writeFile(claudePath, `${base}\n@AGENTS.md\n`, "utf8");
  return true;
}

// creates a new review handoff from the template
export async function createTask(cwd: string, id: string, output: CliResult): Promise<void> {
  assertSafeTaskId(id);

  const taskDir = path.join(cwd, BREADCRUMB_DIR, TASKS_DIR, id);
  const reviewPath = path.join(taskDir, REVIEW_FILE);

  await mkdir(taskDir, { recursive: true });

  if (await fileExists(reviewPath)) {
    throw new Error(`${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE} already exists`);
  }

  await writeFile(reviewPath, getTaskTemplate(id), "utf8");
  output.stdout.push(`created ${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE}`);
}

// validates a task handoff and compares it with the local git diff
export async function checkTask(
  cwd: string,
  id: string,
  options: CheckOptions,
  output: CliResult,
): Promise<CheckJsonResult> {
  assertSafeTaskId(id);

  const reviewPath = path.join(cwd, BREADCRUMB_DIR, TASKS_DIR, id, REVIEW_FILE);

  if (!(await fileExists(reviewPath))) {
    const missing: BreadcrumbIssue = {
      code: "handoff_missing",
      message: `${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE} was not found`,
      path: `${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE}`,
      severity: "error",
    };
    return writeCheckResult({ ok: false, errors: [missing], warnings: [] }, options, output);
  }

  const source = await readFile(reviewPath, "utf8");
  const validation = parseBreadcrumbReviewYaml(source);
  const errors: BreadcrumbIssue[] = [];
  const warnings: BreadcrumbIssue[] = [];

  if (!validation.ok) {
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
    return writeCheckResult({ ok: false, errors, warnings }, options, output);
  }

  warnings.push(...validation.warnings);

  const base = options.base ?? (await readDefaultBranch(cwd));
  const changedFiles = await getChangedFiles(cwd, base);
  const coverage = compareReviewToChangedFiles(validation.data, changedFiles);

  for (const filePath of coverage.unexplained) {
    warnings.push({
      code: "changed_file_unexplained",
      message: `${filePath} changed but is not described in review.yml`,
      path: filePath,
      severity: "warning",
    });
  }

  for (const filePath of coverage.unsequenced) {
    warnings.push({
      code: "changed_file_unsequenced",
      message: `${filePath} is described but not included in review_sequence`,
      path: filePath,
      severity: "warning",
    });
  }

  for (const filePath of coverage.invalidReferences) {
    errors.push({
      code: "file_not_changed",
      message: `${filePath} is described but was not found in the changed files`,
      path: filePath,
      severity: "error",
    });
  }

  const ok = errors.length === 0 && (!options.strict || warnings.length === 0);

  if (options.strict && warnings.length > 0) {
    for (const warning of warnings) {
      errors.push({
        ...warning,
        code: `strict_${warning.code}`,
        severity: "error",
      });
    }
  }

  return writeCheckResult({ ok, errors, warnings, coverage }, options, output);
}

// parses command line arguments into a command and flags
function parseArgs(args: string[]): ParsedArgs {
  const command = args[0];
  const rest = args.slice(1);
  const flags = new Set<string>();

  for (const arg of args) {
    if (arg.startsWith("--")) {
      flags.add(arg.slice(2));
    } else if (arg.startsWith("-")) {
      flags.add(arg.slice(1));
    }
  }

  return {
    command: command?.startsWith("-") ? undefined : command,
    rest,
    flags,
  };
}

// dispatches the task subcommands
async function runTaskCommand(args: string[], cwd: string, output: CliResult): Promise<void> {
  const [subcommand, id] = args;

  if (subcommand !== "new" || !id) {
    output.exitCode = 1;
    output.stderr.push("usage: breadcrumb task new <id>");
    return;
  }

  await createTask(cwd, id, output);
}

// dispatches the check command
async function runCheckCommand(
  args: string[],
  flags: Set<string>,
  cwd: string,
  output: CliResult,
): Promise<void> {
  const ci = flags.has("ci");
  const taskIndex = args.indexOf("--task");
  let id = taskIndex >= 0 ? args[taskIndex + 1] : undefined;

  const options: CheckOptions = {
    json: flags.has("json"),
    strict: flags.has("strict") || ci,
    ci,
  };
  const base = getFlagValue(args, "--base");

  if (base) {
    options.base = base;
  } else if (ci) {
    // prefer the remote ref only when github provides the base so a local run
    // diffs against the local branch instead of a possibly stale origin
    const envRef = process.env.GITHUB_BASE_REF;
    options.base = envRef ? await resolveCiBase(cwd, envRef) : await readDefaultBranch(cwd);
  }

  if (ci && !(await gitRefExists(cwd, options.base ?? "main"))) {
    await failCiEarly(
      "base_not_found",
      `base ref ${options.base} was not found in this checkout`,
      "set fetch-depth 0 on the checkout step so the base branch is available",
      options,
      output,
    );
    return;
  }

  if (!id && ci) {
    const found = await discoverCiTasks(cwd, options.base ?? "main");
    const unsafe = found.find((taskId) => !isSafeTaskId(taskId));

    if (unsafe !== undefined) {
      await failCiEarly(
        "task_id_unsafe",
        `.breadcrumb/tasks/${unsafe} is not a safe task directory name`,
        "rename the task directory to letters numbers dots and dashes",
        options,
        output,
      );
      return;
    }

    if (found.length === 0) {
      await failCiEarly(
        "handoff_missing",
        "this pull request has no handoff",
        "run breadcrumb task new <id> then fill .breadcrumb/tasks/<id>/review.yml",
        options,
        output,
      );
      return;
    }

    if (found.length > 1) {
      await failCiEarly(
        "handoff_ambiguous",
        `expected exactly one handoff per pull request, found: ${found.join(", ")}`,
        "split the work or remove the stale handoff so one task remains",
        options,
        output,
      );
      return;
    }

    id = found[0];
  }

  if (!id) {
    output.exitCode = 1;
    output.stderr.push("usage: breadcrumb check --task <id> or breadcrumb check --ci");
    return;
  }

  const result = await checkTask(cwd, id, options, output);

  if (ci) {
    // json output stays parseable so annotations only join the text mode
    if (!options.json) {
      emitCiAnnotations(result, id, output);
    }
    await writeStepSummary(result, id);
  }

  if (output.stderr.length > 0) {
    output.exitCode = 1;
  }
}

// reports a ci failure that happens before a task check can run
async function failCiEarly(
  code: string,
  message: string,
  hint: string,
  options: CheckOptions,
  output: CliResult,
): Promise<void> {
  const issue: BreadcrumbIssue = {
    code,
    message,
    path: `${BREADCRUMB_DIR}/${TASKS_DIR}`,
    severity: "error",
  };
  const result: CheckJsonResult = { ok: false, errors: [issue], warnings: [] };

  output.exitCode = 1;

  if (options.json) {
    output.stdout.push(JSON.stringify(result, null, 2));
  } else {
    output.stderr.push("breadcrumb check failed");
    output.stderr.push(`error: ${message}`);
    output.stderr.push(hint);
    output.stdout.push(`::error title=breadcrumb::${escapeAnnotation(`${message} (${hint})`)}`);
  }

  await writeStepSummary(result, undefined);
}

// checks whether a git ref resolves in this checkout
async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

// prefers the remote tracking ref since ci checkouts have no local branches
async function resolveCiBase(cwd: string, ref: string): Promise<string> {
  if (ref.startsWith("origin/")) {
    return ref;
  }

  return (await gitRefExists(cwd, `origin/${ref}`)) ? `origin/${ref}` : ref;
}

// finds task ids whose handoff this branch adds or edits
async function discoverCiTasks(cwd: string, base: string): Promise<string[]> {
  const lines = await readGitLines(cwd, ["diff", "--name-status", `${base}...HEAD`]);
  const ids = new Set<string>();

  for (const line of lines) {
    const file = parseGitNameStatus(line);

    if (file.status.startsWith("D")) {
      continue;
    }

    const match = file.path.match(/^\.breadcrumb\/tasks\/([^/]+)\/review\.yml$/);

    if (match?.[1]) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

// maps an issue code to a one line fix hint for the agent reading the log
function fixHint(code: string): string | undefined {
  const bare = code.replace(/^strict_/, "");

  if (bare === "changed_file_unexplained") {
    return "add an entry under files with a why and a risk for this path";
  }
  if (bare === "changed_file_unsequenced") {
    return "add this file to a review_sequence section";
  }
  if (bare === "file_not_changed") {
    return "remove this entry or fix the path so it matches the diff";
  }
  if (bare === "handoff_missing") {
    return "run breadcrumb task new <id> and fill in the handoff";
  }

  return undefined;
}

// escapes message text for github workflow command lines
function escapeAnnotation(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

// github reads these stdout lines and renders them as pr annotations
function emitCiAnnotations(result: CheckJsonResult, id: string, output: CliResult): void {
  const file = `${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE}`;

  for (const error of result.errors) {
    const hint = fixHint(error.code);
    const message = hint ? `${error.message} (${hint})` : error.message;
    output.stdout.push(`::error file=${file},title=breadcrumb::${escapeAnnotation(message)}`);
  }
}

// appends a small markdown report to the github step summary when available
async function writeStepSummary(result: CheckJsonResult, id: string | undefined): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  const lines = [`## breadcrumb check ${result.ok ? "passed" : "failed"}`, ""];

  if (id) {
    lines.push(`task: \`${id}\``, "");
  }

  if (result.errors.length > 0) {
    lines.push("| issue | detail |", "| --- | --- |");

    for (const error of result.errors) {
      lines.push(`| ${error.code} | ${error.message.replaceAll("|", "\\|")} |`);
    }

    lines.push("");
  }

  await appendFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

// writes the human or json check output
function writeCheckResult(
  result: CheckJsonResult,
  options: CheckOptions,
  output: CliResult,
): CheckJsonResult {
  if (options.json) {
    output.stdout.push(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    output.stdout.push("breadcrumb check passed");

    for (const warning of result.warnings) {
      output.stdout.push(`warning: ${warning.message}`);
    }
  } else {
    output.stderr.push("breadcrumb check failed");

    for (const error of result.errors) {
      output.stderr.push(`error: ${error.message}`);
    }

    for (const warning of result.warnings) {
      output.stdout.push(`warning: ${warning.message}`);
    }
  }

  output.exitCode = result.ok ? 0 : 1;
  return result;
}

// reads the configured default branch from .breadcrumb/config.yml
async function readDefaultBranch(cwd: string): Promise<string> {
  const configPath = path.join(cwd, BREADCRUMB_DIR, CONFIG_FILE);

  if (!(await fileExists(configPath))) {
    return "main";
  }

  const config = await readFile(configPath, "utf8");
  const match = config.match(/^default_branch:\s*["']?([^"'\n]+)["']?/m);
  return match?.[1]?.trim() || "main";
}

// detects the best default branch for new breadcrumb config
async function detectDefaultBranch(cwd: string): Promise<string> {
  const gitDir = await resolveGitDir(cwd);
  const remoteDefault = await readGitRefBranch(
    path.join(gitDir, "refs", "remotes", "origin", "HEAD"),
    "refs/remotes/origin/",
  );

  if (remoteDefault) {
    return remoteDefault;
  }

  const currentBranch = await readGitRefBranch(
    path.join(gitDir, "HEAD"),
    "refs/heads/",
  );

  return currentBranch || "main";
}

// reads changed files from git name-status output
async function getChangedFiles(cwd: string, base: string): Promise<ChangedFile[]> {
  const branchDiff = await readGitLines(cwd, [
    "diff",
    "--name-status",
    `${base}...HEAD`,
  ]);
  const unstagedDiff = await readGitLines(cwd, ["diff", "--name-status"]);
  const stagedDiff = await readGitLines(cwd, ["diff", "--cached", "--name-status"]);
  const untracked = await readGitLines(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const files: GitNameStatus[] = [
    ...branchDiff.map(parseGitNameStatus),
    ...unstagedDiff.map(parseGitNameStatus),
    ...stagedDiff.map(parseGitNameStatus),
    ...untracked.map((filePath) => ({
      status: "A",
      path: filePath,
    })),
  ];

  const seen = new Set<string>();

  return files
    .filter((file) => {
      const key = `${file.previousPath ?? ""}->${file.path}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .filter((file) => !isIgnoredChangedPath(file.path))
    .filter((file) => !isBreadcrumbReviewPath(file.path))
    .map((file) => {
      const changedFile: ChangedFile = {
        path: file.path,
        status: mapGitStatus(file.status),
      };

      if (file.previousPath) {
        changedFile.previousPath = file.previousPath;
      }

      return changedFile;
    });
}

// checks whether a changed path should be ignored by the handoff check
function isIgnoredChangedPath(filePath: string): boolean {
  return [
    "node_modules/",
    ".git/",
    ".pnpm-store/",
    ".next/",
    "dist/",
    "build/",
    "coverage/",
  ].some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix));
}

// reads line based git command output
async function readGitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args, { cwd });

  return stdout.split(/\r?\n/).filter(Boolean);
}

// resolves the local git directory for regular repos and worktrees
async function resolveGitDir(cwd: string): Promise<string> {
  const dotGit = path.join(cwd, ".git");
  const directGitHead = path.join(dotGit, "HEAD");

  if (await fileExists(directGitHead)) {
    return dotGit;
  }

  try {
    const source = await readFile(dotGit, "utf8");
    const match = source.match(/^gitdir:\s*(.+)$/m);
    const gitDir = match?.[1]?.trim();

    if (gitDir) {
      return path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    }
  } catch {
    return dotGit;
  }

  return dotGit;
}

// reads a symbolic git ref and returns the branch name for the prefix
async function readGitRefBranch(filePath: string, prefix: string): Promise<string | null> {
  try {
    const source = await readFile(filePath, "utf8");
    const match = source.trim().match(/^ref:\s*(.+)$/);
    const ref = match?.[1]?.trim();

    return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

// parses one git name-status line
function parseGitNameStatus(line: string): GitNameStatus {
  const parts = line.split("\t");
  const status = parts[0] ?? "";

  if (status.startsWith("R") || status.startsWith("C")) {
    const result: GitNameStatus = {
      status,
      path: parts[2] ?? "",
    };

    if (parts[1]) {
      result.previousPath = parts[1];
    }

    return result;
  }

  return {
    status,
    path: parts[1] ?? "",
  };
}

// maps git status codes to protocol status values
function mapGitStatus(status: string): ChangedFileStatus {
  if (status.startsWith("A")) {
    return "added";
  }

  if (status.startsWith("D")) {
    return "removed";
  }

  if (status.startsWith("R")) {
    return "renamed";
  }

  if (status.startsWith("C")) {
    return "copied";
  }

  if (status.startsWith("M")) {
    return "modified";
  }

  return "changed";
}

// inserts or replaces a managed markdown block
async function upsertManagedBlock(
  filePath: string,
  block: string,
  startMarker: string,
  endMarker: string,
): Promise<void> {
  const managedBlock = `${startMarker}\n${block.trim()}\n${endMarker}`;

  if (!(await fileExists(filePath))) {
    await writeFile(filePath, `${getTitleForFile(filePath)}\n\n${managedBlock}\n`, "utf8");
    return;
  }

  const source = await readFile(filePath, "utf8");
  const existing = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    "m",
  );
  const next = existing.test(source)
    ? source.replace(existing, managedBlock)
    : `${source.trimEnd()}\n\n${managedBlock}\n`;

  await writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}

// writes a file only when it does not already exist
async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  if (await fileExists(filePath)) {
    return;
  }

  await writeFile(filePath, content, "utf8");
}

// checks whether a file exists
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// checks that a task id is one safe path segment
function isSafeTaskId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

// ensures task ids stay as a single safe path segment
function assertSafeTaskId(id: string): void {
  if (!isSafeTaskId(id)) {
    throw new Error("task id must be a safe path segment");
  }
}

// extracts a flag value from positional args
function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// escapes a string for use in a regular expression
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// returns a title for newly created markdown files
function getTitleForFile(filePath: string): string {
  return path.basename(filePath).toUpperCase() === AGENTS_FILE
    ? "# AGENTS.md"
    : "# CLAUDE.md";
}

// returns the default breadcrumb config
function getDefaultConfig(defaultBranch: string): string {
  return `version: 1
default_branch: ${defaultBranch}
`;
}

// returns the reusable review template written by init
function getReviewTemplate(): string {
  return `version: 1
id: task-id
title: Short title for the change
problem: The context or pain this change addresses.
user_goal: What the user asked for in plain language.
solution: |
  How it was solved, in markdown. Use headings, lists, and fenced code where they
  help. Add a mermaid diagram only when it clarifies the architecture.
review_sequence:
  - title: First area to review
    why: Why this area should be read first.
    files:
      - src/example.ts
files:
  - path: src/example.ts
    why: Why this file changed.
    risk: low
    change: feature
    unknowns: []
    tests: []
`;
}

// returns a task specific review template
function getTaskTemplate(id: string): string {
  return getReviewTemplate().replace("id: task-id", `id: ${id}`);
}

// returns the breadcrumb contract block written into AGENTS.md
function getBreadcrumbInstructions(): string {
  return `## Breadcrumb Review Handoff

Breadcrumb helps a human review agent-written changes fast: instead of a raw diff, they read a short handoff that explains the change and the order to review it.

Write one handoff per task or feature, the change that becomes a PR. When the work is done, before handing it back:

1. write \`.breadcrumb/tasks/<task-id>/review.yml\`
2. run \`pnpm breadcrumb check --task <task-id>\` and fix what it reports

The handoff explains how to read the change, not what changed line by line. Keep it short and honest.

It covers:
- \`problem\`: the context or pain behind the change
- \`user_goal\`: what the user actually asked for
- \`solution\`: how it was solved, in markdown, with a mermaid diagram when it helps
- \`review_sequence\`: the order to read files, simplest entry point first
- per file: \`why\` it changed, \`risk\` (low / medium / high), any \`unknowns\` to confirm

Do not add model or agent attribution. Do not invent certainty; put doubts in \`unknowns\`.`;
}

// returns the breadcrumb-handoff skill the same file written for every agent
function getHandoffSkill(): string {
  return `---
name: breadcrumb-handoff
description: Use when finishing a coding task in a repo with a .breadcrumb folder, before opening the PR, to write or update the review.yml handoff that guides the human reviewer. Covers tone, what to include, review ordering, risk and unknowns, and running breadcrumb check until it passes.
---

# Writing a Breadcrumb handoff

A handoff is a short file that tells a human how to review your change. It is not a summary of the diff. It answers a handful of things: the problem, the goal, how you solved it, what to read first, and what to double check.

Write one per task or feature, the change that becomes a PR.

## The loop

1. \`breadcrumb task new <task-id>\` creates \`.breadcrumb/tasks/<task-id>/review.yml\` from the template.
2. Fill it in (see below).
3. \`breadcrumb check --task <task-id>\` validates it and compares it against your real git changes.
4. Fix what it reports. Repeat until it prints \`breadcrumb check passed\`.

Do not hand the task back until check passes.

## Fields

**\`problem\`** the context or pain behind the work, separate from the goal. One or two plain sentences. Optional but recommended.

**\`user_goal\`** what the person actually asked for, in their words, not the implementation.
Good: "Let sales reps add optional add-ons to a quote."
Weak: "Added AddOn type and updated QuoteTotal."

**\`solution\`** how you solved it, in markdown. Headings, lists, and fenced code are fine. Add a \`mermaid\` diagram only when it makes the architecture clearer, and keep it to the part that changed. If you are unsure of a relationship, leave it out rather than guess. Optional but recommended.

**\`review_sequence\`** the order to read the change. Put the file that makes the rest make sense first, then build outward. Group into titled sections, each with a one-line \`why\`. A reviewer should be able to read top to bottom and never feel lost.

**per file** in \`files\`:
- \`why\` one line on why this file changed and what to look at.
- \`risk\` low / medium / high. Be honest. Money, auth, migrations, and data deletion skew high; a typo fix is low.
- \`unknowns\` things you could not verify and want the reviewer to confirm. A high risk file almost always has at least one. If you are sure of everything, leave it empty, do not invent doubt.

## Tone

Short, plain, honest. No model or agent attribution. No marketing. If something is unclear, say so under \`unknowns\` rather than papering over it. The reviewer's time is the thing you are saving.

## Example

\`\`\`yaml
version: 1
id: quote-add-ons
title: Add optional add-ons to the quote flow
problem: Reps could not attach optional services to a quote, so upsells happened off platform.
user_goal: Let sales reps add optional services to a quote.
solution: |
  Add-ons are priced in one module and folded into the quote total, then offered
  in the builder UI.

  \`\`\`mermaid
  flowchart LR
    Builder[Quote builder] --> Picker[Add-on picker]
    Picker --> Pricing[Add-on pricing]
    Pricing --> Total[Quote total]
  \`\`\`
review_sequence:
  - title: Pricing rule
    why: Read this first, the rest of the change depends on how add-ons are priced.
    files:
      - src/pricing/add-ons.ts
  - title: Quote UI
    why: Where reps pick add-ons.
    files:
      - src/quote/builder.tsx
files:
  - path: src/pricing/add-ons.ts
    why: Defines add-on pricing and how it folds into the quote total.
    risk: high
    unknowns:
      - Confirm tax applies to add-ons the same way it does to base line items.
  - path: src/quote/builder.tsx
    why: Adds the add-on picker to the quote builder.
    risk: low
\`\`\`

Why it works: the problem frames the change, the solution gives a one screen map, the reading order starts where the logic lives, the risky file names a real thing to confirm, and the easy file is marked easy so the reviewer moves fast.
`;
}

// returns the consumer pr gate workflow
// labeled and unlabeled rerun the gate when the skip label changes
function getCiWorkflowTemplate(): string {
  return `name: breadcrumb

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  check:
    if: \${{ !contains(github.event.pull_request.labels.*.name, 'breadcrumb-skip') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack pnpm dlx @adikuma/breadcrumb@latest check --ci
        env:
          COREPACK_ENABLE_STRICT: "0"
`;
}

// returns the help text
function getHelpText(): string {
  return `breadcrumb

commands:
  breadcrumb init [--agent claude,codex|none] [--workflow|--no-workflow]
  breadcrumb task new <id>
  breadcrumb check --task <id> [--json] [--strict] [--base <ref>]
  breadcrumb check --ci [--base <ref>]
`;
}

// runs the cli when this file is executed directly
async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));

  for (const line of result.stdout) {
    process.stdout.write(`${line}\n`);
  }

  for (const line of result.stderr) {
    process.stderr.write(`${line}\n`);
  }

  process.exitCode = result.exitCode;
}

// detects direct execution from node or package manager shims
export function isCliEntryPoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) {
    return false;
  }

  const modulePath = normalizeEntryPath(fileURLToPath(moduleUrl));
  const resolvedArgvPath = normalizeEntryPath(argvPath);

  return resolvedArgvPath === modulePath;
}

// normalizes entrypoint paths for stable comparisons
function normalizeEntryPath(entryPath: string): string {
  const resolved = path.resolve(entryPath);
  let normalized = resolved;

  try {
    normalized = realpathSync.native(resolved);
  } catch {
    normalized = resolved;
  }

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

if (isCliEntryPoint(process.argv[1], import.meta.url)) {
  await main();
}
