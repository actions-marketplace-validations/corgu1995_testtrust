// ============================================================================
// src/types.ts
// FROZEN SHARED CONTRACTS. These are the exact, stable signatures all six
// engineers code against. Do NOT change field names/shapes without a team
// sync — detectors, regression, scorer, reporters, and CLI all depend on them.
// Verified to compile under tsc --strict (nodenext) with ts-morph.
// ============================================================================
import type { Project, SourceFile } from "ts-morph";

/** Wire-format severity carried on every Finding. NOTE: this is NOT the gate
 *  verdict. Detectors emit "warn" for anything risky; only the scorer decides
 *  pass/neutral/fail. Default conservative: prefer "warn" over "fail". */
export type Severity = "fail" | "warn" | "info";

/** Gate outcome computed by the scorer (the thing CI keys off of). */
export type Verdict = "pass" | "neutral" | "fail";

/** Closed set of rule identifiers. Adding a detector = add its id here (one
 *  line) so the type system tracks coverage. */
export type RuleId =
  | "assertion-free"
  | "snapshot-only"
  | "tautology"
  | "over-mocking-sut"
  | "trivial-assertion"
  // --- regression / "the wedge" (require a base ref) ---
  | "assertion-weakened"
  | "assertion-deleted"
  | "test-skipped";

/** A single problem located in a test file. The atomic unit every producer
 *  (detectors + regression) emits and every consumer (scorer + reporters)
 *  reads. line/column are 1-based to match editors. */
export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  /** Absolute or cwd-relative path of the offending test file. */
  file: string;
  /** 1-based line in the CURRENT (head) version of the file. */
  line: number;
  /** 1-based column, when known. */
  column?: number;
  /** Human-readable, single-sentence explanation. */
  message: string;
  /** Optional source excerpt for inline annotation in the human report. */
  snippet?: string;
  /** Optional end line for multi-line findings (e.g. a whole skipped block). */
  endLine?: number;
  /** Name of the enclosing it()/test() block, when resolvable. */
  testName?: string;
  /** Rule-specific structured detail for the JSON consumers (e.g. the
   *  before/after matcher for assertion-weakened). Never used for control flow. */
  data?: Record<string, unknown>;
}

/** Everything a detector needs about ONE test file. Built by core/ast.ts.
 *  base* fields are populated only when a base ref was provided AND the file
 *  exists on base; detectors that need them must declare requiresBase=true. */
export interface TestFileContext {
  /** Path as the user referenced it (cwd-relative or absolute). */
  filePath: string;
  /** Parsed head version. */
  sourceFile: SourceFile;
  /** Owning project (shared TS program; do not mutate). */
  project: Project;
  /** Convenience: full head text. */
  getText(): string;
  /** Parsed base-branch version, if available. */
  baseSourceFile?: SourceFile;
  /** Full base text, if available. */
  baseText?: string;
  /** True when this file is part of the diff/changeset (vs. explicit file arg). */
  isChanged: boolean;
}

/** Static, declarative description of a detector. */
export interface DetectorMeta {
  id: RuleId;
  /** Short label for reports, e.g. "Tautological assertion". */
  title: string;
  /** One-line rationale shown in --help / docs. */
  description: string;
  /** Severity used when the user hasn't overridden it. */
  defaultSeverity: Severity;
  /** If true, the engine skips this detector when no base ref is available. */
  requiresBase: boolean;
}

/** Per-run knobs handed to a detector (currently just severity override). */
export interface DetectorRunOptions {
  /** When set, the detector MUST stamp findings with this instead of
   *  meta.defaultSeverity. The engine resolves this from CliOptions.rules. */
  severityOverride?: Severity;
}

/** The contract every smell + the regression engine implements. Pure and
 *  synchronous: given one file's context, return zero or more findings.
 *  Implementations MUST NOT do IO, mutate the AST, or read other files. */
export interface Detector {
  readonly meta: DetectorMeta;
  run(ctx: TestFileContext, options: DetectorRunOptions): Finding[];
}

/** Per-rule enable/severity config (from --rule flags or a future config file). */
export interface RuleConfig {
  enabled: boolean;
  /** Optional severity override; falls back to the detector's default. */
  severity?: Severity;
}

/** Input to the PURE scorer. No IO, no AST — just the collected findings. */
export interface ScoreInput {
  findings: Finding[];
  /** How many test files were actually analyzed (for context, not scoring). */
  filesAnalyzed: number;
  /** Score at/under which the verdict becomes "fail". */
  failThreshold: number;
}

/** Per-rule contribution to the deducted score, for transparency in reports. */
export interface RuleScoreBreakdown {
  ruleId: RuleId;
  count: number;
  /** Total points this rule subtracted from 100. */
  penalty: number;
}

/** Output of the PURE scorer. Deterministic for a given ScoreInput. */
export interface ScoreResult {
  /** Integer 0-100. 100 = no findings. */
  score: number;
  /** Gate outcome. Convention (encoded in scorer.ts, frozen here):
   *  - any Finding of severity "fail"  -> verdict "fail"
   *  - else score < failThreshold      -> verdict "fail"
   *  - else any "warn" finding          -> verdict "neutral"
   *  - else                             -> verdict "pass" */
  verdict: Verdict;
  failThreshold: number;
  totalFindings: number;
  countsBySeverity: Record<Severity, number>;
  breakdown: RuleScoreBreakdown[];
}

/** How files are sourced for this run. */
export type InputMode = "files" | "diff";
export type OutputFormat = "human" | "json";

/** Fully-resolved CLI options (after parsing + defaulting). The orchestrator
 *  (core/analyze.ts) consumes exactly this — the parser in cli.ts produces it. */
export interface CliOptions {
  mode: InputMode;
  /** Explicit file globs/paths (mode="files"). Ignored when mode="diff". */
  files: string[];
  /** Base git ref to diff against (mode="diff"), e.g. "origin/main". */
  baseRef: string;
  /** Working directory the run is rooted at. */
  cwd: string;
  format: OutputFormat;
  failThreshold: number;
  /** Per-rule overrides keyed by RuleId; absent = detector default. */
  rules: Partial<Record<RuleId, RuleConfig>>;
  /** In diff mode, restrict analysis to changed test files only. */
  onlyChangedTests: boolean;
  noColor: boolean;
  /** Suppress non-essential stderr logging. */
  quiet: boolean;
}

/** The top-level result object. JSON output is exactly this serialized. */
export interface Report {
  /** testtrust version that produced the report. */
  version: string;
  /** ISO-8601 timestamp. */
  generatedAt: string;
  mode: InputMode;
  /** Base ref used, or null in files mode. */
  baseRef: string | null;
  score: ScoreResult;
  findings: Finding[];
}

/** Programmatic entry point (src/index.ts) for embedders/tests.
 *  CLI is a thin wrapper over this. */
export type Analyze = (options: CliOptions) => Promise<Report>;
