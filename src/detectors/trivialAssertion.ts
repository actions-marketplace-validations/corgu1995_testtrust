// ============================================================================
// src/detectors/trivialAssertion.ts
//
// The "trivial-assertion" smell (informational).
//
// A test that DOES assert something, but whose every assertion is a single
// weak/vacuous matcher carrying almost no information, is barely better than a
// test with no assertions at all. The canonical shapes:
//
//     it("works", () => { expect(thing).toBeDefined(); });
//     it("runs",  () => { expect(() => run()).not.toThrow(); });
//     it("ok",    () => { expect(x).toBeTruthy(); expect(y).toBeDefined(); });
//
// Each of these passes for an enormous equivalence class of buggy values: a
// wrong-but-defined object, any truthy value, anything that merely didn't
// throw. None pins a concrete value or shape, so the test gives a false sense
// of coverage.
//
// What we flag (AC1): a leaf `it`/`test` whose body HAS at least one assertion
// AND every assertion is one of the recognised weak matchers
// (`toBeDefined` / `toBeTruthy` / `toBeUndefined`, or a negated `toThrow` —
// i.e. `.not.toThrow()`), with NO concrete value/shape assertion anywhere in
// the body.
//
// What we DO NOT flag:
//   * Tests with a concrete assertion alongside a weak one (AC2) — e.g. a body
//     that also calls `toEqual` / `toBe(literal)` / `toHaveBeenCalledWith` /
//     `toMatchObject` / a `node:assert` method / a bare `assert(...)`. The mere
//     presence of one non-trivial assertion clears the test.
//   * Assertion-FREE tests — those are the assertion-free detector's concern,
//     not ours. We require at least one real assertion before we say anything.
//   * Anything we cannot positively classify as trivial. If even one assertion
//     in the body is something other than our small whitelist (including a
//     matcher we could not resolve, or a positive bare `toThrow()`), we stay
//     silent. PRECISION FIRST — a false positive mutes the whole tool.
//
// Severity (AC3): "info" by default. This is advisory: the scorer weights it
// lightly and `info` never forces a "fail" verdict on its own. A user may raise
// it via the rules flag (severityOverride), but we never escalate ourselves.
//
// We rely exclusively on the shared, never-throwing helpers `getTestBlocks`,
// `getAssertions`, `getLine`, `getPosition` and `getLineSnippet` — we never
// re-traverse the AST by hand.
// ============================================================================

import type { Detector, DetectorMeta, DetectorRunOptions, Finding, TestFileContext } from "../types.js";
import type { Assertion } from "./shared.js";
import { getAssertions, getLineSnippet, getPosition, getTestBlocks } from "./shared.js";

/**
 * The existence/truthiness matchers we consider near-vacuous. These collapse the
 * value under test to "something is here" / "nothing is here" / "it's truthy"
 * and assert essentially nothing about the actual content — whole equivalence
 * classes of buggy values satisfy them. Mirrors the existence tier (tier 1) of
 * the regression strength model.
 *
 * Negation does not rescue these: `not.toBeDefined()` is just `toBeUndefined`,
 * still existence-level, so they count as trivial regardless of `.not`.
 */
const WEAK_EXISTENCE_MATCHERS: ReadonlySet<string> = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeUndefined",
]);

/**
 * The `toThrow` family. A NEGATED throw assertion (`expect(fn).not.toThrow()`)
 * asserts only that the code ran without throwing — near-vacuous, so it is
 * trivial. A POSITIVE `toThrow(...)` does carry signal (something threw, and
 * possibly with an expected message/type) and is therefore intentionally NOT
 * treated as trivial here.
 */
const THROW_MATCHERS: ReadonlySet<string> = new Set(["toThrow", "toThrowError"]);

/**
 * Is this single assertion one of the recognised trivial forms?
 *
 *   * an existence matcher (`toBeDefined` / `toBeTruthy` / `toBeUndefined`),
 *     with or without `.not`; or
 *   * a NEGATED `toThrow` / `toThrowError` (i.e. `.not.toThrow()`).
 *
 * Everything else — including any `node:assert` assertion, a positive
 * `toThrow`, and any matcher we could not resolve (`matcher === undefined`) —
 * is treated as NON-trivial so its presence prevents a finding.
 */
function isTrivialAssertion(assertion: Assertion): boolean {
  // Only `expect(...)` chains can be trivial under our definition; node:assert
  // calls are always concrete value/shape checks for our purposes.
  if (assertion.framework !== "expect") return false;

  const matcher = assertion.matcher;
  if (matcher === undefined) return false; // unresolved => cannot prove trivial.

  if (WEAK_EXISTENCE_MATCHERS.has(matcher)) return true;

  // A throw assertion is only trivial when negated (`.not.toThrow()`).
  if (THROW_MATCHERS.has(matcher) && assertion.negated) return true;

  return false;
}

const meta: DetectorMeta = {
  id: "trivial-assertion",
  title: "Trivial assertion",
  description:
    "Test asserts only weak/vacuous matchers (toBeDefined/toBeTruthy/toBeUndefined or .not.toThrow) with no concrete value or shape check.",
  defaultSeverity: "info",
  requiresBase: false,
};

function run(ctx: TestFileContext, options: DetectorRunOptions): Finding[] {
  const findings: Finding[] = [];
  const severity = options.severityOverride ?? meta.defaultSeverity;

  for (const block of getTestBlocks(ctx.sourceFile)) {
    // Only leaf test cases (it/test) have an assertable body; skip suites.
    if (block.isSuite) continue;
    if (block.body === undefined) continue;

    const assertions = getAssertions(block.body);

    // An assertion-FREE test is NOT this rule's concern (assertion-free owns it).
    // We only speak up when there is at least one real assertion.
    if (assertions.length === 0) continue;

    // Flag ONLY when EVERY assertion is trivial. A single non-trivial assertion
    // (a concrete value/shape check, a node:assert, a positive toThrow, or an
    // unresolved matcher) clears the test (AC2).
    if (!assertions.every(isTrivialAssertion)) continue;

    // Report against the first trivial assertion so the caret lands on a real
    // offending matcher line. Collect the matched matcher names for `data` (AC4).
    const first = assertions[0];
    if (first === undefined) continue; // defensive; length checked above.

    const position = getPosition(first.matcherNode) ?? getPosition(first.node);
    if (position === undefined) continue; // can't locate it -> stay silent.

    const matcherNames = dedupeMatchers(assertions);
    const snippet = getLineSnippet(first.matcherNode) ?? getLineSnippet(first.node);

    const finding: Finding = {
      ruleId: "trivial-assertion",
      severity,
      file: ctx.filePath,
      line: position.line,
      column: position.column,
      message: buildMessage(matcherNames),
      data: { matchers: matcherNames },
    };
    if (snippet !== undefined) finding.snippet = snippet;
    if (block.title !== undefined) finding.testName = block.title;

    findings.push(finding);
  }

  return findings;
}

/**
 * The display form of each assertion's matcher, de-duplicated and in
 * first-seen order. A negated throw is shown as `not.toThrow` so the author
 * recognises the exact offending shape.
 */
function dedupeMatchers(assertions: readonly Assertion[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const a of assertions) {
    const name = displayMatcher(a);
    if (name === undefined) continue;
    if (set.has(name)) continue;
    set.add(name);
    seen.push(name);
  }
  return seen;
}

/** Human-facing label for a single trivial assertion's matcher. */
function displayMatcher(assertion: Assertion): string | undefined {
  const matcher = assertion.matcher;
  if (matcher === undefined) return undefined;
  if (assertion.negated && THROW_MATCHERS.has(matcher)) return `not.${matcher}`;
  return matcher;
}

/** One clear sentence naming the weak matcher(s) the test relies on. */
function buildMessage(matcherNames: readonly string[]): string {
  const list = matcherNames.map((m) => `${m}()`).join(", ");
  const base =
    matcherNames.length === 1
      ? `Test only asserts with the weak matcher ${list}`
      : `Test only asserts with weak matchers ${list}`;
  return `${base}; it pins no concrete value or shape, so many wrong values would still pass.`;
}

export const detector: Detector = { meta, run };
