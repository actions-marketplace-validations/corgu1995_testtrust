// ============================================================================
// test/scorer.test.ts
// Spec for the PURE scorer (src/core/scorer.ts).
//
// The scorer turns a flat list of Findings into a numeric quality score
// (0-100), a gate Verdict, severity counts, and a per-rule breakdown. Its
// CONTRACT is full determinism: no IO, no randomness, no input mutation. These
// tests pin the documented arithmetic and the FROZEN verdict precedence so the
// CI gate stays reproducible.
//
// We build Finding objects inline with only the fields the scorer reads
// (ruleId / severity drive math; file / line / message satisfy the interface).
// ============================================================================
import { describe, it, expect } from "vitest";
import {
  score,
  computeVerdict,
  countBySeverity,
  buildBreakdown,
  clamp,
  PENALTY_WEIGHTS,
  SEVERITY_MULTIPLIER,
} from "../src/core/scorer.js";
import type { Finding, RuleId, Severity, ScoreInput } from "../src/types.js";

// ----------------------------------------------------------------------------
// Helpers — keep Finding construction terse and intention-revealing.
// ----------------------------------------------------------------------------

let lineCounter = 0;

/**
 * Build a minimal valid Finding. Only ruleId + severity affect scoring; the
 * rest are required by the interface. `line` auto-increments so two findings
 * are never accidentally "identical" in a way that hides an ordering bug.
 */
function makeFinding(ruleId: RuleId, severity: Severity, overrides: Partial<Finding> = {}): Finding {
  lineCounter += 1;
  return {
    ruleId,
    severity,
    file: "virtual/sample.test.ts",
    line: lineCounter,
    message: `${ruleId} (${severity})`,
    ...overrides,
  };
}

/** Wrap findings into a ScoreInput. failThreshold defaults to a typical gate. */
function makeInput(findings: Finding[], failThreshold = 60): ScoreInput {
  return { findings, filesAnalyzed: 1, failThreshold };
}

// ============================================================================
// score(): empty input
// ============================================================================
describe("score() — empty findings", () => {
  it("returns a perfect 100 and a passing verdict", () => {
    const result = score(makeInput([]));
    expect(result.score).toBe(100);
    expect(result.verdict).toBe("pass");
  });

  it("reports zero total findings", () => {
    const result = score(makeInput([]));
    expect(result.totalFindings).toBe(0);
  });

  it("has an all-zero countsBySeverity with every severity key present", () => {
    const result = score(makeInput([]));
    expect(result.countsBySeverity).toEqual({ fail: 0, warn: 0, info: 0 });
  });

  it("produces an empty breakdown (no rules fired)", () => {
    const result = score(makeInput([]));
    expect(result.breakdown).toEqual([]);
  });

  it("echoes back the supplied failThreshold", () => {
    const result = score(makeInput([], 75));
    expect(result.failThreshold).toBe(75);
  });
});

// ============================================================================
// score(): single-finding arithmetic (documented in the ACs)
// ============================================================================
describe("score() — single finding penalties", () => {
  it("a single tautology warn => score 90, verdict neutral", () => {
    // tautology base weight = 10; warn multiplier = 1 => penalty 10 => 100-10.
    const result = score(makeInput([makeFinding("tautology", "warn")]));
    expect(result.score).toBe(90);
    expect(result.verdict).toBe("neutral");
    expect(result.countsBySeverity).toEqual({ fail: 0, warn: 1, info: 0 });
  });

  it("an info trivial-assertion contributes 4 * 0.5 = 2 => score 98", () => {
    // trivial-assertion base = 4; info multiplier = 0.5 => penalty 2.
    const result = score(makeInput([makeFinding("trivial-assertion", "info")]));
    expect(result.score).toBe(98);
    // info alone is purely advisory: no fail, no warn => verdict pass.
    expect(result.verdict).toBe("pass");
    expect(result.countsBySeverity).toEqual({ fail: 0, warn: 0, info: 1 });
  });
});

// ============================================================================
// score(): verdict precedence — "fail" severity dominates
// ============================================================================
describe("score() — a 'fail' severity forces verdict 'fail' regardless of score", () => {
  it("verdict is 'fail' even when the numeric score stays high", () => {
    // over-mocking-sut base = 12 => score 88 (well above the 60 threshold),
    // yet a single fail-severity finding must pin the verdict to "fail".
    const result = score(makeInput([makeFinding("over-mocking-sut", "fail")]));
    expect(result.score).toBe(88);
    expect(result.verdict).toBe("fail");
  });

  it("'fail' wins even if it would otherwise be 'neutral' due to warns", () => {
    const findings = [
      makeFinding("tautology", "warn"),
      makeFinding("assertion-free", "fail"),
    ];
    const result = score(makeInput(findings));
    expect(result.verdict).toBe("fail");
    expect(result.countsBySeverity).toEqual({ fail: 1, warn: 1, info: 0 });
  });
});

// ============================================================================
// score(): threshold boundary — strictly-below fails, equality passes
// ============================================================================
describe("score() — failThreshold boundary is strict (< fails, === does NOT)", () => {
  it("score strictly below the threshold => 'fail'", () => {
    // Two assertion-weakened warns: 16 + 16 = 32 penalty => score 68.
    // Threshold 69 => 68 < 69 => fail. No fail-severity finding involved.
    const findings = [
      makeFinding("assertion-weakened", "warn"),
      makeFinding("assertion-weakened", "warn"),
    ];
    const result = score(makeInput(findings, 69));
    expect(result.score).toBe(68);
    expect(result.verdict).toBe("fail");
    // Confirms it's the threshold (not a fail-severity finding) doing the work.
    expect(result.countsBySeverity.fail).toBe(0);
  });

  it("score EXACTLY equal to the threshold => NOT fail (warns => neutral)", () => {
    // Same 32-point penalty => score 68; threshold exactly 68 => not below.
    const findings = [
      makeFinding("assertion-weakened", "warn"),
      makeFinding("assertion-weakened", "warn"),
    ];
    const result = score(makeInput(findings, 68));
    expect(result.score).toBe(68);
    expect(result.verdict).toBe("neutral"); // warns present, but score >= threshold.
  });

  it("score exactly equal to the threshold with NO warns => pass", () => {
    // One trivial-assertion info => penalty 2 => score 98; threshold exactly 98.
    const result = score(makeInput([makeFinding("trivial-assertion", "info")], 98));
    expect(result.score).toBe(98);
    expect(result.verdict).toBe("pass");
  });
});

// ============================================================================
// score(): per-rule breakdown
// ============================================================================
describe("score() — breakdown", () => {
  it("emits one entry per ruleId with correct count and summed penalty", () => {
    const findings = [
      makeFinding("tautology", "warn"), // 10
      makeFinding("tautology", "warn"), // 10 -> tautology total 20, count 2
      makeFinding("trivial-assertion", "info"), // 4 * 0.5 = 2, count 1
    ];
    const result = score(makeInput(findings));

    expect(result.breakdown).toEqual([
      { ruleId: "tautology", count: 2, penalty: 20 },
      { ruleId: "trivial-assertion", count: 1, penalty: 2 },
    ]);
  });

  it("omits rules that produced no findings", () => {
    const result = score(makeInput([makeFinding("snapshot-only", "warn")]));
    const ruleIds = result.breakdown.map((entry) => entry.ruleId);
    expect(ruleIds).toEqual(["snapshot-only"]);
    expect(result.breakdown).toHaveLength(1);
  });

  it("breakdown penalties sum to the points deducted from 100", () => {
    const findings = [
      makeFinding("over-mocking-sut", "fail"), // 12
      makeFinding("test-skipped", "warn"), // 10
      makeFinding("trivial-assertion", "info"), // 2
    ];
    const result = score(makeInput(findings));
    const totalPenalty = result.breakdown.reduce((sum, entry) => sum + entry.penalty, 0);
    expect(totalPenalty).toBe(24);
    expect(result.score).toBe(100 - 24); // 76
  });
});

// ============================================================================
// score(): countsBySeverity always carries all three keys
// ============================================================================
describe("score() — countsBySeverity", () => {
  it("includes fail/warn/info keys even when some severities are absent", () => {
    const result = score(makeInput([makeFinding("tautology", "warn")]));
    expect(Object.keys(result.countsBySeverity).sort()).toEqual(["fail", "info", "warn"]);
  });

  it("tallies a mixed batch correctly", () => {
    const findings = [
      makeFinding("assertion-free", "fail"),
      makeFinding("tautology", "warn"),
      makeFinding("snapshot-only", "warn"),
      makeFinding("trivial-assertion", "info"),
      makeFinding("trivial-assertion", "info"),
    ];
    const result = score(makeInput(findings));
    expect(result.countsBySeverity).toEqual({ fail: 1, warn: 2, info: 2 });
    expect(result.totalFindings).toBe(5);
  });
});

// ============================================================================
// score(): clamping into [0, 100]
// ============================================================================
describe("score() — clamps into [0, 100]", () => {
  it("never drops below 0 even under a heavy pile of findings", () => {
    // 10 assertion-deleted findings @ 16 each = 160 penalty => clamp to 0.
    const findings: Finding[] = Array.from({ length: 10 }, () =>
      makeFinding("assertion-deleted", "warn"),
    );
    const result = score(makeInput(findings));
    expect(result.score).toBe(0);
    expect(result.verdict).toBe("fail"); // 0 < 60
  });
});

// ============================================================================
// score(): determinism — same input => same output
// ============================================================================
describe("score() — determinism", () => {
  it("returns deeply-equal results for two independent calls on equal input", () => {
    const build = (): ScoreInput =>
      makeInput([
        makeFinding("over-mocking-sut", "fail"),
        makeFinding("tautology", "warn"),
        makeFinding("trivial-assertion", "info"),
      ]);

    const first = score(build());
    const second = score(build());
    expect(second).toEqual(first);
  });

  it("does not mutate the input findings array", () => {
    const findings = [makeFinding("tautology", "warn")];
    const snapshot = structuredClone(findings);
    score(makeInput(findings));
    expect(findings).toEqual(snapshot);
  });
});

// ============================================================================
// Exported helpers — the scorer publishes these for reporters/tests to reuse.
// ============================================================================
describe("computeVerdict()", () => {
  it("priority 1: any fail-severity finding => 'fail' (even at score 100)", () => {
    const findings = [makeFinding("assertion-free", "fail")];
    expect(computeVerdict(findings, 100, 60)).toBe("fail");
  });

  it("priority 2: score strictly below threshold => 'fail'", () => {
    expect(computeVerdict([], 59, 60)).toBe("fail");
  });

  it("priority 2 boundary: score === threshold => not 'fail'", () => {
    expect(computeVerdict([], 60, 60)).toBe("pass");
  });

  it("priority 3: a warn (score ok, no fail) => 'neutral'", () => {
    const findings = [makeFinding("tautology", "warn")];
    expect(computeVerdict(findings, 90, 60)).toBe("neutral");
  });

  it("priority 4: no fail, no warn, score ok => 'pass'", () => {
    const findings = [makeFinding("trivial-assertion", "info")];
    expect(computeVerdict(findings, 98, 60)).toBe("pass");
  });

  it("fail-severity outranks the threshold check too", () => {
    // Score above threshold, but a fail finding still forces "fail".
    const findings = [makeFinding("over-mocking-sut", "fail")];
    expect(computeVerdict(findings, 88, 60)).toBe("fail");
  });
});

describe("countBySeverity()", () => {
  it("returns all-zero with every key for an empty list", () => {
    expect(countBySeverity([])).toEqual({ fail: 0, warn: 0, info: 0 });
  });

  it("counts each severity independently", () => {
    const findings = [
      makeFinding("assertion-free", "fail"),
      makeFinding("assertion-free", "fail"),
      makeFinding("tautology", "warn"),
      makeFinding("trivial-assertion", "info"),
    ];
    expect(countBySeverity(findings)).toEqual({ fail: 2, warn: 1, info: 1 });
  });
});

describe("buildBreakdown()", () => {
  it("returns [] for no findings", () => {
    expect(buildBreakdown([])).toEqual([]);
  });

  it("preserves first-appearance order of ruleIds (determinism guarantee)", () => {
    const findings = [
      makeFinding("trivial-assertion", "info"),
      makeFinding("tautology", "warn"),
      makeFinding("trivial-assertion", "info"),
      makeFinding("snapshot-only", "warn"),
    ];
    const order = buildBreakdown(findings).map((entry) => entry.ruleId);
    // trivial-assertion appears first, then tautology, then snapshot-only.
    expect(order).toEqual(["trivial-assertion", "tautology", "snapshot-only"]);
  });

  it("accumulates count and severity-scaled penalty per rule", () => {
    const findings = [
      makeFinding("trivial-assertion", "info"), // 2
      makeFinding("trivial-assertion", "warn"), // 4 -> total 6, count 2
    ];
    expect(buildBreakdown(findings)).toEqual([
      { ruleId: "trivial-assertion", count: 2, penalty: 6 },
    ]);
  });
});

describe("clamp()", () => {
  it("returns the value when within range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it("floors to the minimum", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it("caps at the maximum", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("treats both bounds as inclusive", () => {
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });
});

// ============================================================================
// Frozen weight/multiplier tables — pinned so a silent re-weighting is caught.
// ============================================================================
describe("PENALTY_WEIGHTS / SEVERITY_MULTIPLIER (frozen constants)", () => {
  it("pins the documented base weights for the key rules", () => {
    expect(PENALTY_WEIGHTS.tautology).toBe(10);
    expect(PENALTY_WEIGHTS["trivial-assertion"]).toBe(4);
    expect(PENALTY_WEIGHTS["over-mocking-sut"]).toBe(12);
    expect(PENALTY_WEIGHTS["assertion-weakened"]).toBe(16);
    expect(PENALTY_WEIGHTS["assertion-deleted"]).toBe(16);
  });

  it("pins severity multipliers: fail/warn full, info half", () => {
    expect(SEVERITY_MULTIPLIER.fail).toBe(1);
    expect(SEVERITY_MULTIPLIER.warn).toBe(1);
    expect(SEVERITY_MULTIPLIER.info).toBe(0.5);
  });

  it("exposes the tables as frozen (read-only) objects", () => {
    expect(Object.isFrozen(PENALTY_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(SEVERITY_MULTIPLIER)).toBe(true);
  });
});
