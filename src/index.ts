// Public programmatic API. The CLI is a thin wrapper over analyze().
export { analyze } from "./core/analyze.js";
export type {
  CliOptions,
  Report,
  Finding,
  ScoreResult,
  RuleId,
  Severity,
  Verdict,
  DetectorMeta,
  Detector,
} from "./types.js";
