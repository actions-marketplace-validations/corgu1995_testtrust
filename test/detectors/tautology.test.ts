// ============================================================================
// test/detectors/tautology.test.ts
//
// Unit spec for the "tautology" detector (src/detectors/tautology.ts).
//
// A tautological assertion compares a value to itself, so it can never fail —
// the classic `expect(true).toBe(true)` / `expect(x).toBe(x)` shape of test-
// gaming. This spec pins down EXACTLY which shapes the detector flags, at which
// severity, and — just as important for a precision-first CI gate — which
// shapes it must leave alone. (Ironic but apt: this is the tool that flags weak
// tests, so the spec for it had better be strong.)
//
// Acceptance criteria under test:
//   AC1: expect(true).toBe(true) and expect(false).toBe(false) => "warn".
//   AC2: expect(x).toBe(x) and expect(x).toEqual(x) (same identifier) => flagged.
//   AC3: expect(LIT).toBe(sameLIT) (identical literal) => flagged.
//   AC4: expect(a).toBe(b) with DIFFERENT identifiers => NOT flagged (length 0).
//   AC5: expect(f()).toBe(f()) => emitted at "info", NOT "warn".
//   Extra: non-equality matchers (toContain, …) are not flagged; negated /
//          .resolves / .rejects chains are not flagged; data.matcher is set.
//
// The detector is read-only and synchronous; we drive it with inline source via
// the shared makeContext helper — no disk, no git, fully deterministic.
// ============================================================================

import { describe, expect, it } from "vitest";
import { detector } from "../../src/detectors/tautology.js";
import { makeContext } from "../helpers/context.js";
import type { DetectorRunOptions, Finding, Severity } from "../../src/types.js";

// --- tiny local helpers -----------------------------------------------------

/** Run the detector over inline source with the given options (default none). */
function runOn(src: string, options: DetectorRunOptions = {}): Finding[] {
  return detector.run(makeContext(src), options);
}

/** Assert exactly one finding came back, and return it (narrowed, non-null). */
function onlyFinding(src: string, options: DetectorRunOptions = {}): Finding {
  const findings = runOn(src, options);
  expect(findings).toHaveLength(1);
  const finding = findings[0];
  // Belt-and-suspenders so the rest of a test never dereferences `undefined`.
  expect(finding).toBeDefined();
  return finding!;
}

const RULE_ID = "tautology" as const;
/** The virtual path makeContext stamps onto every finding's `file`. */
const VIRTUAL_FILE = "virtual/sample.test.ts";

describe("tautology detector", () => {
  // --- metadata: the frozen contract the engine keys off of ------------------
  describe("metadata", () => {
    it("exposes the frozen id, title, default severity and base requirement", () => {
      expect(detector.meta.id).toBe("tautology");
      expect(detector.meta.title).toBe("Tautological assertion");
      expect(detector.meta.defaultSeverity).toBe("warn");
      // This rule works on a single file snapshot; it must NOT require a base ref.
      expect(detector.meta.requiresBase).toBe(false);
    });
  });

  // --- AC1: boolean-literal self-equality => warn ----------------------------
  describe("AC1: expect(<bool>).toBe(<same bool>) is a warn-level tautology", () => {
    it("flags expect(true).toBe(true) at warn, with full finding shape", () => {
      const finding = onlyFinding(`expect(true).toBe(true);`);

      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
      // 1-based position of the OUTERMOST matcher call — starts at `expect`.
      expect(finding.line).toBe(1);
      expect(finding.column).toBe(1);
      expect(finding.file).toBe(VIRTUAL_FILE);
      // The "warn" (provable) branch uses the unconditional wording.
      expect(finding.message).toContain("can never fail");
      expect(finding.message).not.toContain("if that expression is pure");
    });

    it("flags expect(false).toBe(false) at warn", () => {
      const finding = onlyFinding(`expect(false).toBe(false);`);

      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });

    it("does NOT flag expect(true).toBe(false) — different booleans are a real check", () => {
      // Distinct boolean literals: a genuine (failing) assertion, not a tautology.
      expect(runOn(`expect(true).toBe(false);`)).toHaveLength(0);
    });
  });

  // --- AC2: identifier self-equality => flagged ------------------------------
  describe("AC2: expect(x).toBe(x) / expect(x).toEqual(x) (same identifier)", () => {
    it("flags toBe on the same identifier at warn", () => {
      const finding = onlyFinding(`expect(x).toBe(x);`);

      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });

    it("flags toEqual on the same identifier at warn, carrying that matcher name", () => {
      const finding = onlyFinding(`expect(value).toEqual(value);`);

      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      // The matcher must follow the chain, not be hard-coded to toBe.
      expect(finding.data).toEqual({ matcher: "toEqual" });
    });

    it("also flags toStrictEqual on the same identifier (the third equality matcher)", () => {
      const finding = onlyFinding(`expect(x).toStrictEqual(x);`);

      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toStrictEqual" });
    });

    it("treats whitespace-only differences as identical (normalized text)", () => {
      // `expect( x ).toBe(x)` is still self-comparison once whitespace collapses.
      const finding = onlyFinding(`expect( x ).toBe( x );`);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });
  });

  // --- AC3: identical-literal self-equality => flagged -----------------------
  describe("AC3: expect(LIT).toBe(sameLIT) (identical literal)", () => {
    it("flags identical string literals at warn", () => {
      const finding = onlyFinding(`expect("LIT").toBe("LIT");`);

      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });

    it("flags identical numeric literals at warn", () => {
      const finding = onlyFinding(`expect(42).toBe(42);`);

      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });

    it("flags identical null literals at warn (null is a primitive literal)", () => {
      const finding = onlyFinding(`expect(null).toBe(null);`);
      expect(finding.severity).toBe("warn");
    });

    it("flags self-equal `undefined` at warn (it is a plain identifier, AC2 path)", () => {
      // `undefined` is an Identifier, not a literal kind — but it is genuinely
      // reflexively self-equal, so the detector still flags it at warn.
      const finding = onlyFinding(`expect(undefined).toBe(undefined);`);
      expect(finding.severity).toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
    });
  });

  // --- AC4: DIFFERENT identifiers are a real assertion => NOT flagged ---------
  describe("AC4: expect(a).toBe(b) with different identifiers is NOT a tautology", () => {
    it("emits no findings for two distinct identifiers", () => {
      // A legitimate assertion; flagging it would be a precision-killing false positive.
      expect(runOn(`expect(a).toBe(b);`)).toHaveLength(0);
    });

    it("emits no findings for different literals either", () => {
      expect(runOn(`expect(1).toBe(2);`)).toHaveLength(0);
      expect(runOn(`expect("a").toBe("b");`)).toHaveLength(0);
    });

    it("emits no findings when only the matcher arg differs from the subject", () => {
      expect(runOn(`expect(result).toEqual(expected);`)).toHaveLength(0);
    });
  });

  // --- AC5: a CALL on either side downgrades confidence to "info" -------------
  describe("AC5: expect(f()).toBe(f()) is emitted at info, not warn", () => {
    it("flags identical calls on both sides at info (a pure fn could differ per call)", () => {
      const finding = onlyFinding(`expect(f()).toBe(f());`);

      expect(finding.ruleId).toBe(RULE_ID);
      // The whole point of AC5: same TEXT, but unprovable equality => info.
      expect(finding.severity).toBe("info");
      expect(finding.severity).not.toBe("warn");
      expect(finding.data).toEqual({ matcher: "toBe" });
      // The "info" branch uses the softer, conditional wording.
      expect(finding.message).toContain("if that expression is pure");
    });

    it("still downgrades to info when the calls are method calls (obj.fn())", () => {
      const finding = onlyFinding(`expect(obj.fn()).toEqual(obj.fn());`);

      expect(finding.severity).toBe("info");
      expect(finding.data).toEqual({ matcher: "toEqual" });
    });

    it("downgrades to info when only one side is a call but text still matches", () => {
      // `f(x)` on both sides: identical text, but a call lurks => info, never warn.
      const finding = onlyFinding(`expect(f(x)).toBe(f(x));`);
      expect(finding.severity).toBe("info");
    });
  });

  // --- Extra: scope guards (precision-first: leave ambiguous shapes alone) ----
  describe("non-equality matchers are out of scope", () => {
    it("does not flag a self-comparison via toContain", () => {
      expect(runOn(`expect(x).toContain(x);`)).toHaveLength(0);
    });

    it("does not flag a self-comparison via toMatchObject", () => {
      expect(runOn(`expect(x).toMatchObject(x);`)).toHaveLength(0);
    });

    it("does not flag a self-comparison via toHaveProperty", () => {
      expect(runOn(`expect(x).toHaveProperty(x);`)).toHaveLength(0);
    });
  });

  describe("negated and async chains are not always-true tautologies", () => {
    it("does not flag a negated chain (expect(x).not.toBe(x) actually FAILS)", () => {
      // Flagging this as 'never fails' would be exactly backwards.
      expect(runOn(`expect(x).not.toBe(x);`)).toHaveLength(0);
    });

    it("does not flag a .resolves chain (subject is a promise)", () => {
      expect(runOn(`await expect(p).resolves.toBe(p);`)).toHaveLength(0);
    });

    it("does not flag a .rejects chain", () => {
      expect(runOn(`await expect(p).rejects.toBe(p);`)).toHaveLength(0);
    });
  });

  describe("identical-text but non-primitive / non-identifier shapes are left alone", () => {
    it("does not flag identical object literals under toEqual (distinct objects)", () => {
      // Under toBe two distinct object literals are not ===; the detector
      // refuses to judge object/array literals at all (precision over recall).
      expect(runOn(`expect({ a: 1 }).toEqual({ a: 1 });`)).toHaveLength(0);
    });

    it("does not flag identical array literals under toBe", () => {
      expect(runOn(`expect([1, 2]).toBe([1, 2]);`)).toHaveLength(0);
    });

    it("does not flag identical member accesses (possible getters)", () => {
      expect(runOn(`expect(a.b).toBe(a.b);`)).toHaveLength(0);
    });
  });

  // --- data.matcher is always present and reflects the actual matcher --------
  describe("finding.data carries the matcher name", () => {
    it("sets data.matcher for every flagged tautology, matching the chain", () => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        [`expect(true).toBe(true);`, "toBe"],
        [`expect(x).toEqual(x);`, "toEqual"],
        [`expect(x).toStrictEqual(x);`, "toStrictEqual"],
        [`expect(f()).toBe(f());`, "toBe"],
      ];
      for (const [src, matcher] of cases) {
        const finding = onlyFinding(src);
        expect(finding.data).toBeDefined();
        expect(finding.data).toEqual({ matcher });
      }
    });
  });

  // --- severityOverride wins over the confidence-derived default --------------
  describe("severityOverride replaces the default severity", () => {
    it("stamps an otherwise-warn tautology as fail when overridden", () => {
      const finding = onlyFinding(`expect(true).toBe(true);`, { severityOverride: "fail" });
      expect(finding.severity).toBe("fail");
      // The matcher detail is unaffected by the override.
      expect(finding.data).toEqual({ matcher: "toBe" });
    });

    it("stamps an otherwise-info (call) tautology as fail when overridden", () => {
      const finding = onlyFinding(`expect(f()).toBe(f());`, { severityOverride: "fail" });
      expect(finding.severity).toBe("fail");
    });

    it("can also override down to info on a warn-level tautology", () => {
      const override: Severity = "info";
      const finding = onlyFinding(`expect(x).toBe(x);`, { severityOverride: override });
      expect(finding.severity).toBe("info");
    });
  });

  // --- testName / snippet enrichment when inside a real test block ------------
  describe("enrichment fields", () => {
    it("attaches the enclosing test name and a single-line snippet", () => {
      const src = `it("checks the thing", () => { expect(x).toBe(x); });`;
      const finding = onlyFinding(src);

      expect(finding.testName).toBe("checks the thing");
      expect(finding.snippet).toBe(`it("checks the thing", () => { expect(x).toBe(x); });`);
    });

    it("resolves the test name through the `test` alias too", () => {
      const src = `test("named via test()", () => { expect(y).toEqual(y); });`;
      const finding = onlyFinding(src);
      expect(finding.testName).toBe("named via test()");
    });

    it("omits testName when the assertion lives outside any test block", () => {
      const finding = onlyFinding(`expect(x).toBe(x);`);
      // The wire contract is OMIT (not set-to-undefined) for absent keys.
      expect(Object.prototype.hasOwnProperty.call(finding, "testName")).toBe(false);
    });
  });

  // --- multiple tautologies in one file are each reported once ---------------
  describe("multiple assertions", () => {
    it("reports each tautology exactly once, at its own line, with the right severity", () => {
      const src = [
        `expect(true).toBe(true);`, // line 1 — warn (literal)
        `expect(a).toBe(b);`, //        line 2 — real assertion, NOT flagged
        `expect(x).toEqual(x);`, //     line 3 — warn (identifier)
        `expect(f()).toBe(f());`, //    line 4 — info (call)
      ].join("\n");

      const findings = runOn(src);

      // Two warns (lines 1 and 3) + one info (line 4); the AC4 line is skipped.
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.line)).toEqual([1, 3, 4]);
      expect(findings.map((f) => f.severity)).toEqual(["warn", "warn", "info"]);
      expect(findings.every((f) => f.ruleId === RULE_ID)).toBe(true);
    });
  });

  // --- robustness: never throws on malformed / empty / assertion-less input ---
  describe("robustness", () => {
    it("returns no findings for an empty file", () => {
      expect(runOn(``)).toHaveLength(0);
    });

    it("returns no findings for a file with no assertions", () => {
      expect(runOn(`const x = 1; function f() { return x; }`)).toHaveLength(0);
    });

    it("does not flag a bare expect(x) with no matcher", () => {
      expect(runOn(`expect(x);`)).toHaveLength(0);
    });

    it("does not flag expect() with no subject argument", () => {
      // No subject arg means no self-comparison to make; emit nothing.
      expect(runOn(`expect().toBe(x);`)).toHaveLength(0);
    });
  });
});
