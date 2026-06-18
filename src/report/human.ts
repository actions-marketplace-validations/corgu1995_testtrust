// ============================================================================
// src/report/human.ts
//
// The HUMAN reporter. Turns a finished {@link Report} into the colourised,
// developer-facing text block the CLI writes to stdout.
//
// CONTRACT: this module is PURE. `renderHuman` takes a Report (+ a noColor
// knob) and returns a string. It performs NO IO — no stdout, no fs, no
// process.* — so it is trivially snapshot-testable and the CLI stays the only
// thing that touches the terminal. It is a REPORTER, not a detector: it never
// inspects an AST or recomputes a score; it only formats what the scorer and
// detectors already decided.
//
// Output shape (one blank line separates header block from findings):
//
//   testtrust  v0.1.0
//   Score: 72/100   Verdict: NEUTRAL   (fail under 60)
//   Analyzed 3 files · 5 findings (1 fail · 3 warn · 1 info)
//
//   src/foo.test.ts:12  warn  assertion-free
//     Test "does a thing" has no assertions.
//       12 | it("does a thing", () => { doThing(); });
//          |                          ^
//   ...
//
// Findings are grouped BY FILE in first-appearance order; within a file they
// are sorted by line ascending. Zero findings prints the header + a single
// green "No test-trust issues found." line.
// ============================================================================
import type { Report, Finding, Severity, Verdict } from "../types.js";
import pc from "picocolors";

// ----------------------------------------------------------------------------
// Colour palette
// ----------------------------------------------------------------------------

/**
 * The exact subset of picocolors formatters this reporter uses. We depend on a
 * `Colors`-shaped object so we can swap in a no-op palette (`createColors(false)`)
 * for `--no-color` and keep every call-site colour-agnostic.
 */
type Palette = ReturnType<typeof pc.createColors>;

/**
 * Resolve the active palette. `createColors(false)` returns formatters that are
 * the identity function, so gating happens in ONE place and the render code
 * below never has to branch on `noColor`.
 */
function palette(noColor: boolean): Palette {
  return pc.createColors(!noColor);
}

// ----------------------------------------------------------------------------
// Small mappers (verdict + severity -> colour)
// ----------------------------------------------------------------------------

/** Colour a verdict label: fail=red, neutral=yellow, pass=green. */
function colorVerdict(verdict: Verdict, c: Palette): string {
  const label = verdict.toUpperCase();
  switch (verdict) {
    case "fail":
      return c.red(c.bold(label));
    case "neutral":
      return c.yellow(c.bold(label));
    case "pass":
      return c.green(c.bold(label));
    default:
      // Exhaustiveness guard: if a new Verdict is added, this keeps compiling
      // and still prints something sensible rather than silently dropping it.
      return label;
  }
}

/**
 * Colour a severity token to match the verdict palette family:
 *   fail -> red, warn -> yellow, info -> blue/cyan-ish (dim blue).
 * The colours are intentionally the same hues used for the verdict so a "fail"
 * finding reads as red wherever it appears.
 */
function colorSeverity(severity: Severity, c: Palette): string {
  switch (severity) {
    case "fail":
      return c.red(severity);
    case "warn":
      return c.yellow(severity);
    case "info":
      return c.blue(severity);
    default:
      return severity;
  }
}

// ----------------------------------------------------------------------------
// Grouping
// ----------------------------------------------------------------------------

/** A file and its findings, ready to render. */
interface FileGroup {
  file: string;
  findings: Finding[];
}

/**
 * Group findings BY FILE, preserving first-appearance order of files, and sort
 * each file's findings by line ascending (stable for equal lines via the
 * original index, so column/rule order from the producer is preserved).
 *
 * Pure: does not mutate `report.findings` — it copies before sorting.
 */
function groupByFile(findings: readonly Finding[]): FileGroup[] {
  // Map preserves insertion order, giving us "first-appearance" file ordering.
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = groups.get(finding.file);
    if (bucket) bucket.push(finding);
    else groups.set(finding.file, [finding]);
  }

  const out: FileGroup[] = [];
  for (const [file, list] of groups) {
    // Sort a copy by line asc; ties keep producer order (stable sort in V8).
    const sorted = [...list].sort((a, b) => a.line - b.line);
    out.push({ file, findings: sorted });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Pluralisation helper (counts line)
// ----------------------------------------------------------------------------

/** "1 file" / "3 files" — tiny English pluraliser for the summary line. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ----------------------------------------------------------------------------
// Snippet + caret rendering
// ----------------------------------------------------------------------------

/**
 * Render the optional source-excerpt lines for a finding:
 *
 *       12 | it("x", () => {})
 *          |    ^
 *
 * Returns an array of fully-built lines (already indented). Empty when the
 * finding carries no snippet.
 *
 * The gutter shows the 1-based line number right-padded to align with the
 * pipe. The caret line is only added when `column` is known; the caret is
 * placed under the column, accounting for the fact that {@link Finding.snippet}
 * is trimmed of leading whitespace by the producer (so a raw source column must
 * be shifted left by the amount of indentation that was stripped). We can't
 * recover the exact stripped width from a trimmed snippet, so we clamp the
 * caret into the snippet's bounds and, in the common case, line it up with the
 * first non-space character.
 */
function renderSnippet(finding: Finding, c: Palette): string[] {
  const snippet = finding.snippet;
  if (snippet === undefined || snippet.length === 0) return [];

  const lineNo = String(finding.line);
  const indent = "      "; // 6 spaces: snippet sits one nesting level under the message.
  const lines: string[] = [];

  // Snippet line: "      <n> | <code>".
  lines.push(`${indent}${c.dim(`${lineNo} | `)}${snippet}`);

  // Caret line only when we have a column to point at. The caret-line gutter
  // matches the code gutter's WIDTH (spaces where the digits were) so the pipe
  // aligns; then `caretIndex` spaces position the caret under the offending
  // column within the snippet.
  if (typeof finding.column === "number" && finding.column >= 1) {
    const caretIndex = caretOffsetInSnippet(snippet, finding.column);
    const blankGutter = `${" ".repeat(lineNo.length)} | `;
    const caret = `${" ".repeat(caretIndex)}${c.red("^")}`;
    lines.push(`${indent}${c.dim(blankGutter)}${caret}`);
  }

  return lines;
}

/**
 * Best-effort mapping of a 1-based source `column` onto an index into the
 * (leading-trimmed) snippet string.
 *
 * The producer trims leading whitespace off the snippet, so a raw column C in
 * the original line maps to `C - 1 - strippedLeading`. We don't know
 * `strippedLeading` exactly, but we DO know the snippet has no leading spaces,
 * so we estimate the strip as "(original indentation)". In practice we clamp:
 *   - lower bound 0,
 *   - upper bound the snippet length (so the caret never runs past the code).
 * When the raw column lands within the snippet as-is we use it directly; this
 * is correct for un-indented lines and a sane approximation otherwise.
 */
function caretOffsetInSnippet(snippet: string, column: number): number {
  const zeroBased = column - 1;
  if (zeroBased <= 0) return 0;
  if (zeroBased >= snippet.length) return Math.max(0, snippet.length - 1);
  return zeroBased;
}

// ----------------------------------------------------------------------------
// Header
// ----------------------------------------------------------------------------

/**
 * Build the three header lines (title, score/verdict, counts). Returned as an
 * array of lines so the caller controls the trailing blank line.
 */
function renderHeader(report: Report, fileCount: number, c: Palette): string[] {
  const { version, score } = report;

  const title = `${c.bold("testtrust")}  ${c.dim(`v${version}`)}`;

  const scoreLine =
    `Score: ${c.bold(`${score.score}/100`)}` +
    `   Verdict: ${colorVerdict(score.verdict, c)}` +
    `   ${c.dim(`(fail under ${score.failThreshold})`)}`;

  // Counts read "<n> <severity>", e.g. "1 fail · 3 warn · 1 info", with the
  // severity word coloured to its palette family.
  const counts = score.countsBySeverity;
  const countsLine =
    `Analyzed ${plural(fileCount, "file")} · ` +
    `${plural(score.totalFindings, "finding")} ` +
    `(${counts.fail} ${colorSeverity("fail", c)} · ` +
    `${counts.warn} ${colorSeverity("warn", c)} · ` +
    `${counts.info} ${colorSeverity("info", c)})`;

  return [title, scoreLine, countsLine];
}

// ----------------------------------------------------------------------------
// Per-finding block
// ----------------------------------------------------------------------------

/**
 * Render one finding as its location/severity/rule line, the message line, and
 * (optionally) the snippet + caret lines.
 *
 *   src/foo.test.ts:12  warn  assertion-free
 *     Test "x" has no assertions.
 *       12 | it("x", () => {})
 *          |    ^
 */
function renderFinding(finding: Finding, c: Palette): string[] {
  const location = `${finding.file}:${finding.line}`;
  const severity = colorSeverity(finding.severity, c);
  const ruleId = c.dim(c.cyan(finding.ruleId));

  const headLine = `${location}  ${severity}  ${ruleId}`;
  const messageLine = `  ${finding.message}`;

  return [headLine, messageLine, ...renderSnippet(finding, c)];
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Render a {@link Report} as the human-readable terminal block.
 *
 * @param report   the finished report from the analyzer.
 * @param options  `noColor: true` strips all ANSI (for pipes / `--no-color`).
 * @returns the full multi-line string (no trailing newline added; the CLI
 *          decides how to write it).
 */
export function renderHuman(report: Report, options: { noColor: boolean }): string {
  const c = palette(options.noColor);

  const groups = groupByFile(report.findings);
  // "Analyzed N files" uses the count of distinct files that have findings,
  // which is the only file cardinality the Report exposes (filesAnalyzed lives
  // on ScoreInput, not Report). Acceptable for v1 per the spec.
  const fileCount = groups.length;

  const lines: string[] = [...renderHeader(report, fileCount, c)];

  // Zero findings: header + a single green all-clear line.
  if (report.findings.length === 0) {
    lines.push("");
    lines.push(c.green("No test-trust issues found."));
    return lines.join("\n");
  }

  // Blank line between the header block and the findings.
  lines.push("");

  groups.forEach((group, index) => {
    for (const finding of group.findings) {
      lines.push(...renderFinding(finding, c));
    }
    // Blank line between file groups (but not after the last one).
    if (index < groups.length - 1) lines.push("");
  });

  return lines.join("\n");
}
