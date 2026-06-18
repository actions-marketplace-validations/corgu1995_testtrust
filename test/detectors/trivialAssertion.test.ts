// ============================================================================
// test/detectors/trivialAssertion.test.ts
//
// Unit spec for the "trivial-assertion" detector (src/detectors/trivialAssertion.ts).
//
// Acceptance criteria under test:
//   AC1: a leaf test whose ONLY assertion is a single weak matcher
//        (toBeDefined / toBeTruthy / toBeUndefined, or `expect(fn).not.toThrow()`)
//        => one "trivial-assertion" finding at severity "info".
//   AC2: a leaf test that ALSO carries a concrete assertion
//        (toEqual / toHaveBeenCalledWith / toBe(literal)) => NOT flagged.
//   AC3: severity defaults to "info"; passing { severityOverride: "fail" }
//        stamps the finding "fail".
//   AC4: finding.data carries the matched matcher name(s).
//   Extra: an assertion-FREE test is not this rule's concern (length 0 here).
//
// The detector is read-only and synchronous; we drive it with inline source via
// the shared makeContext helper. All assertions are concrete (no toBeDefined-
// style weak checks here — fitting for a tool that flags exactly those).
// ============================================================================

import { describe, expect, it } from "vitest";
import { detector } from "../../src/detectors/trivialAssertion.js";
import { makeContext } from "../helpers/context.js";

// --- tiny local helpers -----------------------------------------------------

/** Run the detector over inline source with the given options. */
function runOn(src: string, options: Parameters<typeof detector.run>[1] = {}) {
  return detector.run(makeContext(src), options);
}

/** All findings emitted by THIS detector for a given trivial-only body. */
const RULE_ID = "trivial-assertion" as const;

describe("trivial-assertion detector", () => {
  describe("metadata", () => {
    it("exposes the frozen id, default severity and base requirement", () => {
      expect(detector.meta.id).toBe("trivial-assertion");
      expect(detector.meta.defaultSeverity).toBe("info");
      expect(detector.meta.requiresBase).toBe(false);
    });
  });

  // --- AC1: a single weak matcher is the whole test --------------------------
  describe("AC1: flags a test whose only assertion is a single weak matcher", () => {
    it("flags a lone toBeDefined() at info", () => {
      const src = `
        import { expect, it } from "vitest";
        it("returns something", () => {
          const result = compute();
          expect(result).toBeDefined();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("info");
      // Reports against the offending matcher's line (the expect line, 5th here).
      expect(finding.line).toBe(5);
      expect(finding.testName).toBe("returns something");
      expect(finding.message).toContain("toBeDefined()");
      expect(finding.data).toEqual({ matchers: ["toBeDefined"] });
    });

    it("flags a lone toBeTruthy()", () => {
      const src = `
        import { expect, test } from "vitest";
        test("is truthy", () => {
          expect(getFlag()).toBeTruthy();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(RULE_ID);
      expect(findings[0]!.data).toEqual({ matchers: ["toBeTruthy"] });
    });

    it("flags a lone toBeUndefined()", () => {
      const src = `
        import { expect, it } from "vitest";
        it("has no value", () => {
          expect(maybe()).toBeUndefined();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.data).toEqual({ matchers: ["toBeUndefined"] });
    });

    it("flags a negated throw: expect(fn).not.toThrow()", () => {
      const src = `
        import { expect, it } from "vitest";
        it("does not blow up", () => {
          expect(() => run()).not.toThrow();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("info");
      // AC4: a negated throw is surfaced as `not.toThrow` so the author sees the
      // exact offending shape.
      expect(finding.data).toEqual({ matchers: ["not.toThrow"] });
      expect(finding.message).toContain("not.toThrow()");
    });

    it("flags a body whose multiple assertions are ALL weak, with deduped matcher names in order", () => {
      const src = `
        import { expect, it } from "vitest";
        it("all weak", () => {
          expect(a()).toBeTruthy();
          expect(b()).toBeDefined();
          expect(c()).toBeTruthy();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      // AC4: first-seen order, de-duplicated (toBeTruthy appears once).
      expect(findings[0]!.data).toEqual({ matchers: ["toBeTruthy", "toBeDefined"] });
      // Message names both weak matchers it relies on.
      expect(findings[0]!.message).toContain("toBeTruthy()");
      expect(findings[0]!.message).toContain("toBeDefined()");
    });

    it("treats negated existence (not.toBeDefined) as still trivial", () => {
      // `not.toBeDefined()` is just `toBeUndefined` in disguise — existence-level,
      // so the matcher name remains toBeDefined and the test is still flagged.
      const src = `
        import { expect, it } from "vitest";
        it("negated existence", () => {
          expect(x()).not.toBeDefined();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.data).toEqual({ matchers: ["toBeDefined"] });
    });
  });

  // --- AC2: a concrete assertion clears the test -----------------------------
  describe("AC2: does NOT flag when a concrete assertion is also present", () => {
    it("clears a body that has toEqual alongside a weak matcher", () => {
      const src = `
        import { expect, it } from "vitest";
        it("checks shape", () => {
          const r = compute();
          expect(r).toBeDefined();
          expect(r).toEqual({ ok: true });
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("clears a body that has toHaveBeenCalledWith alongside not.toThrow", () => {
      const src = `
        import { expect, it, vi } from "vitest";
        it("calls the dep", () => {
          const spy = vi.fn();
          expect(() => use(spy)).not.toThrow();
          expect(spy).toHaveBeenCalledWith("payload");
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("clears a body whose concrete assertion is toBe with a literal", () => {
      const src = `
        import { expect, it } from "vitest";
        it("pins a value", () => {
          expect(thing()).toBeTruthy();
          expect(sum(2, 3)).toBe(5);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("clears a body whose only assertion is concrete (no weak matcher at all)", () => {
      const src = `
        import { expect, it } from "vitest";
        it("fully concrete", () => {
          expect(sum(2, 3)).toBe(5);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("clears a positive toThrow() — a positive throw carries signal and is not trivial", () => {
      const src = `
        import { expect, it } from "vitest";
        it("throws on bad input", () => {
          expect(() => parse("")).toThrow();
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("clears a node:assert call (always treated as a concrete check)", () => {
      const src = `
        import assert from "node:assert";
        import { it } from "vitest";
        it("asserts equality", () => {
          assert.equal(add(1, 1), 2);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });
  });

  // --- AC3: severity default + override --------------------------------------
  describe("AC3: severity defaults to info and honours severityOverride", () => {
    const trivialSrc = `
      import { expect, it } from "vitest";
      it("only defined", () => {
        expect(value()).toBeDefined();
      });
    `;

    it("defaults to info when no override is given", () => {
      const findings = runOn(trivialSrc);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("info");
    });

    it("stamps findings 'fail' when severityOverride is 'fail'", () => {
      const findings = runOn(trivialSrc, { severityOverride: "fail" });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("fail");
      // Override changes ONLY the severity — the rest of the finding is intact.
      expect(findings[0]!.ruleId).toBe(RULE_ID);
      expect(findings[0]!.data).toEqual({ matchers: ["toBeDefined"] });
    });

    it("honours a 'warn' override too", () => {
      const findings = runOn(trivialSrc, { severityOverride: "warn" });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("warn");
    });
  });

  // --- Extra: assertion-free tests are out of scope --------------------------
  describe("assertion-free tests are not this rule's concern", () => {
    it("emits nothing for a test body with no assertions at all", () => {
      const src = `
        import { it } from "vitest";
        it("does setup but asserts nothing", () => {
          const x = build();
          doSomething(x);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("emits nothing for an empty test body", () => {
      const src = `
        import { it } from "vitest";
        it("empty", () => {});
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("emits nothing for a bare expect(x) with no matcher applied", () => {
      // `expect(x)` without a terminal matcher is not a real assertion, so the
      // body counts as assertion-free => out of scope for this rule.
      const src = `
        import { expect, it } from "vitest";
        it("no matcher", () => {
          expect(value());
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });
  });

  // --- structural / multi-block behaviour ------------------------------------
  describe("structure", () => {
    it("does not flag a describe suite itself, only its leaf cases", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe("group", () => {
          it("weak leaf", () => {
            expect(v()).toBeDefined();
          });
        });
      `;
      const findings = runOn(src);
      // Exactly one finding, and it belongs to the leaf it(), not the describe.
      expect(findings).toHaveLength(1);
      expect(findings[0]!.testName).toBe("weak leaf");
    });

    it("flags each trivial leaf independently across multiple tests", () => {
      const src = `
        import { expect, it } from "vitest";
        it("weak one", () => {
          expect(a()).toBeTruthy();
        });
        it("solid one", () => {
          expect(b()).toBe(42);
        });
        it("weak two", () => {
          expect(c()).not.toThrow();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(2);
      const names = findings.map((f) => f.testName);
      expect(names).toEqual(["weak one", "weak two"]);
      const matcherData = findings.map((f) => f.data);
      expect(matcherData).toEqual([{ matchers: ["toBeTruthy"] }, { matchers: ["not.toThrow"] }]);
    });

    it("returns a stable empty array for a file with no test blocks", () => {
      const src = `
        export function compute() {
          return 1 + 1;
        }
      `;
      expect(runOn(src)).toEqual([]);
    });
  });
});
