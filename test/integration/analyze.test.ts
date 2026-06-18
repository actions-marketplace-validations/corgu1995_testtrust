// ============================================================================
// test/integration/analyze.test.ts
//
// FULL-PIPELINE integration tests for the public `analyze()` entry point
// (src/index.ts -> src/core/analyze.ts). Unlike the per-detector unit tests
// (which feed a synthetic TestFileContext via test/helpers/context.ts), these
// exercise the REAL orchestrator end to end: disk IO, tinyglobby file
// resolution, the ts-morph loader, every registered detector, the per-rule
// enable/severity plumbing, the scorer, and — in diff mode — a real `git`
// subprocess feeding the regression "wedge".
//
// Two scenarios, each on a throwaway temp directory created in beforeAll and
// torn down in afterAll:
//
//   (A) FILES MODE  — a fixture containing a tautology + an assertion-free test.
//       Asserts the orchestrator surfaces those exact ruleIds, the verdict is
//       "neutral" (warn-level smells, no hard fail, score above threshold), and
//       the score dropped below a perfect 100.
//
//   (B) DIFF MODE   — a real git repo whose HEAD weakened a strong assertion
//       (toEqual -> toBeTruthy) AND skipped a previously-running test. Asserts
//       the regression detector emits "assertion-weakened" + "test-skipped" and
//       that the gate verdict reflects the degradation (neutral by default;
//       hard "fail" once the score sinks below a strict threshold).
//
// Robustness notes:
//   * All paths are built with path.join and every git invocation is passed an
//     explicit cwd, so the suite runs on Windows and POSIX alike.
//   * Files mode is fed a *cwd-relative glob* rather than an absolute path:
//     tinyglobby (the resolver analyze() uses) treats a backslash as an escape,
//     so a raw Windows absolute path would silently match nothing. A relative
//     glob + explicit cwd is the portable, reliable form.
//   * Diff mode genuinely needs git. CI has git; if a sandbox somehow does not,
//     the whole diff-mode block self-skips (see `gitAvailable` guard) rather
//     than reporting a spurious failure.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyze } from "../../src/index.js";
import type { CliOptions, Finding, Report, RuleId } from "../../src/types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Build a complete, fully-defaulted {@link CliOptions}. The orchestrator
 * consumes EXACTLY this shape (the cli.ts parser produces it), so a test that
 * forgets a field would otherwise fail to type-check; centralizing the defaults
 * here keeps each test focused on just the knobs it cares about.
 *
 * Defaults are intentionally inert: files mode, no base ref, human-irrelevant
 * formatting off, all rules at their detector defaults, threshold 0 (so the
 * verdict is driven by findings/severity, not by an aggressive gate, unless a
 * test deliberately raises it).
 */
function makeOptions(overrides: Partial<CliOptions> & Pick<CliOptions, "cwd">): CliOptions {
  return {
    mode: "files",
    files: [],
    baseRef: "",
    format: "json",
    failThreshold: 0,
    rules: {},
    onlyChangedTests: false,
    noColor: true,
    quiet: true,
    ...overrides,
  };
}

/** All ruleIds present in a report (sorted for stable comparison). */
function ruleIdsOf(report: Report): RuleId[] {
  return report.findings.map((f) => f.ruleId).sort();
}

/** The first finding for `ruleId`, or undefined. */
function findingFor(report: Report, ruleId: RuleId): Finding | undefined {
  return report.findings.find((f) => f.ruleId === ruleId);
}

/**
 * Run a git subprocess in `cwd`. Uses execFileSync (no shell) so refs/paths are
 * passed as a literal argv with no quoting surface, identical on Windows and
 * POSIX. Throws on non-zero exit, which fails the test loudly (what we want for
 * setup steps).
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Keep git non-interactive and locale-stable, mirroring src/git/gitRunner.ts.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

/** Probe whether a usable `git` exists, so diff-mode can self-skip if not. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// (A) FILES MODE
// ============================================================================

describe("analyze() — files mode (static smells, no base ref)", () => {
  let dir: string;

  // The fixture deliberately contains exactly two distinct, unambiguous smells:
  //   1. a tautology: expect(result).toBe(result)  — same identifier on both
  //      sides => provably self-equal => "tautology" at warn.
  //   2. an assertion-free test: a body with NO assertion and NO helper calls at
  //      all => the detector is fully confident => "assertion-free" at warn
  //      (NOT downgraded to info, which would happen if it delegated to an
  //      unresolvable helper).
  const FIXTURE = [
    "describe('arithmetic', () => {",
    "  it('is internally consistent', () => {",
    "    const result = 2 + 2;",
    "    expect(result).toBe(result);", // tautology (AC2: same identifier)
    "  });",
    "",
    "  it('runs but verifies nothing', () => {",
    "    const value = 41 + 1;", // no assertion, no helper call => confident warn
    "    void value;",
    "  });",
    "});",
    "",
  ].join("\n");

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "testtrust-files-"));
    await writeFile(path.join(dir, "sample.test.ts"), FIXTURE, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("surfaces the tautology and assertion-free smells from a real file on disk", async () => {
    // Feed a cwd-relative glob (portable) rather than a backslashed absolute
    // path, which tinyglobby would treat as an escape and silently not match.
    const report = await analyze(makeOptions({ mode: "files", files: ["**/*.test.ts"], cwd: dir }));

    expect(report.mode).toBe("files");
    // No base ref in files mode — the orchestrator records null, and the
    // base-requiring regression detector must NOT have run.
    expect(report.baseRef).toBeNull();

    const ids = ruleIdsOf(report);
    expect(ids).toContain("tautology");
    expect(ids).toContain("assertion-free");
    // Regression ("wedge") rules require a base ref and must be absent here.
    expect(ids).not.toContain("assertion-weakened");
    expect(ids).not.toContain("assertion-deleted");
    expect(ids).not.toContain("test-skipped");
  });

  it("renders the verdict as neutral with a score below 100", async () => {
    const report = await analyze(makeOptions({ mode: "files", files: ["**/*.test.ts"], cwd: dir }));

    // Both smells are warn-level (no detector emitted a hard "fail" severity),
    // and the score stays above the failThreshold (0), so by the frozen
    // convention the gate lands on "neutral" — flag, don't block.
    expect(report.score.verdict).toBe("neutral");
    expect(report.score.countsBySeverity.fail).toBe(0);
    expect(report.score.countsBySeverity.warn).toBeGreaterThanOrEqual(2);

    // Smells were found, so a perfect score is impossible; the score is a real
    // 0–100 integer strictly under 100.
    expect(report.score.score).toBeLessThan(100);
    expect(report.score.score).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(report.score.score)).toBe(true);
  });

  it("locates each finding precisely (right rule, right file, right line)", async () => {
    const report = await analyze(makeOptions({ mode: "files", files: ["**/*.test.ts"], cwd: dir }));

    const taut = findingFor(report, "tautology");
    expect(taut).toBeDefined();
    // Paths are presented cwd-relative with forward slashes, stable across OSes.
    expect(taut!.file).toBe("sample.test.ts");
    expect(taut!.severity).toBe("warn");
    // The tautology is on line 4 of the fixture (1-based).
    expect(taut!.line).toBe(4);
    expect(taut!.data).toMatchObject({ matcher: "toBe" });

    const free = findingFor(report, "assertion-free");
    expect(free).toBeDefined();
    expect(free!.file).toBe("sample.test.ts");
    // No unresolvable helper call in the body => confident warn, not info.
    expect(free!.severity).toBe("warn");
  });

  it("respects per-rule disabling: turning off `tautology` drops only that finding", async () => {
    const report = await analyze(
      makeOptions({
        mode: "files",
        files: ["**/*.test.ts"],
        cwd: dir,
        rules: { tautology: { enabled: false } },
      }),
    );

    const ids = ruleIdsOf(report);
    expect(ids).not.toContain("tautology");
    // The unrelated smell is untouched.
    expect(ids).toContain("assertion-free");
  });

  it("respects per-rule severity override: escalating a smell to `fail` flips the gate", async () => {
    const report = await analyze(
      makeOptions({
        mode: "files",
        files: ["**/*.test.ts"],
        cwd: dir,
        rules: { tautology: { enabled: true, severity: "fail" } },
      }),
    );

    const taut = findingFor(report, "tautology");
    expect(taut).toBeDefined();
    expect(taut!.severity).toBe("fail");
    // Any single "fail" finding dominates the verdict regardless of score.
    expect(report.score.verdict).toBe("fail");
  });
});

// ============================================================================
// (B) DIFF MODE — the regression "wedge"
// ============================================================================

const gitAvailable = hasGit();
const describeDiff = gitAvailable ? describe : describe.skip;

describeDiff("analyze() — diff mode (regression vs. a git base ref)", () => {
  let repo: string;
  // Repo-relative POSIX path the findings will report against (git emits
  // forward slashes on every OS, and the orchestrator preserves them).
  const REL_TEST = "s/x.test.ts";

  // BASE: two strong, real assertions.
  const BASE_SRC = [
    "describe('widget', () => {",
    "  it('computes the sum', () => {",
    "    const result = add(2, 3);",
    "    expect(result).toEqual(5);", // strong (tier 4, structural)
    "  });",
    "",
    "  it('keeps the flag on', () => {",
    "    const flag = isEnabled();",
    "    expect(flag).toBe(true);", // running test that guards something
    "  });",
    "});",
    "",
  ].join("\n");

  // HEAD: the SAME two tests, degraded two different ways so the skip and the
  // weakening land on DIFFERENT tests (the regression detector short-circuits a
  // skipped test, so weakening must live on a still-running one):
  //   * 'computes the sum'  : toEqual(5)  ->  toBeTruthy()   (tier 4 -> tier 1)
  //   * 'keeps the flag on' : it(...)     ->  it.skip(...)   (was running, now not)
  const HEAD_SRC = [
    "describe('widget', () => {",
    "  it('computes the sum', () => {",
    "    const result = add(2, 3);",
    "    expect(result).toBeTruthy();", // WEAKENED matcher
    "  });",
    "",
    "  it.skip('keeps the flag on', () => {", // SKIPPED test
    "    const flag = isEnabled();",
    "    expect(flag).toBe(true);",
    "  });",
    "});",
    "",
  ].join("\n");

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "testtrust-diff-"));

    // Deterministic, isolated repo: fixed identity, no signing, default branch
    // "main" so HEAD~1 is well-defined after two commits.
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "tester@testtrust.invalid"]);
    git(repo, ["config", "user.name", "Testtrust CI"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    const absTestPath = path.join(repo, "s", "x.test.ts");
    await mkdir(path.dirname(absTestPath), { recursive: true });

    // Commit 1 (HEAD~1): the strong base.
    await writeFile(absTestPath, BASE_SRC, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base: strong assertions, both tests running"]);

    // Commit 2 (HEAD): the degradation.
    await writeFile(absTestPath, HEAD_SRC, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "regress: weaken one assertion, skip another test"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("emits both an assertion-weakened and a test-skipped finding against the base ref", async () => {
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD~1", cwd: repo, failThreshold: 60 }),
    );

    expect(report.mode).toBe("diff");
    expect(report.baseRef).toBe("HEAD~1");

    const ids = ruleIdsOf(report);
    expect(ids).toContain("assertion-weakened");
    expect(ids).toContain("test-skipped");
  });

  it("captures the exact matcher downgrade in the assertion-weakened finding", async () => {
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD~1", cwd: repo, failThreshold: 60 }),
    );

    const weakened = findingFor(report, "assertion-weakened");
    expect(weakened).toBeDefined();
    expect(weakened!.file).toBe(REL_TEST);
    expect(weakened!.severity).toBe("warn");
    expect(weakened!.testName).toBe("widget > computes the sum");
    // Structured detail the JSON consumers rely on: the before/after matchers
    // and the paired subject.
    expect(weakened!.data).toMatchObject({
      baseMatcher: "toEqual",
      headMatcher: "toBeTruthy",
      subject: "result",
    });
  });

  it("attributes the test-skipped finding to the right (previously-running) test", async () => {
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD~1", cwd: repo, failThreshold: 60 }),
    );

    const skipped = findingFor(report, "test-skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.file).toBe(REL_TEST);
    expect(skipped!.severity).toBe("warn");
    expect(skipped!.testName).toBe("widget > keeps the flag on");
  });

  it("reflects the degradation in the gate: neutral by default, with a dented score", async () => {
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD~1", cwd: repo, failThreshold: 60 }),
    );

    // Warn-level wedge findings present, score still above the (lenient) 60
    // threshold => "neutral": a visible signal that the change regressed, even
    // though it isn't hard-blocked at this threshold.
    expect(report.score.verdict).toBe("neutral");
    expect(report.score.countsBySeverity.warn).toBeGreaterThanOrEqual(2);

    // The heavy wedge penalties (assertion-weakened = 16, test-skipped = 10)
    // dent the score well below a perfect 100.
    expect(report.score.score).toBeLessThan(100);
    expect(report.score.score).toBeGreaterThan(0);

    // The breakdown attributes points to the two wedge rules explicitly.
    const weakenedBreakdown = report.score.breakdown.find((b) => b.ruleId === "assertion-weakened");
    const skippedBreakdown = report.score.breakdown.find((b) => b.ruleId === "test-skipped");
    expect(weakenedBreakdown?.penalty).toBe(16);
    expect(skippedBreakdown?.penalty).toBe(10);
  });

  it("hard-fails the gate once the score drops below a strict threshold", async () => {
    // Same degradation, but a demanding threshold (90). The dented score now
    // sinks below it, so the verdict escalates from "neutral" to "fail" — the
    // regression is gateable in CI.
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD~1", cwd: repo, failThreshold: 90 }),
    );

    expect(report.score.score).toBeLessThan(90);
    expect(report.score.verdict).toBe("fail");
  });

  it("treats an unchanged tree (HEAD vs HEAD) as a clean pass — the wedge only fires on real regressions", async () => {
    // Diffing HEAD against itself yields no changed files, hence no findings:
    // the regression detector never manufactures a smell where nothing changed.
    const report = await analyze(
      makeOptions({ mode: "diff", baseRef: "HEAD", cwd: repo, failThreshold: 60 }),
    );

    expect(report.findings).toHaveLength(0);
    expect(report.score.score).toBe(100);
    expect(report.score.verdict).toBe("pass");
  });
});
