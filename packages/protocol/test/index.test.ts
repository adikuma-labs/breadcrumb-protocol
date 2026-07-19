import { describe, expect, it } from "vitest";

import {
  compareReviewToChangedFiles,
  getSequencedPaths,
  isBreadcrumbReviewPath,
  isSafeBreadcrumbPath,
  parseBreadcrumbReviewYaml,
  validateBreadcrumbReview,
} from "../src/index";

const validYaml = `
version: 1
id: quote-add-ons
title: Add optional add-ons to quote flow
user_goal: Let customers attach optional add-ons to a quote.
summary: Adds add-on model, persistence, pricing, UI, and tests.
review_sequence:
  - title: Data shape
    why: These files define the add-on model.
    files:
      - src/quote/types.ts
      - src/db/migrations/0007_add_addons.sql
files:
  - path: src/quote/types.ts
    why: Defines the add-on model every other file depends on.
    risk: low
    change: feature
    tests:
      - src/pricing/calculateQuote.test.ts
  - path: src/db/migrations/0007_add_addons.sql
    why: Persists add-ons and links them to quotes.
    risk: medium
    change: migration
    unknowns:
      - Whether existing quotes need a backfill.
`;

describe("parseBreadcrumbReviewYaml", () => {
  it("parses a valid review handoff", () => {
    const result = parseBreadcrumbReviewYaml(validYaml);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("expected review yaml to parse");
    }

    expect(result.data.id).toBe("quote-add-ons");
    expect(getSequencedPaths(result.data)).toEqual([
      "src/quote/types.ts",
      "src/db/migrations/0007_add_addons.sql",
    ]);
  });

  it("returns a yaml error for invalid yaml", () => {
    const result = parseBreadcrumbReviewYaml("version: [");

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("expected invalid yaml to fail");
    }

    expect(result.errors[0]?.code).toBe("yaml_parse_error");
  });
});

describe("validateBreadcrumbReview", () => {
  it("rejects unknown keys", () => {
    const result = validateBreadcrumbReview({
      version: 1,
      id: "quote-add-ons",
      title: "Add optional add-ons",
      user_goal: "Add optional add-ons.",
      summary: "Adds optional add-ons.",
      extra: true,
      review_sequence: [
        {
          title: "Data shape",
          why: "Read types first.",
          files: ["src/quote/types.ts"],
        },
      ],
      files: [
        {
          path: "src/quote/types.ts",
          why: "Defines add-ons.",
          risk: "low",
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects unsafe paths", () => {
    const result = parseBreadcrumbReviewYaml(`
version: 1
id: unsafe
title: Unsafe
user_goal: Check unsafe paths.
summary: Checks unsafe paths.
review_sequence:
  - title: Unsafe
    why: This should fail.
    files:
      - ../secrets.ts
files:
  - path: ../secrets.ts
    why: Unsafe.
    risk: high
`);

    expect(result.ok).toBe(false);
  });

  it("rejects duplicate files in the review sequence", () => {
    const result = parseBreadcrumbReviewYaml(`
version: 1
id: duplicate
title: Duplicate
user_goal: Check duplicate paths.
summary: Checks duplicate paths.
review_sequence:
  - title: First
    why: First pass.
    files:
      - src/a.ts
  - title: Second
    why: Second pass.
    files:
      - src/a.ts
files:
  - path: src/a.ts
    why: Changed.
    risk: low
`);

    expect(result.ok).toBe(false);
  });

  it("warns when high-risk files have no unknowns", () => {
    const result = parseBreadcrumbReviewYaml(`
version: 1
id: high-risk
title: High risk
user_goal: Change pricing.
summary: Changes pricing.
review_sequence:
  - title: Pricing
    why: Pricing changed.
    files:
      - src/pricing/tax.ts
files:
  - path: src/pricing/tax.ts
    why: Changes tax behavior.
    risk: high
`);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("expected high-risk yaml to parse with warnings");
    }

    expect(result.warnings.map((warning) => warning.code)).toContain(
      "high_risk_without_unknowns",
    );
  });
});

describe("architecture fields", () => {
  it("accepts optional problem and solution fields", () => {
    const result = parseBreadcrumbReviewYaml(`
version: 1
id: arch-overview
title: Add an architecture overview
problem: Reviewers had no high level map before the file by file trail.
user_goal: Explain the change before walking each file.
solution: |
  Adds problem, user_goal, and solution to the handoff and renders them as markdown.

  \`\`\`mermaid
  flowchart LR
    Handoff --> Trail
  \`\`\`
review_sequence:
  - title: Schema
    why: Read the schema first.
    files:
      - src/a.ts
files:
  - path: src/a.ts
    why: Holds the change.
    risk: low
`);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("expected architecture fields to parse");
    }

    expect(result.data.problem).toBe(
      "Reviewers had no high level map before the file by file trail.",
    );
    expect(result.data.solution).toContain("mermaid");
  });

  it("validates a handoff without a summary", () => {
    const result = parseBreadcrumbReviewYaml(`
version: 1
id: no-summary
title: No summary present
user_goal: Drop the legacy summary field.
review_sequence:
  - title: Only file
    why: Read it.
    files:
      - src/a.ts
files:
  - path: src/a.ts
    why: The change.
    risk: low
`);

    expect(result.ok).toBe(true);
  });
});

describe("path helpers", () => {
  it("accepts relative posix paths", () => {
    expect(isSafeBreadcrumbPath("src/pricing/tax.ts")).toBe(true);
  });

  it("rejects windows paths", () => {
    expect(isSafeBreadcrumbPath("src\\pricing\\tax.ts")).toBe(false);
  });

  it("detects breadcrumb review paths", () => {
    expect(
      isBreadcrumbReviewPath(".breadcrumb/tasks/quote-add-ons/review.yml"),
    ).toBe(true);
    expect(isBreadcrumbReviewPath(".diffroom/tasks/legacy/review.yaml")).toBe(
      true,
    );
  });
});

describe("compareReviewToChangedFiles", () => {
  it("classifies explained and unexplained changed files", () => {
    const result = parseBreadcrumbReviewYaml(validYaml);

    if (!result.ok) {
      throw new Error("expected fixture to parse");
    }

    const coverage = compareReviewToChangedFiles(result.data, [
      { path: "src/quote/types.ts", status: "modified" },
      { path: "src/db/migrations/0007_add_addons.sql", status: "added" },
      { path: "src/api/quoteRoute.ts", status: "modified" },
      { path: ".breadcrumb/tasks/quote-add-ons/review.yml", status: "added" },
    ]);

    expect(coverage.explained).toEqual([
      "src/db/migrations/0007_add_addons.sql",
      "src/quote/types.ts",
    ]);
    expect(coverage.unexplained).toEqual(["src/api/quoteRoute.ts"]);
    expect(coverage.invalidReferences).toEqual([]);
  });
});
