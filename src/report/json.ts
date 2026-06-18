// ============================================================================
// src/report/json.ts
// The JSON reporter. Serializes a Report into the canonical, machine-readable
// JSON artifact that CI stores and downstream tooling parses.
//
// CONTRACT: pure and deterministic. Given the same Report it ALWAYS returns the
// byte-identical string — no Date, no IO, no randomness, no input mutation. This
// is what lets the JSON output be committed/diffed as a stable CI artifact.
//
// We do NOT trust the key order of the incoming objects. JSON.stringify emits
// keys in their own-enumeration order, so two Reports that are deeply equal but
// were assembled with different field orders would otherwise serialize to
// different bytes. To guarantee stability we rebuild every level as a fresh
// plain object with an EXPLICIT, fixed key order and stringify that.
//
// Key omission: optional Finding fields that are `undefined` are dropped
// entirely rather than emitted as `null`, so consumers can use plain
// `"column" in finding` / `?.` checks. (JSON.stringify already drops `undefined`
// object members, but we also avoid inserting the key at all so intent is
// explicit and it is never accidentally turned into `null`.)
// ============================================================================
import type {
  Finding,
  Report,
  RuleScoreBreakdown,
  ScoreResult,
  Severity,
} from "../types.js";

/** Indentation passed to JSON.stringify: two spaces, per the artifact format. */
const JSON_INDENT = 2;

/**
 * The severity keys of {@link ScoreResult.countsBySeverity}, in a fixed order.
 *
 * `countsBySeverity` is a `Record<Severity, number>` whose three keys are always
 * present (the scorer defaults each to 0). We emit them in this deterministic
 * order rather than trusting the construction order of the source object.
 */
const SEVERITY_ORDER: readonly Severity[] = ["fail", "warn", "info"];

/**
 * Render a {@link Report} as a stable, pretty-printed (2-space) JSON string.
 *
 * Guarantees:
 *  - Deterministic: equal Reports (regardless of how their objects were built)
 *    produce byte-identical output.
 *  - Fixed top-level key order: version, generatedAt, mode, baseRef, score,
 *    findings.
 *  - `score` and each `finding` likewise use a fixed internal key order (see the
 *    ordering helpers below).
 *  - `undefined` optional finding fields are omitted, never rendered as `null`.
 *
 * Pure: does not read IO, the clock, or randomness, and never mutates `report`.
 */
export function renderJson(report: Report): string {
  // Rebuild the whole tree with explicit key order so serialization is stable
  // and independent of how the caller assembled the object.
  const ordered = {
    version: report.version,
    generatedAt: report.generatedAt,
    mode: report.mode,
    baseRef: report.baseRef,
    score: orderScore(report.score),
    findings: report.findings.map(orderFinding),
  };

  return JSON.stringify(ordered, null, JSON_INDENT);
}

/**
 * Rebuild a {@link ScoreResult} with the frozen key order:
 * score, verdict, failThreshold, totalFindings, countsBySeverity, breakdown.
 *
 * `countsBySeverity` and each `breakdown` entry are themselves re-ordered so no
 * level of the output depends on the source object's enumeration order.
 */
function orderScore(score: ScoreResult): Record<string, unknown> {
  return {
    score: score.score,
    verdict: score.verdict,
    failThreshold: score.failThreshold,
    totalFindings: score.totalFindings,
    countsBySeverity: orderCounts(score.countsBySeverity),
    breakdown: score.breakdown.map(orderBreakdown),
  };
}

/**
 * Rebuild the severity-count map in the fixed {@link SEVERITY_ORDER}
 * (fail, warn, info). All three keys are always present on the input, so this is
 * a straight, deterministic copy into a known order.
 */
function orderCounts(counts: Record<Severity, number>): Record<string, number> {
  const ordered: Record<string, number> = {};
  for (const severity of SEVERITY_ORDER) {
    ordered[severity] = counts[severity];
  }
  return ordered;
}

/**
 * Rebuild a single {@link RuleScoreBreakdown} with a fixed key order:
 * ruleId, count, penalty.
 */
function orderBreakdown(entry: RuleScoreBreakdown): Record<string, unknown> {
  return {
    ruleId: entry.ruleId,
    count: entry.count,
    penalty: entry.penalty,
  };
}

/**
 * Rebuild a single {@link Finding} with the frozen key order:
 * ruleId, severity, file, line, column, message, snippet, endLine, testName,
 * data.
 *
 * Optional fields (`column`, `snippet`, `endLine`, `testName`, `data`) are
 * appended ONLY when present (not `undefined`), so the key is absent from the
 * output rather than serialized as `null`. The three required fields besides
 * ruleId/severity/file (`line`, `message`) are always emitted.
 *
 * `data` is passed through as-is: it is opaque `Record<string, unknown>` whose
 * internal shape/order is owned by the emitting rule, and JSON.stringify will
 * naturally drop any nested `undefined` members.
 */
function orderFinding(finding: Finding): Record<string, unknown> {
  // Required keys first, in contract order.
  const ordered: Record<string, unknown> = {
    ruleId: finding.ruleId,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
  };

  // Optional `column` slots between `line` and `message` per the contract.
  if (finding.column !== undefined) ordered.column = finding.column;

  ordered.message = finding.message;

  // Remaining optionals, in contract order.
  if (finding.snippet !== undefined) ordered.snippet = finding.snippet;
  if (finding.endLine !== undefined) ordered.endLine = finding.endLine;
  if (finding.testName !== undefined) ordered.testName = finding.testName;
  if (finding.data !== undefined) ordered.data = finding.data;

  return ordered;
}
