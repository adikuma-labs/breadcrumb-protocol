# Breadcrumb

Agents write the code. Somebody still has to read it.

Breadcrumb is a small handoff format for agent-written changes. Before an agent hands work back, it writes `.breadcrumb/tasks/<task-id>/review.yml`: the problem, the goal, the order to read the files in, and what it is not sure about. The file lives in the repo next to the code, so it travels with the pull request instead of sitting in a database. A CLI validates the handoff against your real git changes and can gate CI on it.

This repo is the open part of Breadcrumb: the format and the tooling.

- [`@adikuma/breadcrumb`](https://www.npmjs.com/package/@adikuma/breadcrumb) is the CLI
- [`@adikuma/breadcrumb-protocol`](https://www.npmjs.com/package/@adikuma/breadcrumb-protocol) is the schema and validation helpers

The hosted review room at [breadcrumb.run](https://breadcrumb.run) renders these handoffs, but it is just one take on the UI. The format is plain YAML in your repo, so you can build the review experience you actually want on top of it.

## Use it

Set up a repo once:

```bash
pnpm dlx @adikuma/breadcrumb init
```

Then the loop, per change:

```bash
breadcrumb task new my-feature
breadcrumb check --task my-feature
```

`init` scaffolds `.breadcrumb/` and the agent instructions. `task new` stamps a fresh `review.yml`. `check` validates it and compares it against your real changed files, so a file the handoff does not describe fails the check.

Gate pull requests in CI:

```bash
breadcrumb init --workflow
```

This adds a GitHub Actions workflow that runs `breadcrumb check --ci` against the PR base branch. Label a PR `breadcrumb-skip` to wave it through.

Building your own tooling? Validate handoffs directly:

```ts
import { parseBreadcrumbReviewYaml } from "@adikuma/breadcrumb-protocol";

const result = parseBreadcrumbReviewYaml(source);
```

## Run it locally

If you would rather run from source than install the package:

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js --help
```

Run the checks:

```bash
pnpm test
pnpm smoke
```

`test` runs the unit tests. `smoke` packs the real tarball, installs it into a clean directory, and runs the installed binary, so a packaging mistake fails here instead of after publish.

## The format

```yaml
version: 1
id: quote-add-ons
title: Add optional add-ons to the quote flow
user_goal: Let sales reps add optional services to a quote.
review_sequence:
  - title: Pricing rule
    why: Read the pricing rule first; the rest builds on it.
    files:
      - src/pricing/tax.ts
files:
  - path: src/pricing/tax.ts
    why: Defines the add-on pricing rule.
    risk: medium
```

The full field reference is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Versioning

Both packages follow [semver](https://semver.org). Only the latest release of each is supported. Earlier versions on npm predate the stable format and had rough edges, so always install `@latest`.

## License

MIT
