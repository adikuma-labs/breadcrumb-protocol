# @adikuma/breadcrumb

CLI for creating and checking Breadcrumb review handoffs.

Breadcrumb helps reviewers understand agent-written pull requests by asking the coding agent to leave a small structured trail next to the code. The trail lives in the repo at `.breadcrumb/tasks/<task-id>/review.yml`.

## Install

Run it without installing:

```bash
pnpm dlx @adikuma/breadcrumb init
```

Or add it to a project:

```bash
pnpm add -D @adikuma/breadcrumb
```

## Commands

```bash
breadcrumb init
breadcrumb init --agent claude,codex
breadcrumb init --workflow
breadcrumb task new <id>
breadcrumb check --task <id>
breadcrumb check --task <id> --json
breadcrumb check --task <id> --strict
breadcrumb check --ci
```

## Typical Flow

```bash
breadcrumb init
breadcrumb task new quote-add-ons
breadcrumb check --task quote-add-ons
```

`breadcrumb init` sets up the handoff and asks which agents should get the handoff skill. A developer sees an interactive picker; an agent or CI passes `--agent` (defaulting to `claude,codex`). It creates:

```text
.breadcrumb/
  config.yml
  tasks/
  templates/review.yml
AGENTS.md                                  # the handoff contract
CLAUDE.md                                  # imports AGENTS.md
.claude/skills/breadcrumb-handoff/SKILL.md # claude
.codex/skills/breadcrumb-handoff/SKILL.md  # codex
.agents/skills/breadcrumb-handoff/SKILL.md # codex cross agent dir
```

AGENTS.md holds the contract; CLAUDE.md just imports it with `@AGENTS.md`. The skill carries the craft of writing a good handoff and loads only when an agent is writing one. Existing instruction files are updated in place inside a managed block, never replaced. Pass `--agent none` to skip the skill.

## What Check Does

`breadcrumb check` validates the handoff and compares it with the real git changed files.

It checks that:

- `review.yml` has the expected schema
- changed files are covered by the review path
- risk values are valid
- paths are relative and safe
- generated folders like `node_modules`, `dist`, `.next`, and `coverage` are ignored

## CI Gate

`breadcrumb check --ci` runs the same validation as a pull request gate, with no arguments needed:

- finds the handoff the pull request touches (exactly one `review.yml` is expected; zero or several fail)
- diffs against the pull request base branch via `GITHUB_BASE_REF`
- runs strict, so a changed file with no `why` and `risk` fails the check
- prints GitHub error annotations on `review.yml` and writes a step summary

Add the workflow with `breadcrumb init --workflow`, or copy it yourself:

```yaml
name: breadcrumb

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  check:
    if: ${{ !contains(github.event.pull_request.labels.*.name, 'breadcrumb-skip') }}
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
```

`fetch-depth: 0` gives the runner enough history to diff against the base branch. Label a pull request `breadcrumb-skip` to wave it through without a handoff, for example a dependency bump. To make the gate required, mark the `check` job as a required status check in branch protection.

## Example Handoff

```yaml
version: 1
id: quote-add-ons
title: Add optional add-ons to the quote flow
user_goal: Let sales reps add optional services to a quote.
summary: Adds add-on selection and includes add-ons in quote totals.
review_sequence:
  - src/pricing/tax.ts
files:
  - path: src/pricing/tax.ts
    why: Start here because this file defines the pricing rule.
    risk: medium
```

## Why This Exists

Normal pull request tools show what changed. Breadcrumb adds how to read it: the intent, risk, and recommended review order.

## Releasing

Before bumping the version and publishing, run the packaging smoke test. It packs the tarball, installs it into a clean directory, and runs the installed binary, so a missing file fails here instead of after publish:

```bash
pnpm --filter @adikuma/breadcrumb check   # types + unit tests
pnpm --filter @adikuma/breadcrumb smoke   # packaged artifact runs end to end
```
