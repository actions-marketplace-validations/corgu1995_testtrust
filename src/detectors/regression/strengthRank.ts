// ============================================================================
// src/detectors/regression/strengthRank.ts
//
// Pure data + lookup for the "assertion-weakened" regression detector.
//
// The wedge: an agent (or a careless human) "fixes a failing test" by swapping
// a strong matcher for a weaker one — e.g. `expect(x).toEqual({a:1,b:2})`
// becomes `expect(x).toBeDefined()`. The test still passes, CI goes green, and
// a real regression ships. To catch that, the regression engine compares the
// matcher used on BASE against the matcher used on HEAD for the "same"
// assertion and asks: did the assertion get strictly weaker?
//
// This module owns ONLY the strength model and the comparison primitives. It
// does NO AST work, NO IO, and holds NO state — it is a lookup table plus two
// trivially unit-testable pure functions. The detector that pairs up base/head
// assertions lives elsewhere; it calls `isWeakening()` to make the verdict.
//
// DESIGN BIAS (read before editing the table): this feeds a CI gate, so a false
// positive (wrongly flagging a legitimate change) erodes trust far faster than a
// false negative (missing one weakening). Every ambiguous call is therefore
// resolved toward NOT flagging:
//   - Unknown matchers rank `undefined`, and any comparison touching an unknown
//     short-circuits to `false` (we refuse to judge what we don't model).
//   - The tiers are coarse (5 buckets, 0..4). We only flag a *cross-tier* drop,
//     never an intra-tier reshuffle, because fine-grained ranking within a tier
//     would be guesswork that manufactures false positives.
// ============================================================================

/**
 * Strength tiers for Jest/Vitest matchers, strongest (4) to weakest (0).
 *
 * The number is an ordinal bucket, not a score — only the relative ordering is
 * meaningful, and only ACROSS tiers. Two matchers in the same tier are treated
 * as equivalently strong (swapping `toEqual` for `toStrictEqual`, or `toBe` for
 * `toHaveBeenCalledWith`, is NOT a weakening).
 *
 * Rationale for the ordering, tier by tier:
 *
 *  4 — EXACT / STRUCTURAL. Asserts (nearly) the entire observable value:
 *      deep structural/recursive equality. `toStrictEqual` is the gold standard
 *      (also checks `undefined` keys, sparseness, and types); `toEqual` is a hair
 *      looser but still whole-value; `toMatchObject` pins every property the
 *      author listed. Dropping out of this tier means giving up "the value is
 *      what I said it is" — the strongest claim a test can make.
 *
 *  3 — IDENTITY / SCALAR VALUE. Pins one concrete value or one concrete call:
 *      `toBe` (===), `toHaveBeenCalledWith` (exact args), `toHaveReturnedWith`
 *      (exact return), and `toThrow(expected)` where an expected message/type
 *      IS supplied. Strong and specific, but narrower than tier 4: it constrains
 *      a single value/edge, not a whole structure. (`toThrow` with NO argument
 *      is intentionally NOT here — see tier 0.)
 *
 *  2 — PARTIAL / SHAPE. Constrains a slice or a property of the value, leaving
 *      the rest free: `toContain` / `toContainEqual` (one member exists),
 *      `toHaveLength` (size only), `toHaveProperty` (one key, maybe its value),
 *      `toMatch` (a substring/regex), `toHaveBeenCalledTimes` (call count, not
 *      args). Real signal, but a large space of wrong values still passes.
 *
 *  1 — EXISTENCE / WEAK. Collapses the value to a boolean-ish predicate:
 *      `toBeTruthy` / `toBeFalsy` / `toBeDefined` / `toBeUndefined` / `toBeNull`
 *      / `toBeNaN`. Verifies "something / nothing / a sentinel is here" and
 *      essentially nothing about the actual content. Whole equivalence classes
 *      of buggy values satisfy these.
 *
 *  0 — NEAR-VACUOUS. Asserts almost nothing an empty test wouldn't also pass:
 *      `not.toThrow` (it merely ran), `toHaveBeenCalled` (it was invoked at all),
 *      and bare `toThrow()` (it threw *something*, message/type unchecked).
 *      Falling to this tier from anything above is the canonical weakening.
 *
 * NOTE: this map is keyed by the BARE matcher name (no `expect(...)`, no
 * leading `not.`). Negation is handled separately in `rank()` because `not`
 * flips which member of a complementary pair you're asserting but generally
 * does NOT change the *tier* (e.g. `toBeTruthy` and `not.toBeTruthy` are both
 * existence-level), with the deliberate exception of `not.toThrow` (see below).
 */
export const STRENGTH_TIERS: Readonly<Record<number, readonly string[]>> = {
  4: ["toStrictEqual", "toEqual", "toMatchObject"],
  3: ["toBe", "toHaveBeenCalledWith", "toHaveReturnedWith", "toReturnedWith"],
  2: [
    "toContain",
    "toContainEqual",
    "toHaveLength",
    "toHaveProperty",
    "toMatch",
    "toHaveBeenCalledTimes",
  ],
  1: ["toBeTruthy", "toBeFalsy", "toBeDefined", "toBeUndefined", "toBeNull", "toBeNaN"],
  0: ["toHaveBeenCalled"],
} as const;

/**
 * Flat matcher-name -> tier index, derived once from {@link STRENGTH_TIERS}.
 *
 * This is the actual lookup used by {@link rank}. We build it eagerly (module
 * load) from the tiered source of truth so the human-readable table above and
 * the machine-readable map below can never drift apart.
 *
 * Matchers NOT present here are UNKNOWN by definition, and `rank()` returns
 * `undefined` for them so callers refuse to judge.
 */
const MATCHER_RANK: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [tierStr, matchers] of Object.entries(STRENGTH_TIERS)) {
    const tier = Number(tierStr);
    for (const name of matchers) m.set(name, tier);
  }
  return m;
})();

/**
 * `toThrow` is context-sensitive, so it is deliberately NOT in the static table:
 *
 *   - `toThrow(expected)`  — an expected message/type/error is supplied. This is
 *                            a precise value-level assertion: tier 3 (IDENTITY).
 *   - `toThrow()` (bare)   — only asserts that *something* threw. Near-vacuous:
 *                            tier 0.
 *   - `not.toThrow(...)`   — asserts the code merely ran without throwing. That
 *                            is essentially "it executed": tier 0, regardless of
 *                            any argument (an arg is meaningless under negation).
 *
 * The caller cannot encode "has an expected argument" in the matcher name alone,
 * so {@link rank} takes that as out-of-band info it must already know from the
 * AST. We expose these as named constants (rather than burying magic numbers in
 * `rank`) so the rationale is self-documenting and unit tests can assert them.
 */
export const TO_THROW_WITH_ARG_RANK = 3;
export const TO_THROW_BARE_RANK = 0;
export const NOT_TO_THROW_RANK = 0;

/**
 * Bare matcher name used by the `toThrow` family (also matches the Jest alias
 * `toThrowError`). Centralized so {@link rank} and any future caller agree.
 */
const THROW_MATCHERS: ReadonlySet<string> = new Set(["toThrow", "toThrowError"]);

/**
 * Resolve a matcher to its strength tier (0..4), or `undefined` if the matcher
 * is not modeled.
 *
 * @param matcher  The BARE matcher name as it appears after `expect(...).`,
 *                 e.g. `"toEqual"`, `"toBeTruthy"`, `"toThrow"`. Do NOT include
 *                 a leading `not.` — pass negation via {@link rank}'s `negated`
 *                 flag instead. Leading/trailing whitespace is tolerated.
 * @param negated  Whether the assertion was written through `.not.`. Defaults to
 *                 `false`.
 *
 * @returns The tier index, or `undefined` for an UNKNOWN matcher (so the caller
 *          can decline to make any weakening judgment — protecting precision).
 *
 * Negation semantics (intentionally minimal — we only special-case where the
 * tier genuinely shifts):
 *   - The `toThrow` family is fully context-dependent (see the constants above):
 *       * `not.toThrow`            -> {@link NOT_TO_THROW_RANK} (0)
 *       * `toThrow` WITH an arg     -> {@link TO_THROW_WITH_ARG_RANK} (3)
 *       * `toThrow` bare/no arg     -> {@link TO_THROW_BARE_RANK} (0)
 *     "Has an expected arg" cannot be inferred from the name, so it is read from
 *     the matcher string's trailing parens *only* as a best-effort signal
 *     (`toThrow(...)` with non-empty contents); when in doubt we fall to bare.
 *   - For every other matcher, `negated` does NOT change the tier. `not.` flips
 *     which side of a complementary pair you assert (`toBeNull` vs
 *     `not.toBeNull`) but keeps the same strength class, and inventing finer
 *     distinctions here would only manufacture false positives. We therefore
 *     keep it simple and tier-stable.
 */
export function rank(matcher: string, negated = false): number | undefined {
  const raw = matcher.trim();
  if (raw.length === 0) return undefined;

  // Split an optional argument list off the name so callers may pass either the
  // bare name ("toThrow") or a lightweight call form ("toThrow(TypeError)").
  // We only use this to detect whether `toThrow` carried an expected argument;
  // all table lookups use the bare name.
  const parenIdx = raw.indexOf("(");
  const name = (parenIdx === -1 ? raw : raw.slice(0, parenIdx)).trim();
  const argText = parenIdx === -1 ? "" : raw.slice(parenIdx + 1, raw.lastIndexOf(")")).trim();

  // --- context-sensitive toThrow / toThrowError family ---------------------
  if (THROW_MATCHERS.has(name)) {
    if (negated) return NOT_TO_THROW_RANK; // "it ran without throwing" ≈ vacuous
    // Distinguish toThrow(expected) (tier 3) from bare toThrow() (tier 0). With
    // only the bare name and no parsed arg, we conservatively treat it as bare:
    // under-counting strength here can never cause a false "weakened" flag,
    // because a *lower* base rank makes weakening HARDER to trigger.
    return argText.length > 0 ? TO_THROW_WITH_ARG_RANK : TO_THROW_BARE_RANK;
  }

  // --- everything else: pure table lookup ----------------------------------
  // `negated` is intentionally ignored for non-throw matchers (tier-stable).
  // `Map.get` returns `undefined` for unknown matchers, which is exactly the
  // "refuse to judge" signal we want to propagate to callers.
  return MATCHER_RANK.get(name);
}

/**
 * Decide whether the HEAD assertion is strictly WEAKER than the BASE assertion.
 *
 * This is the single primitive the `assertion-weakened` detector keys off of.
 * It is intentionally conservative: it returns `true` ONLY when BOTH matchers
 * are modeled AND the head tier is strictly below the base tier.
 *
 * @param baseMatcher  Bare matcher name on the BASE ref (pre-change).
 * @param headMatcher  Bare matcher name on the HEAD ref (post-change).
 * @param baseNegated  Whether the base assertion used `.not.`. Default `false`.
 * @param headNegated  Whether the head assertion used `.not.`. Default `false`.
 *
 * @returns `true` iff `rank(base) > rank(head)` and neither rank is `undefined`.
 *
 * Guard rails (each one trades recall for precision on purpose):
 *   - UNKNOWN on either side  -> `false`. We never flag a transition involving a
 *     matcher we don't model; we cannot know if it was a downgrade.
 *   - EQUAL tier              -> `false`. Same-strength swap (e.g. `toEqual` ->
 *     `toStrictEqual`, or `toBe` -> `toHaveBeenCalledWith`) is not a weakening.
 *   - STRENGTHENING           -> `false`. Going to a stronger matcher is good.
 *
 * Only a genuine cross-tier DOWNGRADE returns `true`.
 */
export function isWeakening(
  baseMatcher: string,
  headMatcher: string,
  baseNegated = false,
  headNegated = false,
): boolean {
  const baseRank = rank(baseMatcher, baseNegated);
  const headRank = rank(headMatcher, headNegated);

  // If we can't rank either side, refuse to judge (precision over recall).
  if (baseRank === undefined || headRank === undefined) return false;

  // Strictly weaker head => weakening. Equal or stronger => not flagged.
  return headRank < baseRank;
}

/**
 * Severity buckets emitted by {@link weakeningSeverity}. Deliberately a strict
 * subset of the wire-format `Severity` (no "fail"): this rule gates CI but must
 * never *alone* fail it — that decision belongs to the scorer.
 */
export type WeakeningSeverity = "warn" | "info";

/**
 * The tier (inclusive) at/below which a HEAD matcher counts as having collapsed
 * into the vacuous/existence band — tiers 0 (near-vacuous) and 1 (existence).
 * A drop that LANDS here is the canonical test-gaming move the wedge exists to
 * catch (e.g. `toEqual`/`toBe` -> `toBeDefined`/`toBeTruthy`/`not.toThrow`).
 */
const VACUOUS_TIER_CEILING = 1;

/**
 * The tier (inclusive) at/above which a BASE matcher carried real structural or
 * value signal — tier 2 (partial/shape) and up. We only escalate to "warn" when
 * the assertion fell FROM something meaningful (>= 2) INTO the vacuous band, so
 * an already-weak base can never produce a confident gate-muting flag.
 */
const SIGNAL_TIER_FLOOR = 2;

/**
 * Grade a base->head matcher transition for the `assertion-weakened` rule.
 *
 * This refines {@link isWeakening}: that primitive answers the binary "is this a
 * downgrade at all?" (any strict cross-tier drop between two modeled matchers).
 * `weakeningSeverity` keeps EXACTLY that "is it a downgrade" gate, then splits
 * the *genuine* downgrades by how dangerous they are — because not every real
 * downgrade is test-gaming, and over-flagging the benign ones mutes CI.
 *
 * @param baseMatcher  Bare matcher name on the BASE ref (pre-change). For the
 *                     context-sensitive `toThrow` family, pass the call form
 *                     (`"toThrow(x)"` vs `"toThrow()"`) so {@link rank} can tell
 *                     the precise (tier 3) case from the bare (tier 0) one.
 * @param headMatcher  Bare matcher name on the HEAD ref (post-change), same call
 *                     -form convention as `baseMatcher`.
 * @param baseNegated  Whether the base assertion used `.not.`. Default `false`.
 * @param headNegated  Whether the head assertion used `.not.`. Default `false`.
 *
 * @returns
 *   - `undefined` — NOT a weakening. Either an UNKNOWN matcher on either side,
 *     or `rank(head) >= rank(base)` (equal-tier swap or a strengthening). This
 *     mirrors {@link isWeakening} returning `false`, so the two never disagree on
 *     "is it a downgrade".
 *   - `"warn"`   — a genuine downgrade that LANDS in the vacuous/existence band
 *     (`head <= 1`) coming from a matcher that carried real signal (`base >= 2`).
 *     This is the canonical gaming move (`toEqual`/`toBe` -> `toBeDefined` /
 *     `toBeTruthy` / `not.toThrow`) and the wedge's whole reason to exist.
 *   - `"info"`   — a genuine downgrade that does NOT bottom out in tiers 0-1
 *     (e.g. 4->2 `toEqual` -> `toHaveProperty`, 3->2 `toBe` -> `toContain`,
 *     4->3 `toEqual` -> `toBe`). These are real reductions in strength but are
 *     very commonly LEGITIMATE loosenings (a value became a longer formatted
 *     string; an object gained non-deterministic fields), so they are advisory
 *     ONLY and must never on their own fail the gate.
 *
 * Why the two-sided condition (not just "head <= 1"): a base that is ITSELF in
 * the vacuous band can't be weakened *into* it (it would not be a downgrade at
 * all — `isWeakening` already returns false), and a base at tier 2 dropping to
 * tier 1 is exactly the "shape -> existence" collapse we DO want to warn on, so
 * the floor is the natural `SIGNAL_TIER_FLOOR`.
 */
export function weakeningSeverity(
  baseMatcher: string,
  headMatcher: string,
  baseNegated = false,
  headNegated = false,
): WeakeningSeverity | undefined {
  const baseRank = rank(baseMatcher, baseNegated);
  const headRank = rank(headMatcher, headNegated);

  // Unknown on either side => refuse to judge (identical guard to isWeakening).
  if (baseRank === undefined || headRank === undefined) return undefined;

  // Not strictly weaker => not a weakening (equal tier or a strengthening).
  if (headRank >= baseRank) return undefined;

  // Genuine downgrade. Escalate to "warn" only when it bottoms out in the
  // vacuous/existence band (head <= 1) FROM a matcher that meant something
  // (base >= 2). Every other real downgrade is advisory "info".
  if (headRank <= VACUOUS_TIER_CEILING && baseRank >= SIGNAL_TIER_FLOOR) {
    return "warn";
  }
  return "info";
}
