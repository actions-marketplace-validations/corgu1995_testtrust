// ============================================================================
// src/detectors/overMockingSut.ts
//
// The "over-mocking the subject-under-test" smell.
//
// The trap: a test file named `cart.test.ts` exists to exercise the `cart`
// module — but somewhere up top it does `vi.mock("./cart")`. Now every call
// into `cart` is replaced by an auto-mock, so the test no longer touches the
// real implementation at all. It verifies a fake of its OWN subject: the
// assertions pass no matter what the real `cart` does, and a regression in
// `cart` ships green. That is the worst kind of confidently-useless test.
//
// What we flag: a `vi.mock(...)` / `jest.mock(...)` whose module specifier is
// the SAME module the test is named after.
//
// DESIGN BIAS — PRECISION FIRST (AC3/AC4). This rule feeds a CI gate, so a
// single false positive (which mutes the whole tool) costs far more than a
// missed smell. Every uncertain step therefore resolves toward emitting
// NOTHING:
//
//   * The subject-under-test (SUT) is inferred purely from the file name vs. the
//     import graph. If we cannot pin it to EXACTLY ONE import declaration whose
//     specifier basename matches the test basename, we infer nothing and bail
//     (AC3 — never guess which import is the subject).
//   * We only fire on an EXACT specifier match (after trivial normalization:
//     trim + strip one redundant JS/TS extension). Mocking a *different* module
//     is fine (AC2). A mere basename collision (`./cart` vs `../legacy/cart`) is
//     NOT enough and is deliberately left unflagged.
//   * Severity is always "warn" by default and we NEVER emit "fail" (AC4). The
//     task permits surfacing a fuzzy/basename-only match at "info", but doing so
//     trades away precision for recall; we choose silence over a noisy "info".
//
// This detector is pure & synchronous and walks only the HEAD AST through the
// shared helpers (no hand-rolled traversal, no IO, no AST mutation).
// ============================================================================

import { SyntaxKind } from "ts-morph";
import type { CallExpression, ImportDeclaration, SourceFile } from "ts-morph";

import type { Detector, DetectorMeta, Finding } from "../types.js";
import { getLine, getLineSnippet, getMockUsage, getPosition } from "./shared.js";

/** Static description of the detector (see {@link DetectorMeta}). */
const meta: DetectorMeta = {
  id: "over-mocking-sut",
  title: "Over-mocked subject under test",
  description:
    "The module the test is named after is itself mocked, so the test verifies a fake of its own subject.",
  defaultSeverity: "warn",
  requiresBase: false,
};

/**
 * File-name infixes that mark a file as a test file. Stripped (along with the
 * trailing extension) to recover the "subject" base name: `cart.test.ts` ->
 * `cart`, `cart.spec.tsx` -> `cart`.
 */
const TEST_INFIXES = new Set(["test", "spec"]);

/**
 * Module-specifier / file extensions we treat as redundant when comparing a
 * specifier basename to the test basename, and when normalizing two specifiers
 * for exact equality. Kept deliberately small and explicit so normalization is
 * "trivial" and never collapses two genuinely different modules together.
 *
 * Order matters: the longer ".tsx"/".jsx" forms come before ".ts"/".js" so a
 * single pass never chops ".tsx" down to "x".
 */
const STRIPPABLE_EXTS = [".tsx", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".ts", ".js"];

/**
 * Strip a single trailing JS/TS extension from `s`, if present. Only the first
 * matching extension is removed (specifiers carry at most one).
 */
function stripExt(s: string): string {
  for (const ext of STRIPPABLE_EXTS) {
    if (s.endsWith(ext)) return s.slice(0, s.length - ext.length);
  }
  return s;
}

/**
 * The final path segment of a "/"- or "\\"-separated path, e.g.
 *   "./services/cart" -> "cart"
 *   "../db"           -> "db"
 *   "cart"            -> "cart"
 * Returns "" when the input ends in a separator (no trailing segment). Handles
 * both POSIX and Windows separators so we behave identically regardless of how
 * the test path was supplied.
 */
function basename(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const ch = path[i];
    if (ch === "/" || ch === "\\") {
      return path.slice(i + 1);
    }
  }
  return path;
}

/**
 * Recover the subject base name a test file is named after, or `undefined` when
 * the file does not look like a `*.test.*` / `*.spec.*` test file (in which case
 * we cannot infer a subject and must stay silent).
 *
 *   "/repo/src/cart.test.ts"  -> "cart"
 *   "cart.spec.tsx"           -> "cart"
 *   "foo.bar.test.ts"         -> "foo.bar"
 *   "cart.ts"                 -> undefined   (no .test/.spec infix)
 *   "test.ts"                 -> undefined   (nothing left after stripping)
 *
 * Algorithm: take the file basename, drop its extension, then require the next
 * trailing dotted segment to be exactly `test` or `spec`; what remains is the
 * subject. Comparison is case-insensitive on the infix only.
 */
function inferTestSubjectBase(filePath: string): string | undefined {
  const file = basename(filePath);
  if (file.length === 0) return undefined;

  // Drop the real file extension: "cart.test.ts" -> "cart.test".
  const withoutExt = stripExt(file);

  // The trailing ".test" / ".spec" segment must be present and be the LAST one,
  // and there must be a non-empty subject in front of it.
  const lastDot = withoutExt.lastIndexOf(".");
  if (lastDot <= 0) return undefined; // no infix, or nothing before it
  const infix = withoutExt.slice(lastDot + 1).toLowerCase();
  if (!TEST_INFIXES.has(infix)) return undefined;

  const subject = withoutExt.slice(0, lastDot);
  return subject.length > 0 ? subject : undefined;
}

/**
 * Safely read an import declaration's module specifier string, returning
 * `undefined` if the node is malformed/forgotten. (ts-morph types this as
 * non-optional, but we never let a surprising node crash the run.)
 */
function importSpecifierOf(decl: ImportDeclaration): string | undefined {
  try {
    const value = decl.getModuleSpecifierValue();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Infer the subject-under-test *import specifier* for a test file, or
 * `undefined` when it cannot be pinned down confidently.
 *
 * We match the test file's subject base name (from {@link inferTestSubjectBase})
 * against the basename of every import declaration's module specifier. The SUT
 * specifier is returned ONLY when EXACTLY ONE import matches — zero matches means
 * the subject isn't imported here (nothing to compare), and multiple matches
 * means we cannot tell which import is the real subject. In both ambiguous cases
 * we return `undefined` and the detector stays silent (AC3).
 *
 * Extensions on either side are ignored for the basename comparison (`./cart`
 * and `./cart.js` both match subject "cart"), but the SUT specifier returned is
 * the import's ORIGINAL, unmodified string so the caller can compare it verbatim
 * against the mocked specifier.
 */
function inferSutSpecifier(sourceFile: SourceFile, subjectBase: string): string | undefined {
  let imports: ImportDeclaration[];
  try {
    imports = sourceFile.getImportDeclarations();
  } catch {
    return undefined;
  }

  const target = stripExt(subjectBase).toLowerCase();
  let match: string | undefined;
  for (const decl of imports) {
    const spec = importSpecifierOf(decl);
    if (spec === undefined) continue;
    const specBase = stripExt(basename(spec)).toLowerCase();
    if (specBase.length === 0) continue;
    if (specBase !== target) continue;
    if (match !== undefined && normalizeSpecifier(match) !== normalizeSpecifier(spec)) {
      // Two DIFFERENT imports both resolve to the subject basename (e.g.
      // `./cart` and `../legacy/cart`). We cannot know which is the real
      // subject, so refuse to infer (AC3).
      return undefined;
    }
    match = spec;
  }
  return match;
}

/**
 * Normalize a module specifier for EXACT-equality comparison: trim surrounding
 * whitespace and strip a single redundant JS/TS extension. Intentionally trivial
 * — we do NOT resolve `./` vs `../`, collapse `index`, or canonicalize paths,
 * because any of those could equate two genuinely different modules and produce
 * a false positive. After this, two specifiers are "specifier-equal" iff their
 * normalized strings are identical.
 */
function normalizeSpecifier(spec: string): string {
  return stripExt(spec.trim());
}

/**
 * Identifier names whose presence inside a `vi.mock`/`jest.mock` factory proves
 * the real implementation is still in play, so the mock is a PARTIAL mock rather
 * than a wholesale replacement:
 *
 *   * `importOriginal`            — the helper Vitest passes to the factory; the
 *     dominant pattern spreads `...(await importOriginal())` and overrides a
 *     field or two.
 *   * `importActual`             — `vi.importActual(...)` (the member access
 *     surfaces `importActual` as an identifier regardless of the namespace).
 *   * `requireActual`            — `vi.requireActual` / `jest.requireActual`.
 *
 * Matching on the identifier *name* (not raw source text) keeps us from being
 * fooled by the same word appearing inside a string literal or a comment.
 */
const KEEP_ORIGINAL_REFS = new Set(["importOriginal", "importActual", "requireActual"]);

/**
 * Does the `vi.mock`/`jest.mock` call carry a SECOND argument (a factory) whose
 * body demonstrably brings back the real module — i.e. it references
 * `importOriginal` / `vi.importActual` / `requireActual` (or spreads an awaited
 * `importOriginal()`)? Such a "partial mock" keeps the real implementation and
 * therefore is NOT the over-mocking smell: the real subject code is still
 * exercised, so flagging it would be a false positive.
 *
 * A bare `vi.mock("./cart")` (no factory) and a full-replacement factory that
 * does NOT pull in the original both return `false` and remain flaggable.
 *
 * Defensive: any malformed node resolves to `false` (treat as a plain mock) so a
 * surprising AST can never crash the run.
 */
function factoryKeepsOriginal(call: CallExpression): boolean {
  try {
    const factory = call.getArguments()[1];
    if (factory === undefined) return false; // bare mock — no factory to inspect

    // Fast path: the factory node itself is just an identifier reference (rare
    // but possible, e.g. `vi.mock("./cart", importOriginalFactory)`).
    if (factory.getKind() === SyntaxKind.Identifier && KEEP_ORIGINAL_REFS.has(factory.getText())) {
      return true;
    }

    let keepsOriginal = false;
    factory.forEachDescendant((node, traversal) => {
      if (node.getKind() !== SyntaxKind.Identifier) return;
      if (KEEP_ORIGINAL_REFS.has(node.getText())) {
        keepsOriginal = true;
        traversal.stop();
      }
    });
    return keepsOriginal;
  } catch {
    return false;
  }
}

/**
 * The detector entry point. Pure & synchronous; returns zero findings on any
 * uncertainty.
 *
 * Steps:
 *   1. Infer the subject base name from the file name. Not a test file -> [].
 *   2. Infer the single SUT import specifier. Ambiguous/absent -> [] (AC3).
 *   3. Collect `vi.mock`/`jest.mock` calls via the shared helper.
 *   4. For each mocked specifier that is specifier-EQUAL to the SUT specifier
 *      (AC1), emit ONE "over-mocking-sut" finding at that mock call site, with
 *      the SUT + mocked specifiers in `data`. Different module -> nothing (AC2).
 *      EXCEPT: a partial mock whose factory keeps the real implementation
 *      (`importOriginal` / `importActual` / `requireActual`) is NOT flagged —
 *      the real subject is still exercised (see {@link factoryKeepsOriginal}).
 */
const run: Detector["run"] = (ctx, options) => {
  const subjectBase = inferTestSubjectBase(ctx.filePath);
  if (subjectBase === undefined) return [];

  const sutSpecifier = inferSutSpecifier(ctx.sourceFile, subjectBase);
  if (sutSpecifier === undefined) return [];

  const moduleMocks = getMockUsage(ctx.sourceFile).moduleMocks;
  if (moduleMocks.length === 0) return [];

  const normalizedSut = normalizeSpecifier(sutSpecifier);
  const severity = options.severityOverride ?? meta.defaultSeverity;
  const findings: Finding[] = [];

  for (const mock of moduleMocks) {
    const mocked = mock.specifier;
    if (mocked === undefined) continue; // dynamic specifier — can't compare
    if (normalizeSpecifier(mocked) !== normalizedSut) continue; // AC2: different module

    // Partial mock that keeps the real module (e.g. spreads `importOriginal()`
    // and overrides one export): the real subject is still exercised, so this is
    // NOT the over-mocking smell. Skip it to avoid the dominant false positive.
    if (factoryKeepsOriginal(mock.call)) continue;

    const line = getLine(mock.call);
    if (line === undefined) continue; // can't locate it -> skip rather than guess

    const finding: Finding = {
      ruleId: "over-mocking-sut",
      severity,
      file: ctx.filePath,
      line,
      message: `This test mocks its own subject under test (${mocked}); it exercises a mock instead of the real ${subjectBase} module.`,
      data: { sutSpecifier, mockedSpecifier: mocked },
    };

    // Attach optional fields only when resolvable (exactOptionalPropertyTypes).
    const pos = getPosition(mock.call);
    if (pos !== undefined) finding.column = pos.column;
    const snippet = getLineSnippet(mock.call);
    if (snippet !== undefined) finding.snippet = snippet;

    findings.push(finding);
  }

  return findings;
};

export const detector: Detector = { meta, run };
