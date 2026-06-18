// ============================================================================
// src/core/scorer.ts
// The PURE scorer. Turns a flat list of Findings into a numeric quality score
// (0-100), a gate Verdict, and per-rule/per-severity breakdowns.
//
// CONTRACT: fully deterministic. No IO, no Date, no AST, no filesystem, no
// randomness, no mutation of inputs. Given the same ScoreInput it ALWAYS
// returns the same ScoreResult. This is what makes the gate reproducible in CI
// and trivially unit-testable.
// ============================================================================
import type {
  Finding,
  RuleId,
  ScoreInput,
  ScoreResult,
  Severity,
  Verdict,
  RuleScoreBreakdown,
} from "../types.js";

// ----------------------------------------------------------------------------
// Penalty weights
// ----------------------------------------------------------------------------

/**
 * Per-rule penalty weights, expressed as points subtracted from a perfect 100.
 *
 * The "wedge" rules (assertion-weakened / -deleted) are the highest-signal,
 * lowest-false-positive smells — they require a base ref and describe a test
 * that USED to assert something and now asserts less (or nothing). They get the
 * heaviest weights so a single regression visibly dents the score. The cheap,
 * noisier static smells (trivial-assertion, snapshot-only) are weighted light
 * so they nudge rather than dominate.
 *
 * These are the BASE weights (applied to a fail/warn finding). They may be
 * scaled down by severity — see `severityMultiplier`.
 *
 * NOTE: this map is exported intentionally so reporters/tests can display or
 * assert on the exact weighting without re-deriving it. Treat it as read-only.
 */
export const PENALTY_WEIGHTS: Readonly<Record<RuleId, number>> = Object.freeze({
  // --- regression / "the wedge" (require a base ref): heaviest ---
  "assertion-weakened": 16,
  "assertion-deleted": 16,
  // --- high-signal static / behavioral smells ---
  "over-mocking-sut": 12,
  "test-skipped": 10,
  "tautology": 10,
  "assertion-free": 10,
  // --- lighter, noisier smells ---
  "snapshot-only": 6,
  "trivial-assertion": 4,
});

// ----------------------------------------------------------------------------
// Severity scaling
// ----------------------------------------------------------------------------

/**
 * Optional severity scaling of a finding's penalty.
 *
 * Rationale, kept deliberately simple:
 *  - "fail" -> full weight (1x): the detector is certain this is a real problem.
 *  - "warn" -> full weight (1x): our detectors are conservative and emit "warn"
 *              for genuine smells (see Severity docs in types.ts), so a warn is
 *              still worth its full base weight.
 *  - "info" -> half weight (0.5x): purely advisory; should only lightly move the
 *              score.
 *
 * We multiply, then round the FINAL summed score once (not per finding), so the
 * 0.5x on "info" never introduces fractional noise into the public number.
 */
export const SEVERITY_MULTIPLIER: Readonly<Record<Severity, number>> = Object.freeze({
  fail: 1,
  warn: 1,
  info: 0.5,
});

/** Effective (severity-scaled) penalty contributed by a single finding. */
function penaltyForFinding(finding: Finding): number {
  const base = PENALTY_WEIGHTS[finding.ruleId];
  const multiplier = SEVERITY_MULTIPLIER[finding.severity];
  return base * multiplier;
}

// ----------------------------------------------------------------------------
// Small numeric helper
// ----------------------------------------------------------------------------

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ----------------------------------------------------------------------------
// Verdict
// ----------------------------------------------------------------------------

/**
 * Compute the gate Verdict per the FROZEN convention in types.ts, in this exact
 * priority order:
 *   1. any Finding of severity "fail"      -> "fail"
 *   2. else score < failThreshold          -> "fail"   (strict: === is NOT fail)
 *   3. else any Finding of severity "warn" -> "neutral"
 *   4. else                                -> "pass"
 *
 * Exported so reporters/tests can reuse the identical decision logic instead of
 * re-implementing (and risking drift from) the convention.
 */
export function computeVerdict(
  findings: readonly Finding[],
  score: number,
  failThreshold: number,
): Verdict {
  let hasFail = false;
  let hasWarn = false;
  for (const finding of findings) {
    if (finding.severity === "fail") {
      hasFail = true;
      break; // "fail" dominates everything; no need to keep scanning.
    }
    if (finding.severity === "warn") hasWarn = true;
  }

  if (hasFail) return "fail";
  if (score < failThreshold) return "fail"; // strictly below; equality passes.
  if (hasWarn) return "neutral";
  return "pass";
}

// ----------------------------------------------------------------------------
// Severity counts
// ----------------------------------------------------------------------------

/**
 * Tally findings by severity. ALL three keys ("fail" | "warn" | "info") are
 * always present and default to 0, so downstream consumers can index without
 * undefined-guards.
 */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

// ----------------------------------------------------------------------------
// Per-rule breakdown
// ----------------------------------------------------------------------------

/**
 * Build one RuleScoreBreakdown per ruleId that actually appears in `findings`
 * (rules with zero findings are omitted). Each entry carries the occurrence
 * count and the summed, severity-scaled penalty for that rule.
 *
 * Iteration order of the output follows first-appearance order of each ruleId
 * in `findings`, which keeps the result deterministic for a given input.
 */
export function buildBreakdown(findings: readonly Finding[]): RuleScoreBreakdown[] {
  // Map preserves insertion (first-appearance) order, giving us determinism.
  const byRule = new Map<RuleId, RuleScoreBreakdown>();

  for (const finding of findings) {
    const existing = byRule.get(finding.ruleId);
    const penalty = penaltyForFinding(finding);
    if (existing) {
      existing.count += 1;
      existing.penalty += penalty;
    } else {
      byRule.set(finding.ruleId, {
        ruleId: finding.ruleId,
        count: 1,
        penalty,
      });
    }
  }

  return [...byRule.values()];
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Score a set of findings.
 *
 * Algorithm:
 *  1. Sum each finding's severity-scaled penalty.
 *  2. score = clamp(round(100 - totalPenalty), 0, 100).
 *  3. Derive verdict, severity counts, and per-rule breakdown.
 *
 * Returns a ScoreResult that satisfies the frozen interface exactly (no extra
 * or missing fields; safe under exactOptionalPropertyTypes since ScoreResult
 * has no optional members).
 */
export function score(input: ScoreInput): ScoreResult {
  const { findings, failThreshold } = input;

  // 1. Accumulate penalties across every finding.
  let totalPenalty = 0;
  for (const finding of findings) {
    totalPenalty += penaltyForFinding(finding);
  }

  // 2. Round ONCE on the final number so info's 0.5x can't leak fractions into
  //    the public score, then clamp into [0, 100].
  const computedScore = clamp(Math.round(100 - totalPenalty), 0, 100);

  // 3. Verdict uses the clamped, rounded score (matches what reports display).
  const verdict = computeVerdict(findings, computedScore, failThreshold);

  return {
    score: computedScore,
    verdict,
    failThreshold,
    totalFindings: findings.length,
    countsBySeverity: countBySeverity(findings),
    breakdown: buildBreakdown(findings),
  };
}
