import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const BREADCRUMB_PROTOCOL_VERSION = 1;

export const riskSchema = z.enum(["low", "medium", "high"]);

export const changeKindSchema = z.enum([
  "feature",
  "fix",
  "chore",
  "refactor",
  "test",
  "docs",
  "config",
  "migration",
  "dependency",
  "generated",
  "other",
]);

const pathSchema = z
  .string()
  .min(1, "path is required")
  .superRefine((value, ctx) => {
    const result = validateBreadcrumbPath(value);

    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: result.reason,
      });
    }
  });

const fileSchema = z
  .object({
    path: pathSchema,
    why: z.string().min(1, "why is required"),
    risk: riskSchema,
    change: changeKindSchema.optional(),
    unknowns: z.array(z.string().min(1)).optional().default([]),
    tests: z.array(pathSchema).optional().default([]),
  })
  .strict();

const reviewSequenceSectionSchema = z
  .object({
    title: z.string().min(1, "title is required"),
    why: z.string().min(1, "why is required"),
    files: z.array(pathSchema).min(1, "at least one file is required"),
  })
  .strict();

export const breadcrumbReviewSchema = z
  .object({
    version: z.literal(BREADCRUMB_PROTOCOL_VERSION),
    id: z.string().min(1, "id is required"),
    title: z.string().min(1, "title is required"),
    problem: z.string().min(1).optional(),
    user_goal: z.string().min(1, "user_goal is required"),
    summary: z.string().min(1).optional(),
    solution: z.string().min(1).optional(),
    review_sequence: z
      .array(reviewSequenceSectionSchema)
      .min(1, "review_sequence must include at least one section"),
    files: z.array(fileSchema).min(1, "files must include at least one file"),
  })
  .strict()
  .superRefine((review, ctx) => {
    const filePaths = new Set<string>();

    for (const [index, file] of review.files.entries()) {
      if (filePaths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `duplicate file path: ${file.path}`,
        });
      }

      filePaths.add(file.path);
    }

    const sequencedPaths = new Set<string>();

    for (const [sectionIndex, section] of review.review_sequence.entries()) {
      for (const [fileIndex, filePath] of section.files.entries()) {
        if (!filePaths.has(filePath)) {
          ctx.addIssue({
            code: "custom",
            path: ["review_sequence", sectionIndex, "files", fileIndex],
            message: `review_sequence references a file not listed in files: ${filePath}`,
          });
        }

        if (sequencedPaths.has(filePath)) {
          ctx.addIssue({
            code: "custom",
            path: ["review_sequence", sectionIndex, "files", fileIndex],
            message: `duplicate review_sequence file: ${filePath}`,
          });
        }

        sequencedPaths.add(filePath);
      }
    }
  });

export type BreadcrumbRisk = z.infer<typeof riskSchema>;
export type BreadcrumbChangeKind = z.infer<typeof changeKindSchema>;
export type BreadcrumbReview = z.infer<typeof breadcrumbReviewSchema>;

export type BreadcrumbIssueSeverity = "error" | "warning";

export type BreadcrumbIssue = {
  code: string;
  message: string;
  path: string;
  severity: BreadcrumbIssueSeverity;
  hint?: string;
};

export type BreadcrumbValidationSuccess = {
  ok: true;
  data: BreadcrumbReview;
  warnings: BreadcrumbIssue[];
};

export type BreadcrumbValidationFailure = {
  ok: false;
  errors: BreadcrumbIssue[];
  warnings: BreadcrumbIssue[];
};

export type BreadcrumbValidationResult =
  | BreadcrumbValidationSuccess
  | BreadcrumbValidationFailure;

export type ChangedFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed";

export type ChangedFile = {
  path: string;
  status?: ChangedFileStatus;
  previousPath?: string;
};

export type HandoffCoverage = {
  explained: string[];
  unexplained: string[];
  unsequenced: string[];
  invalidReferences: string[];
};

type PathValidationResult =
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      reason: string;
    };

// parses yaml and validates it as a breadcrumb review handoff
export function parseBreadcrumbReviewYaml(source: string): BreadcrumbValidationResult {
  let parsed: unknown;

  try {
    parsed = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: "yaml_parse_error",
          message: error instanceof Error ? error.message : "invalid yaml",
          path: "",
          severity: "error",
        },
      ],
      warnings: [],
    };
  }

  return validateBreadcrumbReview(parsed);
}

// validates an unknown value against the breadcrumb review schema
export function validateBreadcrumbReview(input: unknown): BreadcrumbValidationResult {
  const result = breadcrumbReviewSchema.safeParse(input);

  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: formatIssuePath(issue.path),
        severity: "error",
      })),
      warnings: [],
    };
  }

  return {
    ok: true,
    data: result.data,
    warnings: getBreadcrumbWarnings(result.data),
  };
}

// checks whether a repository path is safe and canonical for breadcrumb files
export function validateBreadcrumbPath(value: string): PathValidationResult {
  if (value.length === 0) {
    return { ok: false, reason: "path is required" };
  }

  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }

  if (value.includes("\\")) {
    return { ok: false, reason: "paths must use forward slashes" };
  }

  if (value.includes("//")) {
    return { ok: false, reason: "paths must not contain empty segments" };
  }

  const segments = value.split("/");

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "paths must not contain . or .. segments" };
  }

  if (segments.some((segment) => segment.trim().length === 0)) {
    return { ok: false, reason: "paths must not contain blank segments" };
  }

  return { ok: true, path: value };
}

// returns true when a path is safe for use inside a breadcrumb handoff
export function isSafeBreadcrumbPath(value: string): boolean {
  return validateBreadcrumbPath(value).ok;
}

// returns the ordered list of files from all review sequence sections
export function getSequencedPaths(review: BreadcrumbReview): string[] {
  return review.review_sequence.flatMap((section) => section.files);
}

// compares a handoff against real changed files from git or github
export function compareReviewToChangedFiles(
  review: BreadcrumbReview,
  changedFiles: ChangedFile[],
): HandoffCoverage {
  const changed = new Set(
    changedFiles
      .map((file) => normalizeChangedFilePath(file))
      .filter((path): path is string => Boolean(path)),
  );

  const explained = review.files
    .map((file) => file.path)
    .filter((path) => changed.has(path));

  const filePaths = new Set(review.files.map((file) => file.path));
  const sequencedPaths = new Set(getSequencedPaths(review));

  const unexplained = [...changed]
    .filter((path) => !isBreadcrumbReviewPath(path))
    .filter((path) => !filePaths.has(path))
    .sort();

  const unsequenced = [...filePaths]
    .filter((path) => changed.has(path))
    .filter((path) => !sequencedPaths.has(path))
    .sort();

  const invalidReferences = [...filePaths]
    .filter((path) => !changed.has(path))
    .filter((path) => !isBreadcrumbReviewPath(path))
    .sort();

  return {
    explained: explained.sort(),
    unexplained,
    unsequenced,
    invalidReferences,
  };
}

// checks whether a path points to a breadcrumb review handoff
export function isBreadcrumbReviewPath(value: string): boolean {
  return /^\.(breadcrumb|diffroom)\/tasks\/[^/]+\/review\.ya?ml$/.test(value);
}

// creates non blocking guidance for a valid breadcrumb review
export function getBreadcrumbWarnings(review: BreadcrumbReview): BreadcrumbIssue[] {
  const warnings: BreadcrumbIssue[] = [];
  const sequencedPaths = new Set(getSequencedPaths(review));

  for (const file of review.files) {
    if (!sequencedPaths.has(file.path)) {
      warnings.push({
        code: "unsequenced_file",
        message: `${file.path} is described but not included in review_sequence`,
        path: "files",
        severity: "warning",
      });
    }

    if (file.risk === "high" && file.unknowns.length === 0) {
      warnings.push({
        code: "high_risk_without_unknowns",
        message: `${file.path} is high risk but has no unknowns listed`,
        path: file.path,
        severity: "warning",
        hint: "add an unknown when the reviewer should confirm something",
      });
    }
  }

  return warnings;
}

// formats a zod issue path for cli and ui output
function formatIssuePath(path: PropertyKey[]): string {
  return path.map((part) => String(part)).join(".");
}

// normalizes a changed file object into its current path
function normalizeChangedFilePath(file: ChangedFile): string | null {
  const candidate = file.path || file.previousPath;

  if (!candidate || !isSafeBreadcrumbPath(candidate)) {
    return null;
  }

  return candidate;
}
