// ============================================================================
// src/detectors/assertionFree.ts
//
// The "assertion-free / snapshot-only" detector.
//
// It flags two distinct, closely-related smells on individual test cases
// (`it(...)` / `test(...)` with a real body):
//
//   * assertion-free ("assertion-free", warn): the test body makes NO real
//     assertion at all — neither an `expect(...).matcher(...)` chain nor a
//     `node:assert` call. Such a test is green by construction: it can never
//     fail no matter how broken the code under test is.
//
//   * snapshot-only ("snapshot-only", warn): the test's ONLY assertions are
//     `toMatchSnapshot()` / `toMatchInlineSnapshot()` and nothing else. Snapshot
//     assertions are notoriously low-signal (they pass on first run by
//     definition, and reviewers rubber-stamp the auto-generated blob), so a test
//     whose entire verification budget is one snapshot is barely better than
//     assertion-free. If the test ALSO has any concrete non-snapshot assertion,
//     it is NOT flagged — the snapshot is then just supplementary.
//
// DESIGN BIAS (precision over recall — a single false positive mutes the whole
// tool): every ambiguous case is resolved toward emitting nothing or, at most,
// downgrading to "info". In particular, a test that does not assert directly but
// delegates to a LOCAL helper which itself asserts (a common, legitimate
// pattern) must NOT be hard-flagged. We do a best-effort, syntax-only, in-file
// resolution of such helpers: if a helper resolves in-file and asserts, we stay
// quiet; if the test delegates to a helper we CANNOT resolve in-file (e.g. an
// imported one), we emit "info" (low confidence) rather than "warn"; a body that
// makes no assertion and only calls helpers we CAN see (none of which assert),
// or calls no helper at all, earns a confident full "warn".
//
// This module is a Detector: pure, synchronous, no IO, no AST mutation, no
// reading of other files. It walks ONLY the HEAD ast via the shared helpers.
// ============================================================================

import { SyntaxKind } from "ts-morph";
import type { Node, SourceFile } from "ts-morph";

import type {
  Detector,
  DetectorMeta,
  DetectorRunOptions,
  Finding,
  Severity,
} from "../types.js";

import {
  getAssertions,
  getLineSnippet,
  getPosition,
  getTestBlocks,
  hasRealAssertion,
  hasTypeLevelAssertion,
} from "./shared.js";
import type { TestBlock } from "./shared.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** Snapshot matcher names. A test whose ONLY assertions are these is
 *  "snapshot-only". Kept as a set so the membership test reads clearly. */
const SNAPSHOT_MATCHERS: ReadonlySet<string> = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
]);

/** Callee names that are assertions themselves, never "helpers" for AC4. We
 *  exclude these when collecting candidate in-file helper calls so we don't
 *  treat `expect(...)` / `assert(...)` as a helper to resolve. */
const ASSERTION_CALLEES: ReadonlySet<string> = new Set(["expect", "assert", "strict"]);

/**
 * Name-prefix vocabulary for a method that PLAUSIBLY asserts internally. Used to
 * judge an *unresolved* member call (`obj.method(...)`): we cannot see the
 * method body (it lives on an imported/declared type, not as an in-file
 * function), so we treat a method whose name reads like an assertion —
 * `harness.assertRejected(p)`, `page.shouldShowError()`, `ctx.expectStatus(200)`
 * — as a possibly-asserting helper and downgrade the finding to "info" rather
 * than risk a confident, false "warn". Deliberately conservative: a plain
 * mutation like `arr.push(1)` / `obj.doThing()` does NOT match, so a body whose
 * only member calls are obviously non-asserting still earns a full "warn". */
const ASSERTING_METHOD_PREFIXES: readonly string[] = [
  "assert",
  "expect",
  "should",
  "verify",
  "ensure",
  "check",
  "must",
];

/** Does a method name read like it could assert? Case-insensitive prefix match
 *  against {@link ASSERTING_METHOD_PREFIXES} (so `assertRejected`, `ASSERT`,
 *  `shouldShowError`, `expectStatus` all qualify). Never throws. */
function looksLikeAssertingMethod(name: string): boolean {
  const lower = name.toLowerCase();
  return ASSERTING_METHOD_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** How deep we follow helper -> helper chains when resolving an in-file helper
 *  assertion. One hop satisfies the AC; we allow a couple more (guarded) so a
 *  thin wrapper-of-a-wrapper still resolves, without risking runaway recursion. */
const MAX_HELPER_DEPTH = 4;

// ----------------------------------------------------------------------------
// Meta
// ----------------------------------------------------------------------------

const meta: DetectorMeta = {
  id: "assertion-free",
  title: "Assertion-free / snapshot-only test",
  description:
    "Flags tests that make no real assertion, or whose only assertion is a snapshot.",
  defaultSeverity: "warn",
  requiresBase: false,
};

// ----------------------------------------------------------------------------
// Helper resolution (AC4) — best-effort, syntax-only, never throws
// ----------------------------------------------------------------------------

/**
 * Collect the names of plain identifier-call callees inside `scope` that could
 * be local helper functions (i.e. `foo(...)`, NOT `obj.foo(...)`, and NOT the
 * assertion entrypoints `expect`/`assert`/`strict`). Deduplicated, source-order.
 *
 * We restrict to bare-identifier callees on purpose: a member call like
 * `ns.foo()` cannot be a top-level in-file function declaration, so resolving it
 * would be guesswork. Never throws.
 */
function collectHelperCallNames(scope: Node | undefined): string[] {
  if (scope === undefined) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  try {
    scope.forEachDescendant((node) => {
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call === undefined) return;
      // Only bare `foo(...)` — the callee must be a plain identifier.
      const callee = call.getExpression();
      const id = callee.asKind(SyntaxKind.Identifier);
      if (id === undefined) return;
      const name = id.getText();
      if (ASSERTION_CALLEES.has(name)) return;
      if (seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
  } catch {
    // return whatever we collected
  }
  return names;
}

/**
 * Does `scope` contain at least one UNRESOLVED member call that plausibly
 * asserts — i.e. `obj.method(...)` / `this.method(...)` where `method` reads
 * like an assertion (see {@link looksLikeAssertingMethod})?
 *
 * This is the member-call analogue of the unresolvable-bare-helper signal: such
 * a method may assert internally (its body is on an imported harness/page-object
 * type we cannot see), so when the body otherwise has no assertion we must not
 * emit a confident "warn". We only consider a SIMPLE receiver (a bare identifier
 * or `this`), matching the `obj.method(...)` shape the AC describes; deeper
 * chains like `a.b.c(...)` or an `expect(x).foo()` chain segment are ignored so
 * we don't guess. Never throws.
 */
function hasPlausiblyAssertingMemberCall(scope: Node | undefined): boolean {
  if (scope === undefined) return false;
  let found = false;
  try {
    scope.forEachDescendant((node, traversal) => {
      if (found) {
        traversal.stop();
        return;
      }
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call === undefined) return;
      const pae = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
      if (pae === undefined) return;
      // Receiver must be a simple identifier (`obj`) or `this` — the plain
      // `obj.method(...)` shape. Anything more complex is not our concern here.
      const receiver = pae.getExpression();
      const isSimpleReceiver =
        receiver.asKind(SyntaxKind.Identifier) !== undefined ||
        receiver.getKind() === SyntaxKind.ThisKeyword;
      if (!isSimpleReceiver) return;
      const methodName = pae.getName();
      if (looksLikeAssertingMethod(methodName)) {
        found = true;
        traversal.stop();
      }
    });
  } catch {
    // return whatever we determined
  }
  return found;
}

/**
 * Find the callable body of a same-file definition for `name`:
 *   - a top-level (or nested) `function name(...) { ... }` declaration, or
 *   - a `const name = (...) => ...` / `const name = function (...) { ... }`.
 *
 * Returns the body node (a `Block` or an arrow's expression body) to be scanned
 * for assertions, or `undefined` when no usable definition is found in-file.
 *
 * We scan descendants of the source file ourselves (rather than relying on typed
 * `getFunction`/`getVariableDeclaration` convenience accessors) to stay robust
 * across ts-morph versions and to never throw. The FIRST matching definition in
 * source order wins; that is good enough for the best-effort guarantee the AC
 * asks for. Never throws.
 */
function resolveInFileHelperBody(
  sourceFile: SourceFile,
  name: string,
): Node | undefined {
  try {
    let found: Node | undefined;
    sourceFile.forEachDescendant((node, traversal) => {
      if (found !== undefined) {
        traversal.stop();
        return;
      }

      // `function name(...) { ... }`
      const fn = node.asKind(SyntaxKind.FunctionDeclaration);
      if (fn) {
        const nameNode = fn.getNameNode();
        if (nameNode !== undefined && nameNode.getText() === name) {
          found = safeFunctionBody(fn);
          if (found !== undefined) {
            traversal.stop();
            return;
          }
        }
        return;
      }

      // `const name = <arrow|function expression>`
      const varDecl = node.asKind(SyntaxKind.VariableDeclaration);
      if (varDecl) {
        const nameNode = varDecl.getNameNode();
        // Only a simple identifier binding can be a callable helper by name.
        if (nameNode.getKind() !== SyntaxKind.Identifier) return;
        if (nameNode.getText() !== name) return;
        const init = varDecl.getInitializer();
        const body = functionLikeBody(init);
        if (body !== undefined) {
          found = body;
          traversal.stop();
        }
      }
    });
    return found;
  } catch {
    return undefined;
  }
}

/** Body of an arrow / function expression initializer, or `undefined`. */
function functionLikeBody(node: Node | undefined): Node | undefined {
  if (node === undefined) return undefined;
  const arrow = node.asKind(SyntaxKind.ArrowFunction);
  if (arrow) {
    try {
      return arrow.getBody();
    } catch {
      return undefined;
    }
  }
  const fn = node.asKind(SyntaxKind.FunctionExpression);
  if (fn) return safeFunctionBody(fn);
  return undefined;
}

/** Body block of a function declaration/expression, never throwing. */
function safeFunctionBody(
  fn: { getBody(): Node | undefined },
): Node | undefined {
  try {
    return fn.getBody();
  } catch {
    return undefined;
  }
}

/**
 * Best-effort analysis of the bare helper calls a test body makes, when the body
 * has no direct assertion of its own.
 *
 * We look at every bare `foo(...)` call in `body`, resolve each to its in-file
 * definition, and (transitively, up to {@link MAX_HELPER_DEPTH}) check whether
 * that definition contains a real assertion. Two facts come out of the walk:
 *
 *   - assertsViaHelper: at least one helper RESOLVED in-file AND contained a real
 *     assertion => the test is legitimately covered; we must NOT flag it at all.
 *
 *   - hadUnresolvableHelper: at least one bare helper call could NOT be resolved
 *     to an in-file definition (e.g. it is imported, or otherwise out of view).
 *     This is the ONLY thing that downgrades an otherwise-vacuous test to "info":
 *     we cannot see the helper's body, so we cannot be confident the test is
 *     truly assertion-free. A helper that DOES resolve in-file but happens not to
 *     assert leaves the test a genuine, confident assertion-free "warn".
 *
 * Never throws.
 */
interface HelperVerdict {
  assertsViaHelper: boolean;
  hadUnresolvableHelper: boolean;
}

function analyzeHelpers(sourceFile: SourceFile, body: Node): HelperVerdict {
  const verdict: HelperVerdict = {
    assertsViaHelper: false,
    hadUnresolvableHelper: false,
  };
  const topLevelNames = collectHelperCallNames(body);
  if (topLevelNames.length === 0) return verdict;

  // Walk helpers with a visited-set guard against cycles/recursion, accumulating
  // both signals as we go.
  const visited = new Set<string>();
  walkHelpers(sourceFile, topLevelNames, visited, MAX_HELPER_DEPTH, verdict);
  return verdict;
}

/**
 * Resolve each helper in `names` (and, within `depthLeft` hops, the helpers it
 * itself calls), updating `verdict`:
 *   - sets `assertsViaHelper` once a resolved helper body contains an assertion;
 *   - sets `hadUnresolvableHelper` whenever a name fails to resolve in-file.
 *
 * `visited` prevents re-walking the same helper (and breaks recursion cycles).
 * The walk short-circuits as soon as `assertsViaHelper` is established, since
 * that alone suppresses any finding. Never throws.
 */
function walkHelpers(
  sourceFile: SourceFile,
  names: readonly string[],
  visited: Set<string>,
  depthLeft: number,
  verdict: HelperVerdict,
): void {
  if (depthLeft <= 0) return;
  for (const name of names) {
    if (verdict.assertsViaHelper) return; // nothing else can change the outcome
    if (visited.has(name)) continue;
    visited.add(name);

    const helperBody = resolveInFileHelperBody(sourceFile, name);
    if (helperBody === undefined) {
      // We cannot see this helper's body — could be asserting, could not.
      verdict.hadUnresolvableHelper = true;
      continue;
    }

    if (hasRealAssertion(helperBody)) {
      verdict.assertsViaHelper = true;
      return;
    }

    // Resolved but didn't assert directly: follow one level deeper into the
    // helpers IT calls (a thin wrapper delegating to another local helper).
    const nested = collectHelperCallNames(helperBody);
    if (nested.length > 0) {
      walkHelpers(sourceFile, nested, visited, depthLeft - 1, verdict);
    }
  }
}

// ----------------------------------------------------------------------------
// Finding construction
// ----------------------------------------------------------------------------

/** Resolve the `testName` from a block's title path, when available. */
function testNameOf(block: TestBlock): string | undefined {
  // Prefer the full describe>it path; fall back to the bare title. Only emit a
  // name when at least one real (non-placeholder) segment exists.
  const path = block.titlePath.filter((seg) => seg !== "<dynamic>");
  if (path.length > 0) return path.join(" > ");
  return block.title;
}

/**
 * Build a Finding for a test block, reported at `reportNode`. Honors
 * exactOptionalPropertyTypes by OMITTING optional keys we don't have rather than
 * assigning `undefined`.
 */
function makeFinding(
  ruleId: "assertion-free" | "snapshot-only",
  severity: Severity,
  filePath: string,
  reportNode: Node,
  message: string,
  block: TestBlock,
): Finding | undefined {
  const pos = getPosition(reportNode);
  // Without a resolvable position we cannot place the finding; emit nothing
  // rather than guess a line (precision first).
  if (pos === undefined) return undefined;

  const finding: Finding = {
    ruleId,
    severity,
    file: filePath,
    line: pos.line,
    message,
  };

  if (pos.column !== undefined) finding.column = pos.column;

  const snippet = getLineSnippet(reportNode);
  if (snippet !== undefined && snippet.length > 0) finding.snippet = snippet;

  const testName = testNameOf(block);
  if (testName !== undefined) finding.testName = testName;

  return finding;
}

// ----------------------------------------------------------------------------
// Core run
// ----------------------------------------------------------------------------

function run(
  ctx: { sourceFile: SourceFile; filePath: string },
  options: DetectorRunOptions,
): Finding[] {
  const findings: Finding[] = [];
  const blocks = getTestBlocks(ctx.sourceFile);

  for (const block of blocks) {
    // Only individual test cases (`it` / `test`). `describe` suites group other
    // tests and are never themselves assertion-free.
    if (block.isSuite) continue;

    // A test with NO body (e.g. `it.todo("…")`, or a malformed call) is not
    // "assertion-free" — there is no implementation to judge. Ignore it.
    const body = block.body;
    if (body === undefined) continue;

    const finding = classifyTest(ctx, options, block, body);
    if (finding !== undefined) findings.push(finding);
  }

  return findings;
}

/**
 * Decide which (if any) finding a single test case earns. Returns at most one
 * finding — a test is either assertion-free, snapshot-only, or fine.
 */
function classifyTest(
  ctx: { sourceFile: SourceFile; filePath: string },
  options: DetectorRunOptions,
  block: TestBlock,
  body: Node,
): Finding | undefined {
  const assertions = getAssertions(body);

  // ----- Case A: the body has NO real RUNTIME assertion at all ------------
  if (assertions.length === 0) {
    // A TYPE-LEVEL test (`util.assertEqual<A, B>(true)`, `expectTypeOf(x)
    // .toEqualTypeOf<T>()`, a `type v = Expect<Equal<A, B>>` alias, or a
    // `@ts-expect-error` line) asserts at COMPILE time and so has no runtime
    // assertion — but it is a legitimate test, not assertion-free. Emit nothing.
    if (hasTypeLevelAssertion(body)) return undefined;

    // AC4: maybe it asserts through a local helper. Resolve best-effort.
    const helper = analyzeHelpers(ctx.sourceFile, body);

    // The test legitimately asserts via a RESOLVABLE in-file helper => never
    // flag (not even info). This is the load-bearing precision guard.
    if (helper.assertsViaHelper) return undefined;

    // Two independent reasons to be UNSURE the test is truly assertion-free, each
    // of which downgrades the otherwise-confident "warn" to a low-confidence
    // "info" (we cannot see the callee's body, so it might assert internally):
    //   1. it delegates to a bare helper we could not resolve in-file (imported);
    //   2. it makes an UNRESOLVED member call whose name reads like an assertion
    //      (`harness.assertRejected(p)`, `page.shouldShowError()`) — such a method
    //      may assert internally just like an unresolved bare helper.
    // A body with neither (no calls, or only obviously non-asserting member/local
    // calls) stays a confident, full "warn".
    const lowConfidence =
      helper.hadUnresolvableHelper || hasPlausiblyAssertingMemberCall(body);

    const severity: Severity =
      options.severityOverride ?? (lowConfidence ? "info" : "warn");

    const message = lowConfidence
      ? "Test makes no direct assertion; it delegates to a helper that could not be confirmed to assert."
      : "Test contains no assertion — it cannot fail regardless of the code under test.";

    return makeFinding("assertion-free", severity, ctx.filePath, block.call, message, block);
  }

  // ----- Case B: the body HAS assertions — is every one a snapshot? -------
  // snapshot-only requires that EVERY assertion is a snapshot matcher AND there
  // is at least one (guaranteed here since assertions.length > 0). Any single
  // concrete non-snapshot assertion (AC3) disqualifies the smell.
  let allSnapshots = true;
  let firstSnapshotNode: Node | undefined;
  for (const a of assertions) {
    const isSnapshot = a.matcher !== undefined && SNAPSHOT_MATCHERS.has(a.matcher);
    if (isSnapshot && firstSnapshotNode === undefined) {
      firstSnapshotNode = a.node;
    }
    if (!isSnapshot) {
      allSnapshots = false;
      break;
    }
  }

  if (allSnapshots) {
    // Report at the first snapshot assertion when we can, else the test call.
    const reportNode = firstSnapshotNode ?? block.call;
    const severity: Severity = options.severityOverride ?? "warn";
    const message =
      "Test's only assertion is a snapshot — it verifies nothing concrete and passes on first run.";
    return makeFinding("snapshot-only", severity, ctx.filePath, reportNode, message, block);
  }

  // Has a real, non-snapshot assertion => not a smell this detector flags.
  return undefined;
}

// ----------------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------------

export const detector: Detector = { meta, run };
