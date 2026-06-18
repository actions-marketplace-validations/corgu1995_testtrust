import type { Detector, RuleId } from "../types.js";
import { detector as assertionFree } from "../detectors/assertionFree.js";
import { detector as tautology } from "../detectors/tautology.js";
import { detector as overMockingSut } from "../detectors/overMockingSut.js";
import { detector as trivialAssertion } from "../detectors/trivialAssertion.js";
import { detector as assertionStrength } from "../detectors/regression/assertionStrength.js";

/** All detectors, append-only. Add a detector here (one import + one entry). */
export const ALL_DETECTORS: readonly Detector[] = [
  assertionFree,
  tautology,
  overMockingSut,
  trivialAssertion,
  assertionStrength,
];

/** Which RuleIds each detector can emit. Most emit one; the regression engine
 *  emits three. Used by the orchestrator to resolve enable/disable + severity
 *  overrides per rule (not per detector). */
export const DETECTOR_RULE_IDS: ReadonlyMap<Detector, readonly RuleId[]> =
  new Map<Detector, readonly RuleId[]>([
    [assertionFree, ["assertion-free", "snapshot-only"]],
    [tautology, ["tautology"]],
    [overMockingSut, ["over-mocking-sut"]],
    [trivialAssertion, ["trivial-assertion"]],
    [assertionStrength, ["assertion-weakened", "assertion-deleted", "test-skipped"]],
  ]);
