// ============================================================================
// test/detectors/regression.test.ts
//
// Spec for THE WEDGE — the regression detector
// (src/detectors/regression/assertionStrength.ts).
//
// This single detector (meta.id = "assertion-weakened", requiresBase = true)
// compares the BASE (pre-change) version of a test file against its HEAD
// (post-change) version and emits THREE distinct ruleIds:
//   • "assertion-weakened" — a surviving assertion swapped a strong matcher for
//                            a strictly weaker one. Graded: a collapse into the
//                            vacuous/existence band (toEqual -> toBeTruthy) is
//                            "warn"; a milder, commonly-legitimate loosening
//                            (toBe -> toContain) is advisory "info".
//   • "assertion-deleted"  — a test that USED to assert now asserts nothing
//                            ("warn").
//   • "test-skipped"       — a test that USED to run is now skipped/todo'd
//                            ("warn").
//
// Pairings are built with makeContext(HEAD, { baseText: BASE }) so the context
// carries a base SourceFile (mirroring core/ast.ts at runtime).
//
// PRECISION IS PARAMOUNT (this gates CI; a false positive mutes the tool), so
// the negative ACs — renamed test, brand-new test, no base ref — are pinned
// just as hard as the positive ones.
//
// Acceptance criteria covered (numbers per the assignment):
//   AC1 — base toEqual({a:1}) vs head toBeTruthy on the SAME test title
//         => exactly one "assertion-weakened", referencing the test by title,
//            with data.baseMatcher / data.headMatcher.
//   AC2 — base test with one expect vs head SAME test present (not skipped)
//         with ZERO assertions => "assertion-deleted".
//   AC3 — base active test vs head it.skip / xit / describe.skip / test.todo
//         => "test-skipped".
//   AC4 — a RENAMED test (different title) of identical strength => NO
//         weakened/deleted finding (renames must not be paired).
//   AC5 — a brand-new head test with no base counterpart => NO finding.
//   AC6 — makeContext WITHOUT baseText (no base ref) => detector returns [].
// ============================================================================

import { describe, expect, it } from "vitest";

import { detector } from "../../src/detectors/regression/assertionStrength.js";
import type { Finding } from "../../src/types.js";
import { makeContext } from "../helpers/context.js";

/** AC scenarios use no severity override, so pass an empty options object. */
const NO_OPTIONS = {} as const;

/** Run the regression detector on a (HEAD, BASE) pair. */
function runPair(head: string, base: string): Finding[] {
  return detector.run(makeContext(head, { baseText: base }), NO_OPTIONS);
}

/** Run the detector on a HEAD with NO base ref (regression cannot measure). */
function runNoBase(head: string): Finding[] {
  return detector.run(makeContext(head), NO_OPTIONS);
}

/**
 * Assert `findings` has exactly one entry and return it as a definitely-defined
 * `Finding`. Centralizes the "exactly one finding" expectation AND narrows the
 * element type (the project enables `noUncheckedIndexedAccess`, so `findings[0]`
 * is otherwise `Finding | undefined`).
 */
function onlyFinding(findings: Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  if (finding === undefined) throw new Error("expected exactly one finding");
  return finding;
}

describe("regression detector (assertion-weakened wedge)", () => {
  // --------------------------------------------------------------------------
  describe("meta", () => {
    it("declares the documented id, default 'warn' severity, and requiresBase", () => {
      expect(detector.meta.id).toBe("assertion-weakened");
      expect(detector.meta.defaultSeverity).toBe("warn");
      // The whole point of the wedge: it needs a base ref to regress against.
      expect(detector.meta.requiresBase).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // AC1 — assertion-weakened: a surviving assertion downgrades its matcher.
  // --------------------------------------------------------------------------
  describe("AC1: toEqual({a:1}) -> toBeTruthy on the same test => assertion-weakened", () => {
    const BASE = [
      `it("returns user", () => {`,
      `  expect(result).toEqual({ a: 1 });`,
      `});`,
    ].join("\n");
    const HEAD = [
      `it("returns user", () => {`,
      `  expect(result).toBeTruthy();`,
      `});`,
    ].join("\n");

    it("emits exactly one finding", () => {
      expect(runPair(HEAD, BASE)).toHaveLength(1);
    });

    it("stamps it with ruleId 'assertion-weakened' and 'warn' severity", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      expect(finding.ruleId).toBe("assertion-weakened");
      expect(finding.severity).toBe("warn");
    });

    it("references the affected test by its title", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      // The detector joins the title path with " > "; here that is just the
      // single leaf title.
      expect(finding.testName).toBe("returns user");
      expect(finding.message).toContain("returns user");
    });

    it("carries the before/after matchers in structured data", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      // data.baseMatcher / data.headMatcher are the BARE matcher names taken
      // from the paired assertions (Assertion.matcher), per the detector.
      expect(finding.data).toMatchObject({
        baseMatcher: "toEqual",
        headMatcher: "toBeTruthy",
        subject: "result",
      });
    });

    it("names both matchers in the human message", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      expect(finding.message).toContain("toEqual");
      expect(finding.message).toContain("toBeTruthy");
    });

    it("reports against the HEAD source file, at the head matcher line", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      expect(finding.file).toBe("virtual/sample.test.ts");
      // `expect(result).toBeTruthy()` sits on line 2 (1-based) of HEAD.
      expect(finding.line).toBe(2);
    });

    it("does NOT fire when the matcher is unchanged (no weakening)", () => {
      // Same strong matcher on both sides => nothing to flag. Guards against a
      // detector that flags any edit rather than a genuine downgrade.
      expect(runPair(BASE, BASE)).toEqual([]);
    });

    it("does NOT fire when the assertion is STRENGTHENED", () => {
      // Reverse direction: toBeTruthy (base) -> toEqual (head) is an upgrade.
      expect(runPair(BASE, HEAD)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC1b — weakening SEVERITY grading (the precision fix).
  //
  // The wedge must distinguish the canonical gaming move (a strong matcher
  // collapsing into the vacuous/existence band) from a milder, commonly-
  // LEGITIMATE loosening. The former is a confident "warn" (the only thing that
  // can mute CI); the latter is advisory "info" only. Same-tier swaps and
  // strengthenings remain non-findings. Each case is a single-matcher swap on
  // an otherwise byte-identical test, paired by title + subject.
  // --------------------------------------------------------------------------
  describe("AC1b: a weakening is graded warn (vacuous) vs info (mild loosening)", () => {
    /** Build a (HEAD, BASE) pair that swaps ONLY the matcher on `subject`. */
    function swapPair(subject: string, baseCall: string, headCall: string): { head: string; base: string } {
      const base = [`it("same case", () => {`, `  expect(${subject}).${baseCall};`, `});`].join("\n");
      const head = [`it("same case", () => {`, `  expect(${subject}).${headCall};`, `});`].join("\n");
      return { head, base };
    }

    it("grades toEqual -> toBeTruthy (4 -> 1, lands vacuous) as 'warn'", () => {
      const { head, base } = swapPair("result", "toEqual({ a: 1 })", "toBeTruthy()");
      const finding = onlyFinding(runPair(head, base));
      expect(finding.ruleId).toBe("assertion-weakened");
      expect(finding.severity).toBe("warn");
    });

    it("grades toEqual -> toBeDefined (4 -> 1, lands existence) as 'warn'", () => {
      const { head, base } = swapPair("result", "toEqual({ a: 1 })", "toBeDefined()");
      const finding = onlyFinding(runPair(head, base));
      expect(finding.ruleId).toBe("assertion-weakened");
      expect(finding.severity).toBe("warn");
    });

    it("grades toBe -> toContain (3 -> 2, mild loosening) as 'info'", () => {
      // A legitimate intentional loosening: e.g. the value became a longer
      // formatted string and the test now asserts a substring. Real downgrade,
      // but must NOT be a gate-muting "warn".
      const { head, base } = swapPair("user.name", "toBe('Ada')", "toContain('Ada')");
      const finding = onlyFinding(runPair(head, base));
      expect(finding.ruleId).toBe("assertion-weakened");
      expect(finding.severity).toBe("info");
    });

    it("grades toEqual -> toHaveProperty (4 -> 2, mild loosening) as 'info'", () => {
      // The other canonical legitimate loosening: an object gained non-
      // deterministic fields, so the test pins one stable property instead of
      // the whole shape. Advisory only.
      const { head, base } = swapPair("user", "toEqual({ id: 42 })", "toHaveProperty('id', 42)");
      const finding = onlyFinding(runPair(head, base));
      expect(finding.ruleId).toBe("assertion-weakened");
      expect(finding.severity).toBe("info");
    });

    it("emits NOTHING for a same-tier swap toStrictEqual -> toEqual (both tier 4)", () => {
      // An intra-tier reshuffle is not a weakening at all, at any severity.
      const { head, base } = swapPair("result", "toStrictEqual({ a: 1 })", "toEqual({ a: 1 })");
      expect(runPair(head, base)).toEqual([]);
    });

    it("emits NOTHING for a strengthening toContain -> toEqual (2 -> 4)", () => {
      // Going to a stronger matcher is good; never a finding of any severity.
      const { head, base } = swapPair("user.name", "toContain('Ada')", "toEqual('Ada')");
      expect(runPair(head, base)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC2 — assertion-deleted: the test survives but now asserts nothing.
  // --------------------------------------------------------------------------
  describe("AC2: a present test that lost its only assertion => assertion-deleted", () => {
    const BASE = [
      `it("computes total", () => {`,
      `  expect(total(cart)).toBe(42);`,
      `});`,
    ].join("\n");
    // Same title, still RUNNING (not skipped), but the body is now empty.
    const HEAD = [
      `it("computes total", () => {`,
      `});`,
    ].join("\n");

    it("emits exactly one finding with ruleId 'assertion-deleted'", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      expect(finding.ruleId).toBe("assertion-deleted");
    });

    it("uses 'warn' severity and references the test by title", () => {
      const finding = onlyFinding(runPair(HEAD, BASE));
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("computes total");
      expect(finding.message).toContain("computes total");
    });

    it("does NOT also emit a weakened finding (deletion supersedes)", () => {
      const ruleIds = runPair(HEAD, BASE).map((f) => f.ruleId);
      expect(ruleIds).not.toContain("assertion-weakened");
    });

    it("treats a commented-out assertion as deleted too (gone from the AST)", () => {
      // The whole assertion is now a comment, so the AST has no assertion =>
      // same outcome as physically removing it.
      const headCommented = [
        `it("computes total", () => {`,
        `  // expect(total(cart)).toBe(42);`,
        `});`,
      ].join("\n");
      const finding = onlyFinding(runPair(headCommented, BASE));
      expect(finding.ruleId).toBe("assertion-deleted");
    });

    it("does NOT fire when the assertion is merely changed but still present", () => {
      // Body still has a real (same-strength) assertion => not a deletion.
      const headStillAsserts = [
        `it("computes total", () => {`,
        `  expect(total(cart)).toBe(43);`,
        `});`,
      ].join("\n");
      expect(runPair(headStillAsserts, BASE)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC3 — test-skipped: a test that ran on base is now skipped/todo'd.
  // --------------------------------------------------------------------------
  describe("AC3: a base-active test that is now skipped => test-skipped", () => {
    const BASE = [
      `it("guards the invariant", () => {`,
      `  expect(value).toEqual({ ok: true });`,
      `});`,
    ].join("\n");

    // Each head form below makes the SAME-titled test no longer run.
    const skipForms: ReadonlyArray<readonly [string, string]> = [
      [
        "it.skip",
        [`it.skip("guards the invariant", () => {`, `  expect(value).toEqual({ ok: true });`, `});`].join("\n"),
      ],
      [
        "xit",
        [`xit("guards the invariant", () => {`, `  expect(value).toEqual({ ok: true });`, `});`].join("\n"),
      ],
      [
        "test.todo",
        // todo carries no body at all; it still pairs by title and is skipped.
        `test.todo("guards the invariant");`,
      ],
    ];

    for (const [label, head] of skipForms) {
      it(`flags '${label}' as a single test-skipped warn finding`, () => {
        const finding = onlyFinding(runPair(head, BASE));
        expect(finding.ruleId).toBe("test-skipped");
        expect(finding.severity).toBe("warn");
        expect(finding.testName).toBe("guards the invariant");
      });

      it(`does not also emit weakened/deleted for the '${label}' case`, () => {
        const ruleIds = runPair(head, BASE).map((f) => f.ruleId);
        expect(ruleIds).not.toContain("assertion-weakened");
        expect(ruleIds).not.toContain("assertion-deleted");
      });
    }

    it("flags a test newly wrapped in describe.skip (ancestor skip counts)", () => {
      // The leaf it() is itself active, but an enclosing describe.skip now
      // disables it. The detector resolves skip through the ancestor chain.
      const base = [
        `describe("suite", () => {`,
        `  it("guards the invariant", () => {`,
        `    expect(value).toEqual({ ok: true });`,
        `  });`,
        `});`,
      ].join("\n");
      const head = [
        `describe.skip("suite", () => {`,
        `  it("guards the invariant", () => {`,
        `    expect(value).toEqual({ ok: true });`,
        `  });`,
        `});`,
      ].join("\n");
      const finding = onlyFinding(runPair(head, base));
      expect(finding.ruleId).toBe("test-skipped");
      expect(finding.testName).toBe("suite > guards the invariant");
    });

    it("does NOT fire when the test was ALREADY skipped on the base ref", () => {
      // No regression: it was skipped before and is skipped now. Only a
      // base-active -> head-skipped transition is a regression.
      const base = [`it.skip("guards the invariant", () => { expect(value).toBe(1); });`].join("\n");
      const head = [`it.skip("guards the invariant", () => { expect(value).toBe(1); });`].join("\n");
      expect(runPair(head, base)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC4 — renamed test: no title match => no pairing => no finding (precision).
  // --------------------------------------------------------------------------
  describe("AC4: a renamed test of identical strength is not paired => no finding", () => {
    it("emits nothing when the title changed, even if the matcher also weakened", () => {
      // A weakening DID happen value-wise, but because the title (the only
      // pairing key) differs, the head test has no base counterpart. Pairing on
      // title alone is what keeps the rule precise; renames must not flag.
      const base = [`it("old title", () => {`, `  expect(result).toEqual({ a: 1 });`, `});`].join("\n");
      const head = [`it("new title", () => {`, `  expect(result).toBeTruthy();`, `});`].join("\n");
      expect(runPair(head, base)).toEqual([]);
    });

    it("emits nothing for a pure rename with byte-identical assertion strength", () => {
      // The classic refactor: rename the test, keep the exact same assertion.
      const base = [`it("adds two numbers", () => {`, `  expect(add(2, 3)).toBe(5);`, `});`].join("\n");
      const head = [`it("adds 2 and 3", () => {`, `  expect(add(2, 3)).toBe(5);`, `});`].join("\n");
      expect(runPair(head, base)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC5 — brand-new test: no base counterpart => no regression finding.
  // --------------------------------------------------------------------------
  describe("AC5: a brand-new head test with no base counterpart => no finding", () => {
    it("does not flag a freshly added test", () => {
      // The base has one test; the head adds a second, weak-but-NEW test. A new
      // test cannot be a regression of anything, so nothing is emitted.
      const base = [`it("existing", () => {`, `  expect(a).toBe(1);`, `});`].join("\n");
      const head = [
        `it("existing", () => {`,
        `  expect(a).toBe(1);`,
        `});`,
        `it("brand new", () => {`,
        `  expect(b).toBeTruthy();`,
        `});`,
      ].join("\n");
      expect(runPair(head, base)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // AC6 — no base ref: requiresBase means the detector emits nothing.
  // --------------------------------------------------------------------------
  describe("AC6: with no base ref the detector returns []", () => {
    it("returns an empty array when makeContext was given no baseText", () => {
      // Even an obviously 'weak' head file cannot regress without a base to
      // compare against, so the detector short-circuits to [].
      const head = [`it("returns user", () => {`, `  expect(result).toBeTruthy();`, `});`].join("\n");
      const findings = runNoBase(head);
      expect(findings).toEqual([]);
    });

    it("returns [] for a head with no tests at all and no base", () => {
      expect(runNoBase(`export const noTestsHere = 1;`)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Cross-cutting contract: this rule NEVER escalates to severity "fail".
  // --------------------------------------------------------------------------
  describe("severity contract: every regression finding is 'warn', never 'fail'", () => {
    it("emits only 'warn' across weakened, deleted, and skipped in one file", () => {
      // One file exercising all three ruleIds at once, by distinct titles.
      const base = [
        `it("w", () => { expect(x).toEqual({ a: 1 }); });`,
        `it("d", () => { expect(y).toBe(2); });`,
        `it("s", () => { expect(z).toBe(3); });`,
      ].join("\n");
      const head = [
        `it("w", () => { expect(x).toBeTruthy(); });`, // weakened
        `it("d", () => {});`, // deleted
        `it.skip("s", () => { expect(z).toBe(3); });`, // skipped
      ].join("\n");

      const findings = runPair(head, base);
      const ruleIds = findings.map((f) => f.ruleId).sort();
      expect(ruleIds).toEqual(["assertion-deleted", "assertion-weakened", "test-skipped"]);
      for (const finding of findings) {
        expect(finding.severity).toBe("warn");
        expect(finding.severity).not.toBe("fail");
      }
    });
  });
});
