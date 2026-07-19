# AGENTS.md

## Project Overview

Breadcrumb is a handoff format for agent-written code changes. This repo holds the open tooling: the `@adikuma/breadcrumb` CLI and the `@adikuma/breadcrumb-protocol` schema package. The hosted review room is a separate private app.

## Setup

Use pnpm only.

```bash
pnpm install
```

## Common Commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm smoke
```

## Code Style

- Write TypeScript.
- Keep modules small and readable.
- Use existing local patterns before adding abstractions.

## Security

- Use pnpm only.
- Do not bypass the pnpm minimum release age gate without approval.
- Do not add broad dependencies when Node or existing packages are enough.

## Git Workflow

- Use conventional commits.
- Keep commit messages one line.

## Product Rules

- Breadcrumb is not an AI reviewer. It is an agent-authored review guide.
- The product should reduce information overload.
- Prefer short intent, risk, unknowns, and review path over long summaries.
- Do not add attribution for the model or coding agent to the schema.
