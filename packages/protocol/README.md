# @adikuma/breadcrumb-protocol

Schema and validation helpers for Breadcrumb review handoffs.

Breadcrumb uses a small `.breadcrumb/tasks/<task-id>/review.yml` file to explain an agent-written code change before a human reviews it. This package defines that file format and validates it with Zod.

Most users should install the CLI instead:

```bash
pnpm dlx @adikuma/breadcrumb init
```

Use this package directly when building tools that need to read or validate Breadcrumb handoffs.

```bash
pnpm add @adikuma/breadcrumb-protocol
```

```ts
import { parseBreadcrumbReviewYaml } from "@adikuma/breadcrumb-protocol";

const result = parseBreadcrumbReviewYaml(source);

if (!result.ok) {
  console.error(result.errors);
}
```

## What It Validates

- `version` must be `1`
- `risk` must be `low`, `medium`, or `high`
- paths must be relative POSIX paths
- each `review_sequence` section needs a `title`, a `why`, and a `files` list
- every `review_sequence` file must also appear in `files`
- duplicate paths and invalid schema fields are rejected

## Minimal Handoff

```yaml
version: 1
id: quote-add-ons
title: Add optional add-ons to the quote flow
user_goal: Let sales reps add optional services to a quote.
summary: Adds add-on selection and includes add-ons in quote totals.
review_sequence:
  - title: Pricing rule
    why: Read the pricing rule first; the rest of the change builds on it.
    files:
      - src/pricing/tax.ts
files:
  - path: src/pricing/tax.ts
    why: Defines the add-on pricing and tax rule.
    risk: medium
```

## Package Role

This package is intentionally separate from the CLI so the Breadcrumb web app, CLI, and future tooling can all validate the same handoff format.
