# Architecture

Two packages, one format.

```
packages/protocol   @adikuma/breadcrumb-protocol   the schema, zod validation, coverage math
packages/cli        @adikuma/breadcrumb            init, task new, check, the ci gate
```

The protocol package is separate so the CLI, the hosted review room, and any tooling you build all validate the same format.

## The handoff format

A handoff lives at `.breadcrumb/tasks/<task-id>/review.yml`. One handoff per task or feature, the change that becomes a PR.

| field | required | what it is |
| --- | --- | --- |
| `version` | yes | the literal `1` |
| `id` | yes | task id, matches the folder name |
| `title` | yes | short title for the change |
| `user_goal` | yes | what the person asked for, in plain language |
| `problem` | no | the context or pain behind the change |
| `summary` | no | one line summary |
| `solution` | no | how it was solved, markdown, mermaid allowed |
| `review_sequence` | yes | ordered sections, each with `title`, `why`, and a `files` list |
| `files` | yes | one entry per changed file |

Each entry in `files`:

| field | required | what it is |
| --- | --- | --- |
| `path` | yes | relative posix path, no `..`, no absolute paths |
| `why` | yes | one line on why this file changed |
| `risk` | yes | `low`, `medium`, or `high` |
| `change` | no | `feature`, `fix`, `chore`, `refactor`, `test`, `docs`, `config`, `migration`, `dependency`, `generated`, `other` |
| `unknowns` | no | things the author could not verify, for the reviewer to confirm |
| `tests` | no | paths of tests covering this file |

Cross-field rules the schema enforces:

- every `review_sequence` file must also appear in `files`
- no duplicate paths in `files` or across `review_sequence`
- paths are validated as safe relative posix paths

Non-blocking warnings: a described file missing from the reading order, and a `high` risk file with no `unknowns`.

## What check does

`breadcrumb check` parses the handoff, validates the schema, then compares it against the real changed files from git. The comparison buckets every path:

- `explained`: changed and described
- `unexplained`: changed but missing from the handoff, this fails strict mode
- `unsequenced`: described but not placed in the reading order
- `invalidReferences`: described but not actually changed

Generated folders like `node_modules`, `dist`, and coverage output are ignored. The handoff file itself does not need to describe itself.

## The CI gate

`breadcrumb check --ci` is the same validation shaped for a pull request gate:

- finds the one `review.yml` the PR touches, zero or several fail
- diffs against the PR base branch via `GITHUB_BASE_REF`
- runs strict, so a changed file with no `why` and `risk` fails
- prints GitHub error annotations and writes a step summary

## Design stance

- the repo is the source of truth, the handoff travels with the PR
- no code is stored anywhere else, the format works without any hosted app
- no model or agent attribution in the schema, the handoff explains the change, not who typed it
- honest over complete, doubts belong in `unknowns` rather than papered over
