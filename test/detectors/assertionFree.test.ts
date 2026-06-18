// ============================================================================
// test/detectors/assertionFree.test.ts
//
// Unit spec for the "assertion-free / snapshot-only" detector
// (src/detectors/assertionFree.ts).
//
// This detector flags two distinct, closely-related smells on leaf test cases,
// each with its OWN ruleId:
//
//   * "assertion-free" (warn): the body makes no real assertion at all. If the
//     body instead delegates to a LOCAL (in-file, resolvable) helper that
//     asserts, it is NOT flagged. If it delegates to a helper that cannot be
//     resolved in-file (e.g. an imported one), the finding is DOWNGRADED to
//     "info" rather than a confident "warn".
//   * "snapshot-only" (warn): the body's ONLY assertion(s) are
//     toMatchSnapshot() / toMatchInlineSnapshot(). A single concrete
//     non-snapshot assertion clears the smell.
//
// Acceptance criteria covered:
//   AC1: a body with no expect/assert => one "assertion-free" finding.
//   AC2: snapshot-only matchers (toMatchSnapshot / toMatchInlineSnapshot)
//        => "snapshot-only" (a distinct ruleId).
//   AC3: a snapshot PLUS a real expect() => NOT snapshot-only (cleared).
//   AC4: asserting via an in-file helper => NOT flagged; delegating to an
//        unresolved / imported helper => "info" severity. An unresolved MEMBER
//        call whose name reads like an assertion (`harness.assertX(p)`,
//        `page.shouldShowError()`) likewise downgrades to "info"; a plain
//        non-asserting member call (`arr.push`, `obj.doThing`) stays "warn".
//   AC5: node:assert (bare and member form) is recognised as an assertion
//        (no false assertion-free).
//   Plus: describe blocks and it.todo (no body) are ignored; ruleId, severity
//        and testName are asserted throughout.
//
// The detector is pure, read-only and synchronous; we drive it with inline
// source via the shared makeContext helper. Findings reported here are derived
// from the detector's ACTUAL documented behaviour, observed end-to-end.
//
// Subtle behaviour pinned by these tests (intentional, per the detector's
// precision-first design — see assertionFree.ts):
//   - A confident "assertion-free" warn requires the body to make NO bare
//     identifier call to an UNRESOLVED function. A bare `doStuff(x)` that does
//     not resolve in-file is treated as a possibly-asserting helper, so the
//     finding downgrades to "info".
//   - A member call (`obj.foo()`) downgrades to "info" ONLY when its method name
//     reads like an assertion (`harness.assertRejected(p)`,
//     `page.shouldShowError()`): such a method may assert internally and its body
//     is out of view. A plain non-asserting member call (`arr.push(1)`,
//     `obj.doThing()`) does NOT downgrade — the finding stays a confident "warn".
// ============================================================================

import { describe, expect, it } from "vitest";
import { detector } from "../../src/detectors/assertionFree.js";
import { makeContext } from "../helpers/context.js";

// --- tiny local helpers -----------------------------------------------------

/** Run the detector over inline source with the given options. */
function runOn(src: string, options: Parameters<typeof detector.run>[1] = {}) {
  return detector.run(makeContext(src), options);
}

const ASSERTION_FREE = "assertion-free" as const;
const SNAPSHOT_ONLY = "snapshot-only" as const;

describe("assertion-free / snapshot-only detector", () => {
  // --- metadata --------------------------------------------------------------
  describe("metadata", () => {
    it("exposes the frozen id, default severity and base requirement", () => {
      expect(detector.meta.id).toBe("assertion-free");
      expect(detector.meta.defaultSeverity).toBe("warn");
      expect(detector.meta.requiresBase).toBe(false);
    });
  });

  // --- AC1: a body with no assertion at all ----------------------------------
  describe("AC1: a test body with no expect/assert", () => {
    it("emits exactly one 'assertion-free' finding at warn", () => {
      const src = `
        import { it } from "vitest";
        it("does nothing useful", () => {
          const x = 1 + 1;
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(ASSERTION_FREE);
      // No unresolved helper calls => a confident, full "warn" (not "info").
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("does nothing useful");
      // Reported against the it(...) call line (3rd line of the source above).
      expect(finding.line).toBe(3);
      expect(finding.message).toContain("no assertion");
      // It must NOT be the snapshot rule.
      expect(finding.ruleId).not.toBe(SNAPSHOT_ONLY);
    });

    it("still flags (warn) when the body only makes MEMBER calls, which are not helpers", () => {
      // `obj.foo()` / `arr.push()` are member calls, not bare-identifier helper
      // calls, so they cannot mask a missing assertion: the finding stays a
      // confident warn rather than downgrading to info.
      const src = `
        import { it } from "vitest";
        it("mutates but never asserts", () => {
          const arr = [];
          arr.push(1);
          obj.doThing();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
      expect(findings[0]!.testName).toBe("mutates but never asserts");
    });

    it("flags an empty body at warn", () => {
      const src = `
        import { it } from "vitest";
        it("empty", () => {});
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
      expect(findings[0]!.testName).toBe("empty");
    });

    it("treats a bare expect(x) with no matcher as assertion-free", () => {
      // `expect(x)` without a terminal matcher is not a real assertion.
      const src = `
        import { expect, it } from "vitest";
        it("no matcher applied", () => {
          expect(value);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
    });
  });

  // --- AC2: snapshot-only is its own distinct rule ---------------------------
  describe("AC2: a test whose only assertion is a snapshot", () => {
    it("flags toMatchSnapshot() as 'snapshot-only' (distinct ruleId) at warn", () => {
      const src = `
        import { expect, it } from "vitest";
        it("renders", () => {
          expect(render()).toMatchSnapshot();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      // Distinct id — NOT assertion-free.
      expect(finding.ruleId).toBe(SNAPSHOT_ONLY);
      expect(finding.ruleId).not.toBe(ASSERTION_FREE);
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("renders");
      expect(finding.message).toContain("snapshot");
    });

    it("flags toMatchInlineSnapshot() the same way", () => {
      const src =
        'import { expect, it } from "vitest";\n' +
        'it("inline", () => {\n' +
        "  expect(render()).toMatchInlineSnapshot(`<div />`);\n" +
        "});\n";
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(SNAPSHOT_ONLY);
      expect(findings[0]!.severity).toBe("warn");
      expect(findings[0]!.testName).toBe("inline");
    });

    it("flags a body whose every assertion is a snapshot (multiple snapshots, still snapshot-only)", () => {
      const src = `
        import { expect, it } from "vitest";
        it("two snapshots only", () => {
          expect(a()).toMatchSnapshot();
          expect(b()).toMatchInlineSnapshot();
        });
      `;
      const findings = runOn(src);

      // Exactly one finding for the test, and it is the snapshot-only smell.
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(SNAPSHOT_ONLY);
      expect(findings[0]!.severity).toBe("warn");
    });
  });

  // --- AC3: snapshot + a real assertion clears snapshot-only -----------------
  describe("AC3: a snapshot PLUS a real expect() is not snapshot-only", () => {
    it("emits nothing when a concrete toBe() accompanies the snapshot", () => {
      const src = `
        import { expect, it } from "vitest";
        it("snapshot plus a real check", () => {
          const out = render();
          expect(out.status).toBe(200);
          expect(out).toMatchSnapshot();
        });
      `;
      // The concrete assertion makes the snapshot supplementary: no smell.
      expect(runOn(src)).toHaveLength(0);
    });

    it("emits nothing when a node:assert call accompanies the snapshot", () => {
      const src = `
        import assert from "node:assert";
        import { expect, it } from "vitest";
        it("snapshot plus node assert", () => {
          assert.equal(code(), 0);
          expect(view()).toMatchSnapshot();
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("does not misfire assertion-free either when a snapshot is present with a real check", () => {
      const src = `
        import { expect, it } from "vitest";
        it("has both", () => {
          expect(x()).toEqual({ ok: true });
          expect(x()).toMatchSnapshot();
        });
      `;
      const findings = runOn(src);
      expect(findings.map((f) => f.ruleId)).not.toContain(ASSERTION_FREE);
      expect(findings).toHaveLength(0);
    });
  });

  // --- AC4: in-file helper resolution ----------------------------------------
  describe("AC4: helper delegation", () => {
    it("does NOT flag when the test asserts via an in-file arrow helper", () => {
      const src = `
        import { expect, it } from "vitest";
        const expectValid = (x) => {
          expect(x).toBe(1);
        };
        it("delegates to a local helper", () => {
          expectValid(compute());
        });
      `;
      // A resolvable in-file helper that asserts => not flagged at all (no info).
      expect(runOn(src)).toHaveLength(0);
    });

    it("does NOT flag when the test asserts via an in-file function declaration helper", () => {
      const src = `
        import { expect, it } from "vitest";
        function verify(x) {
          expect(x).toBeGreaterThan(0);
        }
        it("uses a function-declaration helper", () => {
          verify(measure());
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("flags 'info' when the test delegates only to an UNresolved/imported helper", () => {
      const src = `
        import { it } from "vitest";
        import { verifyResult } from "./helpers";
        it("delegates outside the file", () => {
          verifyResult(thing());
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      // Still the assertion-free RULE, but downgraded to info (low confidence).
      expect(finding.ruleId).toBe(ASSERTION_FREE);
      expect(finding.severity).toBe("info");
      expect(finding.testName).toBe("delegates outside the file");
      // The info message is distinct from the confident-warn message.
      expect(finding.message).toContain("could not be confirmed");
    });

    it("stays a confident 'warn' when an in-file helper resolves but does NOT assert", () => {
      // The helper IS resolvable in-file; it simply contains no assertion. The
      // detector can SEE that, so the test is a genuine, confident assertion-free
      // case — warn, not the low-confidence info.
      const src = `
        import { it } from "vitest";
        function setup(x) {
          return x + 1;
        }
        it("calls a non-asserting local helper", () => {
          setup(2);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
    });
  });

  // --- AC4 (member calls): an unresolved asserting-looking member call --------
  describe("AC4: unresolved member call that could plausibly assert", () => {
    it("downgrades to 'info' when the only verification is harness.assertX(p)", () => {
      // `harness.assertRejected(p)` is a member call whose body lives on an
      // imported harness type we cannot see; its name reads like an assertion, so
      // it may assert internally. A confident "warn" here would be a false
      // positive — downgrade to low-confidence "info" instead.
      const src = `
        import { it } from "vitest";
        it("rejects the bad input", () => {
          const p = subject();
          harness.assertRejected(p);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(ASSERTION_FREE);
      expect(finding.severity).toBe("info");
      expect(finding.testName).toBe("rejects the bad input");
      // Shares the low-confidence message used for unresolved bare helpers.
      expect(finding.message).toContain("could not be confirmed");
    });

    it("downgrades to 'info' for a should*-style member call (page.shouldShowError())", () => {
      const src = `
        import { it } from "vitest";
        it("surfaces the error", () => {
          page.shouldShowError();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("info");
    });

    it("downgrades to 'info' for a this.expectX(...) member call", () => {
      // `this`-rooted asserting-looking methods (page-object / fixture style)
      // count too: the method body is out of view and may assert.
      const src = `
        import { it } from "vitest";
        it("checks status via fixture", function () {
          this.expectStatus(200);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("info");
    });

    it("stays a confident 'warn' for a genuinely empty body (no calls at all)", () => {
      // The member-call downgrade must not leak into the truly-empty case: with
      // no calls whatsoever there is nothing that could assert, so it remains a
      // confident, full "warn".
      const src = `
        import { it } from "vitest";
        it("entirely empty", () => {});
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
      expect(findings[0]!.message).toContain("no assertion");
    });

    it("stays a confident 'warn' when the only member calls are obviously non-asserting", () => {
      // `arr.push(1)` / `obj.doThing()` are plain mutations; their names do not
      // read like assertions, so the body remains a confident assertion-free warn
      // (this is the precision floor that keeps the downgrade conservative).
      const src = `
        import { it } from "vitest";
        it("only mutates", () => {
          const arr = [];
          arr.push(1);
          obj.doThing();
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("warn");
    });
  });

  // --- AC5: node:assert is a real assertion ----------------------------------
  describe("AC5: node:assert is recognised (no false assertion-free)", () => {
    it("does NOT flag a member-form assert.equal(...)", () => {
      const src = `
        import assert from "node:assert";
        import { it } from "vitest";
        it("asserts via node:assert.equal", () => {
          assert.equal(add(1, 1), 2);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("does NOT flag a bare assert(cond)", () => {
      const src = `
        import assert from "node:assert";
        import { it } from "vitest";
        it("asserts via bare assert", () => {
          assert(isValid(input()));
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("does NOT flag the strict namespace (strict.deepStrictEqual)", () => {
      const src = `
        import { strict } from "node:assert";
        import { it } from "vitest";
        it("asserts via strict namespace", () => {
          strict.deepStrictEqual(parse(s()), expected);
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });
  });

  // --- describe / it.todo are ignored ----------------------------------------
  describe("ignored constructs", () => {
    it("never flags a describe suite itself", () => {
      // A describe with no leaf test inside has nothing to flag; the suite is
      // never assertion-free by construction.
      const src = `
        import { describe } from "vitest";
        describe("a group", () => {
          const shared = 1;
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("only flags the leaf it(), never the wrapping describe", () => {
      const src = `
        import { describe, it } from "vitest";
        describe("outer", () => {
          it("inner empty test", () => {
            const x = 1;
          });
        });
      `;
      const findings = runOn(src);

      // Exactly one finding, belonging to the leaf — not the describe.
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      // testName is the full describe>it path, joined with " > " (the detector
      // qualifies the leaf with its enclosing suite title).
      expect(findings[0]!.testName).toBe("outer > inner empty test");
      expect(findings[0]!.testName).toContain("inner empty test");
    });

    it("ignores it.todo (no body to judge)", () => {
      const src = `
        import { it } from "vitest";
        it.todo("implement later");
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("ignores a todo inside a describe but still flags a real empty leaf beside it", () => {
      const src = `
        import { describe, it } from "vitest";
        describe("mixed", () => {
          it.todo("future case");
          it("real but empty", () => {
            const noop = true;
          });
        });
      `;
      const findings = runOn(src);

      // Only the real leaf is flagged; the todo contributes nothing.
      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.testName).toContain("real but empty");
    });
  });

  // --- AC3 severity override + structural / multi-block behaviour ------------
  describe("severity override", () => {
    it("honours severityOverride on an assertion-free finding", () => {
      const src = `
        import { it } from "vitest";
        it("empty", () => {});
      `;
      const findings = runOn(src, { severityOverride: "fail" });

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(ASSERTION_FREE);
      expect(findings[0]!.severity).toBe("fail");
    });

    it("honours severityOverride on a snapshot-only finding", () => {
      const src = `
        import { expect, it } from "vitest";
        it("snap", () => {
          expect(view()).toMatchSnapshot();
        });
      `;
      const findings = runOn(src, { severityOverride: "fail" });

      expect(findings).toHaveLength(1);
      expect(findings[0]!.ruleId).toBe(SNAPSHOT_ONLY);
      expect(findings[0]!.severity).toBe("fail");
    });
  });

  describe("structure", () => {
    it("flags each offending leaf independently with the right rule", () => {
      const src = `
        import { expect, it } from "vitest";
        it("free one", () => {
          const x = 1;
        });
        it("solid one", () => {
          expect(sum(2, 3)).toBe(5);
        });
        it("snap one", () => {
          expect(view()).toMatchSnapshot();
        });
      `;
      const findings = runOn(src);

      // The solid test is silent; the other two each earn their own finding.
      expect(findings).toHaveLength(2);
      const byName = new Map(findings.map((f) => [f.testName, f]));
      expect(byName.get("free one")!.ruleId).toBe(ASSERTION_FREE);
      expect(byName.get("free one")!.severity).toBe("warn");
      expect(byName.get("snap one")!.ruleId).toBe(SNAPSHOT_ONLY);
      expect(byName.get("snap one")!.severity).toBe("warn");
      // The concrete test produced no finding at all.
      expect(byName.has("solid one")).toBe(false);
    });

    it("returns a stable empty array for a file with no test blocks", () => {
      const src = `
        export function compute() {
          return 1 + 1;
        }
      `;
      expect(runOn(src)).toEqual([]);
    });

    it("populates testName on every finding it emits", () => {
      const src = `
        import { expect, it } from "vitest";
        it("named free", () => {});
        it("named snap", () => {
          expect(v()).toMatchSnapshot();
        });
      `;
      const findings = runOn(src);
      expect(findings).toHaveLength(2);
      for (const f of findings) {
        expect(typeof f.testName).toBe("string");
        expect(f.testName!.length).toBeGreaterThan(0);
      }
    });
  });
});
