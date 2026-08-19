#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { isSeq, parseDocument } from "yaml";

const execFileAsync = promisify(execFile);

const BREADCRUMB_DIR = ".breadcrumb";
const TASKS_DIR = "tasks";
const TEMPLATES_DIR = "templates";
const REVIEW_FILE = "review.yml";
const CONFIG_FILE = "config.yml";
const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const UNEXPLAINED_CODE = "changed_file_unexplained";
// the skill allows both of these on purpose so the gate must not undo it
const NON_BLOCKING = new Set([UNEXPLAINED_CODE, "high_risk_without_unknowns"]);
const BREADCRUMB_END = "<!-- breadcrumb:end -->";

// matches the legacy marker and the hashed one so old repos still upgrade
const MANAGED_BLOCK =
  /<!-- breadcrumb:start(?: ([0-9a-f]{8}))? -->\r?\n?([\s\S]*?)\r?\n?<!-- breadcrumb:end -->/;
const DEFAULT_API_URL = "https://app.breadcrumb.run";

// only what a browser plays without a plugin
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

type AgentTarget = "claude" | "codex" | "opencode";

const SKILL_NAME = "breadcrumb-handoff";

// repo local skill dirs per agent
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

type BlockOutcome = "created" | "appended" | "replaced" | "current" | "edited" | "damaged";

type EvidenceReservation = {
  id: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
};

// a failure the user can act on rather than a crash
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

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

    if (parsed.command === "update") {
      await updateProject(cwd, { force: parsed.flags.has("force") }, output);
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

    if (parsed.command === "evidence") {
      await runEvidenceCommand(parsed.rest, cwd, output);
      return output;
    }

    if (parsed.command === "link") {
      await runLinkCommand(parsed.rest, cwd, output);
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
  const blockOutcome = await upsertManagedBlock(
    path.join(cwd, AGENTS_FILE),
    getBreadcrumbInstructions(),
    { force: true },
  );

  if (blockOutcome === "damaged") {
    output.exitCode = 1;
    output.stderr.push(
      `the breadcrumb markers in ${AGENTS_FILE} look damaged so nothing was changed. repair or remove the markers by hand then re-run`,
    );
  } else {
    output.stdout.push(`updated ${AGENTS_FILE}`);
  }

  // claude does not read AGENTS.md so bridge it with an import when claude is
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
  for (const skillRelative of skillPathsFor(agents)) {
    await writeSkillFile(cwd, skillRelative, output);
  }
}

// the skill paths a set of agents maps to with duplicates removed
function skillPathsFor(agents: AgentTarget[]): string[] {
  const seen = new Set<string>();

  for (const agent of agents) {
    for (const dir of SKILL_DIRS[agent]) {
      seen.add(`${dir}/${SKILL_NAME}/SKILL.md`);
    }
  }

  return [...seen];
}

// the skill paths already installed in this repo whatever agent put them there
async function installedSkillPaths(cwd: string): Promise<string[]> {
  const every = skillPathsFor(Object.keys(SKILL_DIRS) as AgentTarget[]);
  const found: string[] = [];

  for (const skillRelative of every) {
    if (await fileExists(path.join(cwd, skillRelative))) {
      found.push(skillRelative);
    }
  }

  return found;
}

// writes one skill file and reports what actually changed
async function writeSkillFile(
  cwd: string,
  skillRelative: string,
  output: CliResult,
): Promise<void> {
  const skill = getHandoffSkill();
  const target = path.join(cwd, skillRelative);
  const existed = await isFile(target);

  // compared normalised so a crlf checkout does not look like a change
  if (existed && normalizeBlock(await readFile(target, "utf8")) === normalizeBlock(skill)) {
    output.stdout.push(`${skillRelative} already current`);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, skill, "utf8");
  output.stdout.push(`${existed ? "updated" : "created"} ${skillRelative}`);
}

// ensures CLAUDE.md imports AGENTS.md since claude does not read it directly
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

  await writeFile(reviewPath, await readTaskTemplate(cwd, id), "utf8");
  output.stdout.push(`created ${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE}`);
}

// prefers the repo's own template so editing it actually changes new tasks
async function readTaskTemplate(cwd: string, id: string): Promise<string> {
  const templatePath = path.join(cwd, BREADCRUMB_DIR, TEMPLATES_DIR, REVIEW_FILE);

  if (await isFile(templatePath)) {
    const template = await readFile(templatePath, "utf8");
    // anchored on the field so renaming the placeholder value cannot silently skip it
    if (/^id:\s*.*$/m.test(template)) {
      return template.replace(/^id:\s*.*$/m, () => `id: ${id}`);
    }
  }

  return getTaskTemplate(id);
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

  const base = options.base ?? (await resolveBase(cwd, await readDefaultBranch(cwd)));
  const changedFiles = await getChangedFiles(cwd, base);
  const coverage = compareReviewToChangedFiles(validation.data, changedFiles);

  // one line rather than one per file because most files are meant to be left out
  if (coverage.unexplained.length > 0) {
    const count = coverage.unexplained.length;
    warnings.push({
      code: UNEXPLAINED_CODE,
      message: `${count} changed ${count === 1 ? "file is" : "files are"} not described in review.yml, which is fine unless a reviewer needs to open ${count === 1 ? "it" : "one"}`,
      path: `${BREADCRUMB_DIR}/${TASKS_DIR}/${id}/${REVIEW_FILE}`,
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

  const blocking = warnings.filter((warning) => !NON_BLOCKING.has(warning.code));
  const ok = errors.length === 0 && (!options.strict || blocking.length === 0);

  if (options.strict && blocking.length > 0) {
    for (const warning of blocking) {
      errors.push({
        ...warning,
        code: `strict_${warning.code}`,
        severity: "error",
      });
    }
  }

  return writeCheckResult({ ok, errors, warnings, coverage }, options, output);
}

// drops an inline value so --task=id registers as the task flag
function flagName(raw: string): string {
  const equals = raw.indexOf("=");
  return equals >= 0 ? raw.slice(0, equals) : raw;
}

// parses command line arguments into a command and flags
function parseArgs(args: string[]): ParsedArgs {
  const command = args[0];
  const rest = args.slice(1);
  const flags = new Set<string>();

  // agents write --task=id as often as --task id so both forms parse
  for (const arg of args) {
    if (arg.startsWith("--")) {
      flags.add(flagName(arg.slice(2)));
    } else if (arg.startsWith("-")) {
      flags.add(flagName(arg.slice(1)));
    }
  }

  return {
    command: command?.startsWith("-") ? undefined : command,
    rest,
    flags,
  };
}

// refreshes the files breadcrumb owns in a repo that already ran init
export async function updateProject(
  cwd: string,
  opts: { force?: boolean },
  output: CliResult,
): Promise<void> {
  if (!(await isDirectory(path.join(cwd, BREADCRUMB_DIR)))) {
    output.exitCode = 1;
    output.stderr.push(
      `no ${BREADCRUMB_DIR} here. run from the repo root or run breadcrumb init first`,
    );
    return;
  }

  const outcome = await upsertManagedBlock(
    path.join(cwd, AGENTS_FILE),
    getBreadcrumbInstructions(),
    { force: opts.force ?? false },
  );

  if (outcome === "damaged") {
    output.exitCode = 1;
    output.stderr.push(
      `the breadcrumb markers in ${AGENTS_FILE} look damaged so nothing was changed. repair or remove the markers by hand then re-run`,
    );
  } else if (outcome === "edited") {
    output.exitCode = 1;
    output.stderr.push(
      `${AGENTS_FILE} has edits inside the breadcrumb block so it was left alone. commit or copy them then re-run with --force to replace them`,
    );
  } else if (outcome === "current") {
    output.stdout.push(`${AGENTS_FILE} already current`);
  } else {
    output.stdout.push(`${outcome} the breadcrumb block in ${AGENTS_FILE}`);
  }

  const claudePath = path.join(cwd, CLAUDE_FILE);
  if (await fileExists(claudePath)) {
    const changed = await ensureClaudeImport(claudePath);
    output.stdout.push(
      changed ? `updated ${CLAUDE_FILE}` : `${CLAUDE_FILE} already imports ${AGENTS_FILE}`,
    );
  } else {
    output.stdout.push(`no ${CLAUDE_FILE} here so it was skipped`);
  }

  await reportTemplateDrift(cwd, output);

  // only the agents already set up get touched so update never adopts a new one
  const installed = await installedSkillPaths(cwd);

  if (installed.length === 0) {
    output.stdout.push("no handoff skill installed. run breadcrumb init --agent to add one");
    return;
  }

  for (const skillRelative of installed) {
    await writeSkillFile(cwd, skillRelative, output);
  }
}

// the template is yours so update never rewrites it but silence would hide drift
async function reportTemplateDrift(cwd: string, output: CliResult): Promise<void> {
  const templatePath = path.join(cwd, BREADCRUMB_DIR, TEMPLATES_DIR, REVIEW_FILE);

  if (!(await isFile(templatePath))) {
    return;
  }

  const yours = normalizeBlock(await readFile(templatePath, "utf8"));

  if (yours !== normalizeBlock(getReviewTemplate())) {
    output.stdout.push(
      `${BREADCRUMB_DIR}/${TEMPLATES_DIR}/${REVIEW_FILE} differs from the shipped template and is yours to keep`,
    );
  }
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
  let id = getFlagValue(args, "--task");

  const options: CheckOptions = {
    json: flags.has("json"),
    strict: flags.has("strict") || ci,
    ci,
  };
  const base = getFlagValue(args, "--base");

  if (base) {
    options.base = base;
  } else {
    // remote tracking ref
    const envRef = ci ? process.env.GITHUB_BASE_REF : undefined;
    options.base = await resolveBase(cwd, envRef ?? (await readDefaultBranch(cwd)));
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

// remote tracking ref
async function resolveBase(cwd: string, ref: string): Promise<string> {
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
// NOTE: never falls back to the current branch
async function detectDefaultBranch(cwd: string): Promise<string> {
  const head = await readSymbolicRef(cwd, "refs/remotes/origin/HEAD");

  if (head) {
    return head;
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await gitRefExists(cwd, candidate)) {
      return stripOrigin(candidate);
    }
  }

  return "main";
}

// asks git rather than reading the ref file so packed refs resolve too
async function readSymbolicRef(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", ref], { cwd });
    const value = stdout.trim();
    return value ? stripOrigin(value) : null;
  } catch {
    return null;
  }
}

function stripOrigin(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
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

// collapses windows line endings so a git checkout cannot change the hash
function normalizeBlock(block: string): string {
  return block.replace(/\r\n/g, "\n").trim();
}

// a short fingerprint of the block so an edit inside it can be spotted later
function blockHash(block: string): string {
  return createHash("sha256").update(normalizeBlock(block), "utf8").digest("hex").slice(0, 8);
}

// wraps the block in markers carrying its fingerprint
function renderManagedBlock(block: string): string {
  const normalized = normalizeBlock(block);
  return `<!-- breadcrumb:start ${blockHash(normalized)} -->\n${normalized}\n${BREADCRUMB_END}`;
}

// inserts or replaces a managed markdown block
async function upsertManagedBlock(
  filePath: string,
  block: string,
  opts: { force?: boolean } = {},
): Promise<BlockOutcome> {
  const managedBlock = renderManagedBlock(block);

  if (!(await isFile(filePath))) {
    if (await fileExists(filePath)) {
      return "damaged";
    }
    await writeFile(filePath, `${getTitleForFile(filePath)}\n\n${managedBlock}\n`, "utf8");
    return "created";
  }

  const source = await readFile(filePath, "utf8");
  const match = source.match(MANAGED_BLOCK);

  if (!match) {
    // a start marker the pattern cannot read means appending would duplicate the block
    if (source.includes("<!-- breadcrumb:start")) {
      return "damaged";
    }

    const body = source.trim() === "" ? getTitleForFile(filePath) : source.trimEnd();
    await writeFile(filePath, `${body}\n\n${managedBlock}\n`, "utf8");
    return "appended";
  }

  const [, recordedHash, currentBlock = ""] = match;

  if (recordedHash && recordedHash !== blockHash(currentBlock) && !opts.force) {
    return "edited";
  }

  // a legacy block with no hash falls through so the rewrite stamps one on
  if (recordedHash && normalizeBlock(currentBlock) === normalizeBlock(block)) {
    return "current";
  }

  // replaced through the pattern so a dollar sign in the block cannot splice the file
  const next = source.replace(MANAGED_BLOCK, () => managedBlock);
  await writeFile(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return "replaced";
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

// fileExists is true for a directory too so reads check the kind first
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
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

function apiBase(): string {
  return (process.env.BREADCRUMB_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

// dispatches the evidence subcommands
async function runEvidenceCommand(
  args: string[],
  cwd: string,
  output: CliResult,
): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand !== "add") {
    output.exitCode = 1;
    output.stderr.push("usage: breadcrumb evidence add <file> --task <id>");
    return;
  }

  // matched by position because a caption can repeat the filename
  const file = rest.find((arg, index) => {
    if (arg.startsWith("-")) {
      return false;
    }
    const previous = index > 0 ? rest[index - 1] : undefined;
    return !(previous?.startsWith("--") && !previous.includes("="));
  });

  try {
    await addEvidence(
      {
        file,
        taskId: getFlagValue(rest, "--task"),
        caption: getFlagValue(rest, "--caption"),
        repo: getFlagValue(rest, "--repo"),
      },
      cwd,
      output,
    );
  } catch (error) {
    output.exitCode = 1;
    output.stderr.push(
      error instanceof CliError ? error.message : `evidence upload failed: ${String(error)}`,
    );
  }
}

// prints the review room url for a pull request
async function runLinkCommand(args: string[], cwd: string, output: CliResult): Promise<void> {
  try {
    const repoFullName = getFlagValue(args, "--repo") ?? (await detectRepoFullName(cwd));
    const pr = getFlagValue(args, "--pr");

    const pull =
      pr === undefined ? await readPullFromGh(cwd) : { number: parsePrNumber(pr), draft: false };

    output.stdout.push(`${apiBase()}/review/${repoFullName}/${pull.number}`);

    // the room opens a draft but the inbox hides it until it is ready
    if (pull.draft) {
      output.stderr.push(
        "note: this pull request is a draft. it opens in breadcrumb but does not appear in the inbox until it is marked ready for review",
      );
    }
  } catch (error) {
    output.exitCode = 1;
    output.stderr.push(
      error instanceof CliError ? error.message : `could not build the link: ${String(error)}`,
    );
  }
}

// a positive integer and nothing else
function parsePrNumber(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail(`${raw} is not a pull request number. pass --pr <number>`);
  }

  return Number(raw);
}

// reads the pull request gh reports for the current branch
async function readPullFromGh(cwd: string): Promise<{ number: number; draft: boolean }> {
  let stdout: string;

  try {
    ({ stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number,isDraft"], { cwd }));
  } catch {
    fail(
      "no --pr given and gh could not resolve a pull request for this branch. pass --pr <number>",
    );
  }

  let parsed: { number?: unknown; isDraft?: unknown };

  try {
    parsed = JSON.parse(stdout) as { number?: unknown; isDraft?: unknown };
  } catch {
    fail("gh did not answer with json. pass --pr <number>");
  }

  if (typeof parsed.number !== "number") {
    fail("gh did not report a pull request number. pass --pr <number>");
  }

  return { number: parsed.number, draft: parsed.isDraft === true };
}

// uploads one file and records the handle in the task handoff
async function addEvidence(
  input: {
    file?: string | undefined;
    taskId?: string | undefined;
    caption?: string | undefined;
    repo?: string | undefined;
  },
  cwd: string,
  output: CliResult,
): Promise<void> {
  if (!input.file) {
    fail("usage: breadcrumb evidence add <file> --task <id>");
  }
  if (!input.taskId) {
    fail("missing --task. name the task this evidence belongs to");
  }
  if (!isSafeTaskId(input.taskId)) {
    fail(`${input.taskId} is not a valid task id. use letters numbers dots dashes or underscores`);
  }

  // local checks run first so a typo does not report as a missing key
  const reviewPath = path.join(cwd, BREADCRUMB_DIR, TASKS_DIR, input.taskId, REVIEW_FILE);
  if (!(await fileExists(reviewPath))) {
    fail(
      `no handoff at ${BREADCRUMB_DIR}/${TASKS_DIR}/${input.taskId}/${REVIEW_FILE}. run breadcrumb task new ${input.taskId} first`,
    );
  }

  const filePath = path.resolve(cwd, input.file);
  if (!(await fileExists(filePath))) {
    fail(`no file at ${input.file}`);
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    fail(
      `${extension || "that file"} is not supported. use png jpeg webp mp4 or webm`,
    );
  }

  const bytes = await readFile(filePath);
  if (bytes.byteLength === 0) {
    fail(`${input.file} is empty`);
  }

  // checked before the upload so a broken handoff never orphans stored bytes
  await assertHandoffWritable(reviewPath);

  const repoFullName = input.repo ?? (await detectRepoFullName(cwd));

  const key = process.env.BREADCRUMB_API_KEY;
  if (!key) {
    fail("no api key. create one in breadcrumb settings then export BREADCRUMB_API_KEY");
  }

  const reservation = await reserveEvidence(key, {
    repoFullName,
    taskId: input.taskId,
    contentType,
    sizeBytes: bytes.byteLength,
    caption: input.caption,
  });

  await uploadBytes(reservation, bytes);
  await confirmUpload(key, reservation.id);

  output.stdout.push(`uploaded ${reservation.id}`);

  // the bytes are stored by now so this is only a bookkeeping failure
  try {
    await recordEvidence(reviewPath, reservation.id, input.caption);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(
      `uploaded ${reservation.id} but could not record it: ${reason}. add it under evidence: by hand`,
    );
  }

  output.stdout.push(
    `recorded in ${BREADCRUMB_DIR}/${TASKS_DIR}/${input.taskId}/${REVIEW_FILE}`,
  );
}

// reads owner/repo from the git remote so the caller does not have to
async function detectRepoFullName(cwd: string): Promise<string> {
  const remotes = await readGitLines(cwd, ["remote"]);

  if (remotes.length === 0) {
    fail("no git remote to read the repo name from. pass --repo owner/name");
  }

  const chosen = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]!
      : fail("several git remotes and no origin. pass --repo owner/name");

  const [url] = await readGitLines(cwd, ["remote", "get-url", chosen]);
  if (!url) {
    fail(`could not read the url for the ${chosen} remote. pass --repo owner/name`);
  }

  const parsed = parseGithubRemote(url);
  if (!parsed) {
    fail(`${url} is not a github remote. pass --repo owner/name`);
  }

  return parsed;
}

// accepts the ssh scp and https remote spellings github hands out
export function parseGithubRemote(url: string): string | null {
  // a pasted browser url often carries a trailing slash
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) {
      return `${match[1]}/${match[2]}`;
    }
  }

  return null;
}

// the api answers json even on failure so the message is worth surfacing
async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

// a dead network otherwise surfaces as a bare TypeError with no next step
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    // storage lives on another host so it must not be blamed on the api url
    const target = URL.canParse(url) ? new URL(url).origin : url;
    const hint = url.startsWith(apiBase()) ? " or BREADCRUMB_API_URL" : "";
    fail(`could not reach ${target}. check your connection${hint}`);
  }
}

async function reserveEvidence(
  key: string,
  body: {
    repoFullName: string;
    taskId: string;
    contentType: string;
    sizeBytes: number;
    caption?: string | undefined;
  },
): Promise<EvidenceReservation> {
  const response = await request(`${apiBase()}/api/v1/evidence`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // reserve is the first authenticated call so a bad key is caught here
  if (response.status === 401) {
    fail("that api key was rejected. check it has not been revoked in settings");
  }
  if (response.status === 403) {
    fail(
      `breadcrumb cannot see ${body.repoFullName}. add it to your repositories, or pass --repo if this remote is a fork`,
    );
  }
  if (!response.ok) {
    // the server carries the real size limits so its message is the honest one
    fail(await readApiError(response, `could not reserve storage (${response.status})`));
  }

  const json = (await response.json()) as {
    id?: string;
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
  };

  if (!json.id || !json.uploadUrl || !json.uploadHeaders) {
    fail("breadcrumb returned an unexpected response when reserving storage");
  }

  return { id: json.id, uploadUrl: json.uploadUrl, uploadHeaders: json.uploadHeaders };
}

// the presigned url carries its own permission so the api key must not ride along
async function uploadBytes(
  reservation: EvidenceReservation,
  bytes: Buffer,
): Promise<void> {
  // a view over the same memory so a large upload is not copied twice
  const body = new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const response = await request(reservation.uploadUrl, {
    method: "PUT",
    headers: reservation.uploadHeaders,
    body,
  });

  if (response.status === 403) {
    fail("storage refused the upload, it may have expired. re-run the command");
  }
  if (!response.ok) {
    fail(`the upload did not complete (${response.status}). re-run the command`);
  }
}

// confirm answers 409 for both no bytes and already confirmed
async function confirmUpload(key: string, id: string): Promise<void> {
  const response = await request(evidenceUrl(id), {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
  });

  if (response.ok) {
    return;
  }

  if (response.status === 409) {
    if (await isAlreadyUploaded(key, id)) {
      return;
    }
    fail(`the upload did not arrive (${id}). re-run the command`);
  }

  fail(
    `${await readApiError(response, `could not confirm the upload (${response.status})`)} (${id}). re-run the command`,
  );
}

function evidenceUrl(id: string): string {
  return `${apiBase()}/api/v1/evidence/${encodeURIComponent(id)}`;
}

async function isAlreadyUploaded(key: string, id: string): Promise<boolean> {
  try {
    const response = await fetch(evidenceUrl(id), {
      headers: { authorization: `Bearer ${key}` },
    });

    if (!response.ok) {
      return false;
    }

    const json = (await response.json()) as { uploaded?: unknown };
    return json.uploaded === true;
  } catch {
    return false;
  }
}

// proves the handoff can take a handle before anything is uploaded
export async function assertHandoffWritable(reviewPath: string): Promise<void> {
  const doc = parseDocument(await readFile(reviewPath, "utf8"));

  if (doc.errors.length > 0) {
    fail(`could not parse ${reviewPath}. fix the yaml then re-run`);
  }

  const existing = doc.get("evidence");

  if (existing !== null && existing !== undefined && !isSeq(existing)) {
    fail("evidence in review.yml is not a list. fix it then re-run");
  }
}

// appends the handle without reformatting the handoff or dropping its comments
export async function recordEvidence(
  reviewPath: string,
  id: string,
  caption: string | undefined,
): Promise<void> {
  const source = await readFile(reviewPath, "utf8");
  const doc = parseDocument(source);

  // parseDocument collects errors so writing back would destroy them
  if (doc.errors.length > 0) {
    fail(`could not parse ${reviewPath}`);
  }

  const entry: Record<string, string> = { id };

  if (caption) {
    entry.caption = caption;
  }

  const existing = doc.get("evidence");

  if (isSeq(existing)) {
    existing.add(doc.createNode(entry));
  } else if (existing === null || existing === undefined) {
    doc.set("evidence", doc.createNode([entry]));
  } else {
    fail("evidence in review.yml is not a list");
  }

  await writeFile(reviewPath, doc.toString(), "utf8");
}

// extracts a flag value written either as --flag value or --flag=value
function getFlagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));

  if (inline !== undefined) {
    return inline.slice(flag.length + 1);
  }

  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// returns a title for newly created markdown files
function getTitleForFile(filePath: string): string {
  // compared case insensitively both ways so AGENTS.MD never titles itself CLAUDE
  return path.basename(filePath).toLowerCase() === AGENTS_FILE.toLowerCase()
    ? `# ${AGENTS_FILE}`
    : `# ${CLAUDE_FILE}`;
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
# list only the files a reviewer needs to open
review_sequence:
  - title: First area to review
    why: Why this area should be read first.
    files:
      - src/example.ts
files:
  - path: src/example.ts
    why: What to look at in this file.
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

Before you open a pull request, or when you are asked to open one, do this first. No pull request without a handoff.

1. write \`.breadcrumb/tasks/<task-id>/review.yml\`
2. run \`pnpm breadcrumb check --task <task-id>\` and fix the errors it reports
3. open the pull request, then run \`pnpm breadcrumb link\` and hand back the url it prints

Your final message names the Breadcrumb link. That is how the task is handed back. The reviewer opens Breadcrumb, not the GitHub pull request.

\`link\` reads the repository from git and the pull request number from \`gh\`, so it takes no arguments. Pass \`--pr <number>\` when \`gh\` cannot see the branch. It says so when the pull request is a draft, which opens in Breadcrumb but does not appear in the inbox until it is marked ready for review.

Breadcrumb helps a human review agent-written changes fast: instead of a raw diff, they read a short handoff that explains the change and the order to review it. Write one handoff per pull request. It explains how to read the change, not what changed line by line. Keep it short and honest.

Describe only the files a reviewer needs to open. A thirty file change with two risky files is a two file handoff, and leaving the rest out is correct. Never write an entry that only says a file is small, mechanical, or a test for the above.

It covers:
- \`problem\`: the context or pain behind the change
- \`user_goal\`: what the user actually asked for
- \`solution\`: how it was solved, in markdown, with a mermaid diagram when it helps
- \`review_sequence\`: the order to read the files worth opening, simplest entry point first
- per described file: \`why\` to open it, \`risk\` (low / medium / high), any \`unknowns\` to confirm

## Evidence

When a change is visual or behavioural, capture proof it runs and attach it:

\`\`\`
pnpm breadcrumb evidence add ./demo.mp4 --task <task-id> --caption "what the reviewer is looking at"
\`\`\`

The reviewer watches it before reading the diff, so they spend their attention on how you did it rather than whether you did it. Skip evidence when there is nothing to see, such as a pure refactor. One or two clips, not a reel.

Do not add model or agent attribution. Do not invent certainty; put doubts in \`unknowns\`.`;
}

// returns the breadcrumb-handoff skill the same file written for every agent
function getHandoffSkill(): string {
  return `---
name: breadcrumb-handoff
description: Use whenever you are about to open a pull request, or are asked to open one. Writes the review.yml handoff that guides the human reviewer, runs breadcrumb check until it passes, opens the pull request, and hands back the Breadcrumb link. Once per pull request, not once per commit and not once per subagent.
---

# Writing a Breadcrumb handoff

A handoff tells a human how to review your change. It is not a summary of the diff and it is not an inventory of what you touched. They already have the diff.

Write one per pull request, once, after the work is done and before the pull request is opened. Your final message names the Breadcrumb link, not the GitHub one.

## Describe only what a reviewer must open

This is the part that makes a handoff worth reading, so get it right before anything else.

A large change does not mean a large handoff. Thirty changed files with two that carry the real risk is a two file handoff. Leave the rest out. That is correct, not lazy.

Delete any entry that reads like one of these:

- "small refactor"
- "comment wording only"
- "adopts the shared helper"
- "test for the above"
- "type update to match"

Each one spends the reviewer's attention and returns nothing. A file earns an entry when a reviewer would be worse off not opening it: it holds the logic, it carries risk, it is where a bug would hide, or you are unsure about it.

\`pnpm breadcrumb check\` reports how many files you left undescribed. That is a count, not a complaint. It never fails the gate.

## The loop

1. \`pnpm breadcrumb task new <task-id>\` creates \`.breadcrumb/tasks/<task-id>/review.yml\` from the template.
2. Fill it in (see below).
3. \`pnpm breadcrumb check --task <task-id>\` validates it and compares it against your real git changes.
4. Fix what it reports. Repeat until it prints \`breadcrumb check passed\`.
5. Open the pull request, then run \`pnpm breadcrumb link\` and hand back the url it prints.

Do not hand the task back until check passes and you have given the Breadcrumb link.

## The link you hand back

The reviewer opens Breadcrumb, not GitHub. Once the pull request is open:

\`\`\`
pnpm breadcrumb link
\`\`\`

It prints one url and nothing else. Hand that back instead of the GitHub url \`gh pr create\` printed. It reads the repository from git and the pull request number from \`gh\`, so it takes no arguments. Pass \`--pr <number>\` when \`gh\` cannot see the branch.

A draft is worth linking. \`link\` tells you when the pull request is a draft, because a draft opens in Breadcrumb but does not appear in the inbox until it is marked ready for review. Pass that on.

## Fields

**\`problem\`** the context or pain behind the work, separate from the goal. One or two plain sentences. Optional but recommended.

**\`user_goal\`** what the person actually asked for, in their words, not the implementation.
Good: "Let sales reps add optional add-ons to a quote."
Weak: "Added AddOn type and updated QuoteTotal."

**\`solution\`** how you solved it, in markdown. Headings, lists, and fenced code are fine. Add a \`mermaid\` diagram only when it makes the architecture clearer, and keep it to the part that changed. If you are unsure of a relationship, leave it out rather than guess. Optional but recommended.

**\`review_sequence\`** the order to read the change. Put the file that makes the rest make sense first, then build outward. Group into titled sections, each with a one-line \`why\`. List only the files worth opening. Two or three sections is usually enough.

**\`files\`** one entry for each file you named in the sequence, and nothing else:
- \`why\` one line on what to look at, not on what changed.
- \`risk\` low / medium / high. Be honest. Money, auth, migrations, and data deletion skew high.
- \`unknowns\` things you could not verify and want the reviewer to confirm. A high risk file almost always has at least one. If you are sure of everything, leave it empty, do not invent doubt.

## Evidence

If the change is visual or behavioural, capture proof it actually runs and attach it to the task:

\`\`\`
pnpm breadcrumb evidence add ./demo.mp4 --task <task-id> --caption "add-on picker updates the total"
\`\`\`

This writes the handle into the handoff for you. Screenshots and short recordings only: png, jpeg, webp, mp4, webm.

When it is worth it:
- a ui change, a new screen or state, anything with a before and after
- a bug fix where the point is that the broken thing now works
- a flow with several steps, where a recording beats a paragraph

When to skip it:
- a refactor with no observable difference
- config, types, docs, or tests
- anything where a reader would learn nothing from watching

Keep it to one or two captures. The caption should say what the reviewer is looking at, not what the file is. Never attach something you have not actually watched back.

## Tone

Short, plain, honest. No model or agent attribution. No marketing. If something is unclear, say so under \`unknowns\` rather than papering over it. The reviewer's time is the thing you are saving.

## Example

This change touched 31 files. Three are worth a reviewer's time.

\`\`\`yaml
version: 1
id: quote-add-ons
title: Add optional add-ons to the quote flow
problem: Reps could not attach optional services to a quote, so upsells happened off platform.
user_goal: Let sales reps add optional services to a quote.
solution: |
  Add-ons are priced in one module and folded into the quote total, then offered
  in the builder UI. The other 28 files adopt the new pricing type.

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
      - src/pricing/add-ons.test.ts
  - title: Quote UI
    why: Where reps pick add-ons and the only place the total is shown.
    files:
      - src/quote/builder.tsx
files:
  - path: src/pricing/add-ons.ts
    why: Defines add-on pricing and how it folds into the quote total.
    risk: high
    unknowns:
      - Confirm tax applies to add-ons the same way it does to base line items.
  - path: src/pricing/add-ons.test.ts
    why: Covers the rounding case that broke the old total.
    risk: medium
  - path: src/quote/builder.tsx
    why: Adds the picker and recomputes the total on every change.
    risk: medium
\`\`\`

Why it works: the problem frames the change, the solution gives a one screen map and accounts for the other 28 files in a single clause, the reading order starts where the logic lives, and the risky file names a real thing to confirm. A reviewer knows where to start within seconds and never reads a sentence written to satisfy a rule.
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
  breadcrumb update [--force]
  breadcrumb task new <id>
  breadcrumb check --task <id> [--json] [--strict] [--base <ref>]
  breadcrumb check --ci [--base <ref>]
  breadcrumb evidence add <file> --task <id> [--caption <text>] [--repo owner/name]
  breadcrumb link [--pr <number>] [--repo owner/name]
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
