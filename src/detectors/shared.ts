// ============================================================================
// src/detectors/shared.ts
//
// READ-ONLY ts-morph helper library shared by the four smell detectors and the
// regression engine. This is the most depended-on module in the codebase, so
// the contract below is intended to be ergonomic and STABLE.
//
// Design rules every function in this file obeys:
//   * Pure & synchronous. No IO, no AST mutation, no reading other files.
//   * NEVER throws on malformed / partial / surprising input. Every public
//     function returns an empty array, `undefined`, or a safe default instead
//     of propagating an exception. Detectors run over whatever the user threw
//     at us (half-written tests, weird macros, JS without types) and must not
//     crash the whole run because one node was unexpected.
//   * Works uniformly across .ts / .tsx / .js / .jsx — we only ever look at
//     syntax, never types, so the script kind is irrelevant to us.
//
// Implementation note on ts-morph version compatibility:
//   ts-morph@28 does NOT ship the individual static `Node.isCallExpression()`
//   style type guards for every kind. The portable primitives that DO exist on
//   every node are the instance helpers `node.getKind()`, `node.isKind(kind)`
//   and `node.asKind(kind)` (which returns the typed node or `undefined`).
//   We build the entire library on top of `asKind` so this file keeps working
//   across ts-morph minor/major bumps.
// ============================================================================

// `SyntaxKind` is the only runtime value we need from ts-morph; everything else
// is used purely in type positions, so it is imported with `import type` to
// satisfy `verbatimModuleSyntax` + the `consistent-type-imports` lint rule.
import { SyntaxKind } from "ts-morph";
import type {
  CallExpression,
  Identifier,
  Node,
  PropertyAccessExpression,
  SourceFile,
  TypeAliasDeclaration,
} from "ts-morph";

// The `Finding` type (src/types.ts) is the frozen wire format every detector
// ultimately emits. We do not import it here on purpose: the helpers below
// return *richer* structures (with live AST nodes) and let each detector map
// down to `Finding`. Positions produced by `getPosition` are 1-based to match
// `Finding.line` / `Finding.column`.

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/** A 1-based source position, matching the convention used by editors and the
 *  {@link Finding} contract (`line`/`column` are 1-based there too). */
export interface Position {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/** The framework-level kind of a test block. `describe` groups tests; the rest
 *  are individual test cases under their various aliases. */
export type TestBlockKind = "describe" | "it" | "test";

/** Modifiers expressed via the `.skip` / `.only` / `.todo` member chain (or the
 *  `xit`/`fit`/`xdescribe`/`fdescribe` aliases). All three are independent
 *  booleans so a detector can cheaply ask `block.skip`. */
export interface TestModifiers {
  skip: boolean;
  only: boolean;
  todo: boolean;
}

/** One `describe(...)`, `it(...)` or `test(...)` call discovered in a file. */
export interface TestBlock {
  /** `"describe" | "it" | "test"` — note `it` and `test` are reported as their
   *  own kind even though they are semantically equivalent test cases. */
  kind: TestBlockKind;
  /** True for `describe`; false for `it`/`test`. Convenience for detectors that
   *  only care about leaf test cases. */
  isSuite: boolean;
  /** The underlying `it(...)` / `describe(...)` call expression. */
  call: CallExpression;
  /** The first argument when it is a string (or template) literal title.
   *  `undefined` when the title is dynamic (a variable, template with holes,
   *  `it.each` table, etc.). */
  title: string | undefined;
  /** Titles of every enclosing describe/it block, outermost first, INCLUDING
   *  this block's own title. Dynamic titles contribute the placeholder
   *  `"<dynamic>"` so the path stays positional. e.g.
   *  `["UserService", "create()", "rejects duplicates"]`. */
  titlePath: string[];
  /** The callback body: a `Block` (`{ ... }`), an arrow expression body, or
   *  `undefined` when no function argument was supplied (e.g. `it.todo("x")`
   *  or a malformed call). Pass this straight to {@link getAssertions}. */
  body: Node | undefined;
  /** `.skip` / `.only` / `.todo` modifiers (also covers `xit`/`fit`). */
  modifiers: TestModifiers;
  /** Convenience: nesting depth (0 = top-level block). */
  depth: number;
}

/** Which assertion library produced an assertion. */
export type AssertionFramework = "expect" | "node:assert";

/** A single assertion: either an `expect(...).matcher(...)` chain or a
 *  `node:assert` style call (`assert(...)`, `assert.equal(...)`, …). */
export interface Assertion {
  framework: AssertionFramework;
  /** The matcher / assert-method name, e.g. `"toBe"`, `"toThrow"`,
   *  `"toMatchSnapshot"`, `"equal"`, `"deepStrictEqual"`, or `"assert"` for a
   *  bare `assert(cond)` call. `undefined` only for a degenerate chain we could
   *  not resolve (still returned so callers can count "an assertion exists"). */
  matcher: string | undefined;
  /** True when the chain is negated. For `expect` this means a `.not` segment;
   *  for `node:assert` this means a `notEqual` / `notDeepEqual` / `doesNotThrow`
   *  family method, or `assert.notOk`. */
  negated: boolean;
  /** Async chain modifier for `expect`: `.resolves` / `.rejects`. `undefined`
   *  for synchronous chains and for `node:assert`. */
  modifier: "resolves" | "rejects" | undefined;
  /** The argument node(s) passed to `expect(...)` (the *subject* under test),
   *  or to the `assert.*` call for node:assert. Empty when there were none. */
  subjectArgs: Node[];
  /** The argument node(s) passed to the matcher itself, e.g. the `y` in
   *  `expect(x).toBe(y)`. Empty for argument-less matchers like `toThrow()`. */
  matcherArgs: Node[];
  /** The outermost call node of the assertion — the node to report a finding
   *  against (drives line/column). For `expect` this is the matcher call; for
   *  `node:assert` it is the `assert.*(...)` call. */
  node: CallExpression;
  /** The node carrying the matcher *name* specifically (the matcher's property
   *  access for `expect`, or the assert call's callee). Useful for precise
   *  underlining of just the matcher. Falls back to {@link node}. */
  matcherNode: Node;
}

/** A `vi.mock(...)` / `jest.mock(...)` module-mock call. */
export interface MockCall {
  /** `"vi"` or `"jest"` (whichever namespace was used). */
  namespace: "vi" | "jest";
  /** The `.mock` call expression. */
  call: CallExpression;
  /** First argument when it is a string literal — the mocked module specifier,
   *  e.g. `"./db"` or `"node:fs"`. `undefined` for a dynamic specifier. */
  specifier: string | undefined;
}

/** A `vi.spyOn(...)` / `jest.spyOn(...)` call. */
export interface SpyOnCall {
  namespace: "vi" | "jest";
  call: CallExpression;
  /** The object argument node (first arg), if present. */
  objectArg: Node | undefined;
  /** The method-name argument when it is a string literal, else `undefined`. */
  method: string | undefined;
}

/** A `vi.fn(...)` / `jest.fn(...)` factory call. */
export interface FnCall {
  namespace: "vi" | "jest";
  call: CallExpression;
}

/** Everything mock-related found in a file, in one pass. */
export interface MockUsage {
  /** `vi.mock(...)` / `jest.mock(...)` calls. */
  moduleMocks: MockCall[];
  /** `vi.spyOn(...)` / `jest.spyOn(...)` calls. */
  spies: SpyOnCall[];
  /** `vi.fn(...)` / `jest.fn(...)` calls. */
  fns: FnCall[];
}

// ----------------------------------------------------------------------------
// Internal constants
// ----------------------------------------------------------------------------

/** Callee identifiers that start a *test case* (leaf), incl. xUnit aliases. */
const IT_NAMES = new Set(["it", "test", "fit", "xit"]);
/** Callee identifiers that start a *suite*, incl. xUnit aliases. */
const DESCRIBE_NAMES = new Set(["describe", "fdescribe", "xdescribe", "suite"]);
/** Aliases that are inherently skipped (the `x` prefix family). */
const SKIP_ALIASES = new Set(["xit", "xdescribe"]);
/** Aliases that are inherently `.only` (the `f` = "focus" prefix family). */
const ONLY_ALIASES = new Set(["fit", "fdescribe"]);
/** Member names on a test callee that toggle modifiers, e.g. `it.skip`. */
const MODIFIER_MEMBERS = new Set(["skip", "only", "todo"]);
/** Member names we pass THROUGH when resolving a test callee, e.g.
 *  `it.each([...])(...)`, `it.skip.each(...)`, `test.concurrent.only`. */
const PASSTHROUGH_MEMBERS = new Set([
  "skip",
  "only",
  "todo",
  "each",
  "concurrent",
  "sequential",
  "failing",
  "skipIf",
  "runIf",
  "extend",
]);

/** The two mock namespaces we recognise. */
const MOCK_NAMESPACES = new Set(["vi", "jest"]);

/** `node:assert` method names that are *negated* assertions. A bare `notOk`
 *  (chai-style, sometimes polyfilled) is included for safety. */
const ASSERT_NEGATED_METHODS = new Set([
  "notEqual",
  "notDeepEqual",
  "notStrictEqual",
  "notDeepStrictEqual",
  "doesNotThrow",
  "doesNotReject",
  "doesNotMatch",
  "notOk",
  "isNotOk",
  "isNull", // not negated per se, but left out below — see note
]);
// NOTE: `isNull` slipped into the obvious list but is NOT a negation; remove it
// so we do not mislabel. (Kept as a comment to document the deliberate choice.)
ASSERT_NEGATED_METHODS.delete("isNull");

/** Placeholder used in {@link TestBlock.titlePath} for non-literal titles. */
const DYNAMIC_TITLE = "<dynamic>";

// --- Type-level (compile-time) assertion vocabularies -----------------------
//
// Type-level tests assert at COMPILE time and carry no runtime `expect()`; the
// arg they sometimes pass (e.g. the `true` in `assertEqual<A, B>(true)`) is just
// noise — the real assertion lives in the type arguments or in a type alias that
// fails to compile when the types diverge. These vocabularies let
// {@link hasTypeLevelAssertion} recognise the common idioms WITHOUT type info.

/** Bare callee final-names that are themselves type-level assertion helpers
 *  (`expectTypeOf(x).toEqualTypeOf<T>()`, `assertType<T>(x)`, tsd's
 *  `expectType<T>(x)` / `expectError(...)`, etc.). */
const TYPE_ASSERT_CALLEES = new Set([
  "expectTypeOf",
  "assertType",
  "expectType",
  "expectError",
  "expectNotType",
  "expectAssignable",
  "expectNotAssignable",
  "assertNever",
]);

/** Member-access final-names that mark a type-level assertion regardless of the
 *  receiver, covering `util.assertEqual<...>()` / `util.assertType<...>()`. */
const TYPE_ASSERT_MEMBER_METHODS = new Set(["assertEqual", "assertType"]);

/** Identifiers that, when referenced inside a `type X = ...` alias, indicate the
 *  `Expect<Equal<A, B>>` family — a type alias that fails to compile when the
 *  types differ, i.e. a compile-time assertion with NO runtime call at all. */
const TYPE_ASSERT_ALIAS_REFS = new Set([
  "Expect",
  "Equal",
  "AssertEqual",
  "IsExact",
  "TypeEqual",
  "Assert",
]);

/** The TypeScript directive that asserts the very next line is a type error — a
 *  deliberate compile-time assertion. We match it in source text (it lives in a
 *  comment, which is not part of the AST). */
const TS_EXPECT_ERROR_DIRECTIVE = "@ts-expect-error";

// ----------------------------------------------------------------------------
// Low-level, never-throwing node utilities
// ----------------------------------------------------------------------------

/**
 * 1-based {line, column} for any node. Returns `undefined` if the node is
 * detached/forgotten or anything else goes wrong. Never throws.
 */
export function getPosition(node: Node | undefined): Position | undefined {
  if (node === undefined) return undefined;
  try {
    if (node.wasForgotten()) return undefined;
    const sf = node.getSourceFile();
    // getStart() skips leading trivia so the caret lands on real syntax.
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    return { line, column };
  } catch {
    return undefined;
  }
}

/**
 * 1-based line for a node, or `undefined`. Thin convenience over
 * {@link getPosition} for the common `Finding.line` case.
 */
export function getLine(node: Node | undefined): number | undefined {
  return getPosition(node)?.line;
}

/**
 * The single source line that a node STARTS on, trimmed of trailing newline,
 * suitable for `Finding.snippet`. Multi-line nodes are truncated to their first
 * line so reports stay tidy. Returns `undefined` on any failure.
 */
export function getLineSnippet(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  try {
    if (node.wasForgotten()) return undefined;
    const sf = node.getSourceFile();
    const full = sf.getFullText();
    const start = node.getStart();
    // Walk back to the beginning of the line, forward to its end.
    let lineStart = start;
    while (lineStart > 0 && full[lineStart - 1] !== "\n") lineStart--;
    let lineEnd = start;
    while (lineEnd < full.length && full[lineEnd] !== "\n") lineEnd++;
    return full.slice(lineStart, lineEnd).replace(/\r$/, "").trim();
  } catch {
    return undefined;
  }
}

/**
 * Best-effort callee name of a call expression, following property-access and
 * parenthesised/awaited wrappers down to the leading identifier.
 *   foo(...)            -> "foo"
 *   ns.foo(...)         -> "foo"      (last member name)
 *   a.b.c(...)          -> "c"
 *   (cond ? f : g)(...) -> undefined
 * Returns `undefined` when no stable name exists. Never throws.
 */
export function getCalleeName(call: Node | undefined): string | undefined {
  const expr = unwrapExpression(asCall(call)?.getExpression());
  if (expr === undefined) return undefined;
  const id = expr.asKind(SyntaxKind.Identifier);
  if (id) return id.getText();
  const pae = expr.asKind(SyntaxKind.PropertyAccessExpression);
  if (pae) return safeName(pae);
  return undefined;
}

/**
 * Reads a string value from a node IF it is a plain string literal or a
 * no-substitution template literal (`` `like this` ``). Returns `undefined` for
 * dynamic expressions, templates with `${}` holes, numbers, etc. Never throws.
 */
export function getStringLiteralValue(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  try {
    const str = node.asKind(SyntaxKind.StringLiteral);
    if (str) return str.getLiteralValue();
    const tmpl = node.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    if (tmpl) return tmpl.getLiteralValue();
    return undefined;
  } catch {
    return undefined;
  }
}

// --- tiny internal casting helpers (kept private; they centralise asKind) ----

/** Narrow to CallExpression or `undefined`. */
function asCall(node: Node | undefined): CallExpression | undefined {
  return node?.asKind(SyntaxKind.CallExpression);
}

/** Narrow to PropertyAccessExpression or `undefined`. */
function asPropAccess(node: Node | undefined): PropertyAccessExpression | undefined {
  return node?.asKind(SyntaxKind.PropertyAccessExpression);
}

/** Narrow to Identifier or `undefined`. */
function asIdentifier(node: Node | undefined): Identifier | undefined {
  return node?.asKind(SyntaxKind.Identifier);
}

/** Property name of a member access without throwing (returns `undefined`). */
function safeName(pae: PropertyAccessExpression): string | undefined {
  try {
    return pae.getName();
  } catch {
    return undefined;
  }
}

/** Arguments of a call without throwing (returns `[]`). */
function safeArgs(call: CallExpression): Node[] {
  try {
    return call.getArguments();
  } catch {
    return [];
  }
}

/**
 * Strip parentheses / `await` / non-null `!` wrappers off an expression so a
 * caller can see the call or chain underneath. Handy when a test does
 * `await expect(p).resolves.toBe(x)` or `(expect(x) as any).toBe(y)`. Bounded
 * loop; returns the input unchanged when there is nothing to strip; never
 * throws.
 */
export function unwrapExpression(node: Node | undefined): Node | undefined {
  let cur = node;
  // A handful of iterations is plenty; the guard just prevents pathological loops.
  for (let i = 0; cur !== undefined && i < 8; i++) {
    const paren = cur.asKind(SyntaxKind.ParenthesizedExpression);
    if (paren) {
      cur = paren.getExpression();
      continue;
    }
    const awaited = cur.asKind(SyntaxKind.AwaitExpression);
    if (awaited) {
      cur = awaited.getExpression();
      continue;
    }
    const nonNull = cur.asKind(SyntaxKind.NonNullExpression);
    if (nonNull) {
      cur = nonNull.getExpression();
      continue;
    }
    break;
  }
  return cur;
}

// ----------------------------------------------------------------------------
// Test-block enumeration
// ----------------------------------------------------------------------------

/**
 * Enumerate EVERY `describe(...)`, `it(...)` and `test(...)` call in a source
 * file (including `it.skip` / `it.only` / `it.todo` / `xit` / `fit` and the
 * `test.*` and `describe.*` variants), in source order.
 *
 * Each {@link TestBlock} carries its resolved title, the full describe>it title
 * path, the callback body node (for assertion scanning) and skip/only/todo
 * flags. Nested blocks are returned too; use `block.depth` / `block.titlePath`
 * to understand structure.
 *
 * Accepts a `SourceFile` or any `Node` (e.g. to scan a sub-tree). Never throws;
 * returns `[]` on bad input.
 */
export function getTestBlocks(root: SourceFile | Node | undefined): TestBlock[] {
  if (root === undefined) return [];
  const out: TestBlock[] = [];
  try {
    // We DFS so we can thread the enclosing title path & depth as we descend.
    // forEachDescendant visits in source order; we compute the path on the fly
    // by checking each call's resolved-callee against the test vocabularies and
    // looking up the chain of enclosing test calls for the path.
    root.forEachDescendant((node) => {
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call === undefined) return;
      const resolved = resolveTestCallee(call);
      if (resolved === undefined) return;

      const title = getStringLiteralValue(safeArgs(call)[0]);
      const block: TestBlock = {
        kind: resolved.kind,
        isSuite: resolved.kind === "describe",
        call,
        title,
        titlePath: buildTitlePath(call, title),
        body: extractCallback(call),
        modifiers: resolved.modifiers,
        depth: countEnclosingTestCalls(call),
      };
      out.push(block);
    });
  } catch {
    // fall through with whatever we collected
  }
  return out;
}

/** Result of recognising a call's callee as a test/suite invocation. */
interface ResolvedTestCallee {
  kind: TestBlockKind;
  modifiers: TestModifiers;
}

/**
 * Decide whether a call's callee is a test/suite invocation and, if so, which
 * kind and what modifiers its member chain implies. Handles:
 *   it(...) test(...) describe(...) suite(...)
 *   it.skip / it.only / it.todo / test.skip / describe.only ...
 *   xit / fit / xdescribe / fdescribe
 *   it.each([...])(...) , test.concurrent.skip(...) , it.skip.each`...`(...)
 * Returns `undefined` for anything that is not a recognised test callee.
 */
function resolveTestCallee(call: CallExpression): ResolvedTestCallee | undefined {
  const expr = call.getExpression();
  if (expr === undefined) return undefined;

  const modifiers: TestModifiers = { skip: false, only: false, todo: false };

  // Walk the member-access chain right-to-left collecting modifier members,
  // until we hit the base identifier (`it` / `test` / `describe` / alias).
  // We carry a separate `next` binding for the following iteration so the
  // checker never has to infer `cursor`'s type from a value derived from
  // `cursor` itself (which otherwise trips TS7022 inside the loop).
  let cursor: Node | undefined = expr;
  // Guard against pathological depth.
  for (let i = 0; cursor !== undefined && i < 16; i++) {
    const current: Node = cursor;
    const id = current.asKind(SyntaxKind.Identifier);
    if (id) {
      const name = id.getText();
      const baseKind = baseKindOf(name);
      if (baseKind === undefined) return undefined; // not a test callee
      if (SKIP_ALIASES.has(name)) modifiers.skip = true;
      if (ONLY_ALIASES.has(name)) modifiers.only = true;
      return { kind: baseKind, modifiers };
    }

    const pae = current.asKind(SyntaxKind.PropertyAccessExpression);
    if (pae) {
      const member = safeName(pae);
      if (member !== undefined && MODIFIER_MEMBERS.has(member)) {
        if (member === "skip") modifiers.skip = true;
        else if (member === "only") modifiers.only = true;
        else if (member === "todo") modifiers.todo = true;
      } else if (member !== undefined && !PASSTHROUGH_MEMBERS.has(member)) {
        // An unknown member like `it.somethingWeird` — not a test callee we
        // model. Bail rather than guess.
        return undefined;
      }
      cursor = pae.getExpression();
      continue;
    }

    // `it.each([...])(...)` makes the callee itself a CallExpression; descend
    // into ITS callee to find the base `it`/`test`/`describe`.
    const innerCall = current.asKind(SyntaxKind.CallExpression);
    if (innerCall) {
      cursor = innerCall.getExpression();
      continue;
    }

    // Tagged template: `it.each`table`` — the callee is a TaggedTemplate whose
    // tag holds the chain.
    const tagged = current.asKind(SyntaxKind.TaggedTemplateExpression);
    if (tagged) {
      cursor = tagged.getTag();
      continue;
    }

    return undefined;
  }
  return undefined;
}

/** Map a bare callee identifier to its block kind, or `undefined`. */
function baseKindOf(name: string): TestBlockKind | undefined {
  if (DESCRIBE_NAMES.has(name)) return "describe";
  if (IT_NAMES.has(name)) {
    // Preserve the distinction the contract asks for: `test`/aliases vs `it`.
    if (name === "test") return "test";
    return "it";
  }
  return undefined;
}

/**
 * Extract the callback body of a test call: the `Block` of a function/arrow, or
 * an arrow's expression body, or `undefined` when there is no usable function
 * argument (e.g. `it.todo("x")`, `it.each(table)("name", fn)` where we still
 * try the last function arg). Never throws.
 */
function extractCallback(call: CallExpression): Node | undefined {
  const args = safeArgs(call);
  // The test body is conventionally the LAST function-shaped argument.
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    const arrow = arg?.asKind(SyntaxKind.ArrowFunction);
    if (arrow) return arrow.getBody();
    const fn = arg?.asKind(SyntaxKind.FunctionExpression);
    if (fn) {
      try {
        return fn.getBody();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Count how many enclosing test/suite calls wrap this call (its nesting depth).
 * 0 = top-level. Walks ancestors; never throws.
 */
function countEnclosingTestCalls(call: CallExpression): number {
  let depth = 0;
  try {
    let parent = call.getParent();
    for (let i = 0; parent !== undefined && i < 256; i++) {
      const pc = parent.asKind(SyntaxKind.CallExpression);
      if (pc && resolveTestCallee(pc) !== undefined) depth++;
      parent = parent.getParent();
    }
  } catch {
    // ignore
  }
  return depth;
}

/**
 * Build the describe>it title path for a call, outermost first, ending with the
 * call's own `ownTitle`. Enclosing blocks with dynamic titles contribute
 * {@link DYNAMIC_TITLE}. Never throws.
 */
function buildTitlePath(call: CallExpression, ownTitle: string | undefined): string[] {
  const ancestors: string[] = [];
  try {
    let parent = call.getParent();
    for (let i = 0; parent !== undefined && i < 256; i++) {
      const pc = parent.asKind(SyntaxKind.CallExpression);
      if (pc && resolveTestCallee(pc) !== undefined) {
        const t = getStringLiteralValue(safeArgs(pc)[0]);
        ancestors.unshift(t ?? DYNAMIC_TITLE);
      }
      parent = parent.getParent();
    }
  } catch {
    // ignore — return what we have
  }
  ancestors.push(ownTitle ?? DYNAMIC_TITLE);
  return ancestors;
}

// ----------------------------------------------------------------------------
// Assertion enumeration  (expect(...) chains + node:assert)
// ----------------------------------------------------------------------------

/**
 * Enumerate every assertion in a node/body: both `expect(...).matcher(...)`
 * chains and `node:assert` style calls (`assert(...)`, `assert.equal(...)`,
 * `strict.deepEqual(...)`, …). Returns them in source order.
 *
 * For `expect` chains this resolves the applied matcher name, `.not` negation,
 * the `.resolves`/`.rejects` modifier, the `expect()` subject argument node(s),
 * the matcher argument node(s), and the precise matcher call node for
 * line/column.
 *
 * Pass a {@link TestBlock.body} (or any node) to scope the search. Never throws;
 * returns `[]` on bad input.
 */
export function getAssertions(scope: Node | undefined): Assertion[] {
  if (scope === undefined) return [];
  const out: Assertion[] = [];
  try {
    // We want the OUTERMOST call of each assertion chain so we don't emit a
    // finding per nested call. Strategy: visit every CallExpression; classify
    // it; only keep "terminal" assertion calls (an expect-matcher call, or a
    // node:assert call). A nested `expect(x)` on its own is skipped because it
    // is not a terminal matcher call.
    scope.forEachDescendant((node) => {
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call === undefined) return;

      const expectAssertion = tryParseExpectChain(call);
      if (expectAssertion) {
        out.push(expectAssertion);
        return;
      }
      const assertAssertion = tryParseNodeAssert(call);
      if (assertAssertion) {
        out.push(assertAssertion);
      }
    });
  } catch {
    // return whatever we collected
  }
  return out;
}

/**
 * Convenience for detectors: does this scope contain at least one REAL
 * assertion (an `expect` matcher call or a `node:assert` call)? A bare
 * `expect(x)` with no matcher does NOT count. Never throws.
 */
export function hasRealAssertion(scope: Node | undefined): boolean {
  return getAssertions(scope).length > 0;
}

/**
 * Convenience for detectors: the set of matcher / assert-method names used in a
 * scope (e.g. `{"toBe","toEqual"}`). Unresolved matchers are skipped. Useful
 * for the trivial-assertion / snapshot-only / tautology smells. Never throws.
 */
export function getMatcherNames(scope: Node | undefined): Set<string> {
  const names = new Set<string>();
  for (const a of getAssertions(scope)) {
    if (a.matcher !== undefined) names.add(a.matcher);
  }
  return names;
}

/**
 * Does `scope` (a test body) contain any COMPILE-TIME assertion signal? These
 * are legitimate tests that assert at type-check time and therefore have no
 * runtime `expect(...)` / `node:assert` call — {@link hasRealAssertion} returns
 * `false` for them even though they verify something real. Detectors use this to
 * avoid the precision false-positive of flagging a type-level test as
 * assertion-free.
 *
 * Returns `true` when ANY of the following hold inside `scope`:
 *   - a call whose callee FINAL name is a known type-assertion helper
 *     (`expectTypeOf`, `assertType`, `expectType`, `expectError`, `expectNotType`,
 *     `expectAssignable`, `expectNotAssignable`, `assertNever`); OR a member call
 *     whose final member is `.assertEqual` / `.assertType` (covers
 *     `util.assertEqual<...>()`); OR a BARE `assertEqual(...)` call that carries
 *     explicit type arguments (`assertEqual<A, B>(true)` — the runtime arg is
 *     noise, the assertion is in the type args);
 *   - the source text of `scope` contains a `@ts-expect-error` directive (a
 *     deliberate "this line must be a type error" assertion living in a comment);
 *   - a `type X = ...` alias inside `scope` whose type references an identifier in
 *     {@link TYPE_ASSERT_ALIAS_REFS} (the `Expect<Equal<A, B>>` idiom — a type
 *     alias that fails to compile when the types diverge).
 *
 * Purely syntactic and conservative: anything we are unsure about yields `false`.
 * Wrapped end-to-end so it NEVER throws.
 */
export function hasTypeLevelAssertion(scope: Node | undefined): boolean {
  if (scope === undefined) return false;
  try {
    // Cheap, whole-scope text check first: `@ts-expect-error` lives in a comment,
    // which is trivia (not an AST node), so we can only see it in the raw text.
    try {
      if (scope.getText().includes(TS_EXPECT_ERROR_DIRECTIVE)) return true;
    } catch {
      // fall through to the AST walk
    }

    let found = false;
    scope.forEachDescendant((node, traversal) => {
      if (found) {
        traversal.stop();
        return;
      }

      // (a) Type-assertion CALLS.
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call !== undefined && isTypeAssertionCall(call)) {
        found = true;
        traversal.stop();
        return;
      }

      // (b) The `type X = Expect<Equal<A, B>>` alias idiom.
      const alias = node.asKind(SyntaxKind.TypeAliasDeclaration);
      if (alias !== undefined && typeAliasReferencesAssertHelper(alias)) {
        found = true;
        traversal.stop();
      }
    });
    return found;
  } catch {
    return false;
  }
}

/**
 * Is `call` a type-level assertion call? Recognises three shapes (see
 * {@link hasTypeLevelAssertion}): a known bare/last-name helper, a member call
 * ending in `.assertEqual`/`.assertType`, or a bare `assertEqual` that carries
 * explicit type arguments. Never throws.
 */
function isTypeAssertionCall(call: CallExpression): boolean {
  try {
    const expr = unwrapExpression(call.getExpression());
    if (expr === undefined) return false;

    // Member form: `<receiver>.assertEqual<...>()` / `.assertType<...>()` — the
    // receiver is irrelevant, only the final member name matters.
    const pae = expr.asKind(SyntaxKind.PropertyAccessExpression);
    if (pae) {
      const member = safeName(pae);
      if (member !== undefined && TYPE_ASSERT_MEMBER_METHODS.has(member)) return true;
    }

    // Resolve the callee's final name (handles `ns.foo` -> "foo" via the shared
    // resolver) for the known-helper and bare-`assertEqual` cases.
    const name = getCalleeName(call);
    if (name === undefined) return false;

    if (TYPE_ASSERT_CALLEES.has(name)) return true;

    // Bare `assertEqual<A, B>(true)`: only a type-level assertion when it carries
    // explicit type arguments (a runtime-only `assertEqual(a, b)` is not ours).
    if (name === "assertEqual" && hasExplicitTypeArguments(call)) return true;

    return false;
  } catch {
    return false;
  }
}

/** Does a call carry explicit type arguments (`f<A, B>(x)`)? Never throws. */
function hasExplicitTypeArguments(call: CallExpression): boolean {
  try {
    return call.getTypeArguments().length > 0;
  } catch {
    return false;
  }
}

/**
 * Does a `type X = ...` alias's right-hand side reference any identifier in
 * {@link TYPE_ASSERT_ALIAS_REFS} (e.g. `Expect`, `Equal`)? We scan the type
 * node's identifier descendants syntactically. Never throws.
 */
function typeAliasReferencesAssertHelper(alias: TypeAliasDeclaration): boolean {
  try {
    const typeNode = alias.getTypeNode();
    if (typeNode === undefined) return false;
    let referenced = false;
    typeNode.forEachDescendant((node, traversal) => {
      const id = node.asKind(SyntaxKind.Identifier);
      if (id && TYPE_ASSERT_ALIAS_REFS.has(id.getText())) {
        referenced = true;
        traversal.stop();
      }
    });
    return referenced;
  } catch {
    return false;
  }
}

/**
 * Try to interpret `call` as the TERMINAL call of an `expect(...).….matcher(x)`
 * chain. Returns an {@link Assertion} only when the chain's root is an
 * `expect(...)` call AND this `call` applies a matcher member to it. Returns
 * `undefined` otherwise (including for the inner `expect(x)` call itself).
 */
function tryParseExpectChain(call: CallExpression): Assertion | undefined {
  // The callee of a matcher call is a property access: <chain>.matcher
  const callee = asPropAccess(call.getExpression());
  if (callee === undefined) return undefined;

  const matcherName = safeName(callee);
  if (matcherName === undefined) return undefined;

  // Walk leftwards down the property-access chain collecting modifier segments
  // (`not`, `resolves`, `rejects`) until we reach the root `expect(...)` call.
  let negated = false;
  let modifier: "resolves" | "rejects" | undefined;

  // As in resolveTestCallee, carry a per-iteration `const` so the checker does
  // not have to infer `cursor` from a value derived from itself (TS7022).
  let cursor: Node | undefined = callee.getExpression();
  let expectCall: CallExpression | undefined;
  for (let i = 0; cursor !== undefined && i < 16; i++) {
    const current: Node = cursor;
    // Reached the root: a call whose own callee is the `expect` identifier.
    const asCallNode = current.asKind(SyntaxKind.CallExpression);
    if (asCallNode) {
      const id = asIdentifier(asCallNode.getExpression());
      if (id && id.getText() === "expect") {
        expectCall = asCallNode;
        break;
      }
      // Some other call in the chain (e.g. `expect(x).something()`); not a
      // shape we model as a matcher chain.
      return undefined;
    }
    const pae = current.asKind(SyntaxKind.PropertyAccessExpression);
    if (pae) {
      const seg = safeName(pae);
      if (seg === "not") negated = true;
      else if (seg === "resolves") modifier = "resolves";
      else if (seg === "rejects") modifier = "rejects";
      // Any other intermediate segment (rare) is tolerated and ignored.
      cursor = pae.getExpression();
      continue;
    }
    // Anything else means this isn't an expect chain.
    return undefined;
  }

  if (expectCall === undefined) return undefined;

  return {
    framework: "expect",
    matcher: matcherName,
    negated,
    modifier,
    subjectArgs: safeArgs(expectCall),
    matcherArgs: safeArgs(call),
    node: call,
    matcherNode: callee.getNameNode() ?? callee,
  };
}

/**
 * Try to interpret `call` as a `node:assert` style assertion:
 *   assert(value[, msg])
 *   assert.equal/notEqual/strictEqual/deepEqual/deepStrictEqual/throws/...(...)
 *   strict.equal(...)        (the `node:assert/strict` namespace, if imported
 *                             under the name `strict` or `assert`)
 * We recognise by callee shape + name; we deliberately do NOT require knowing
 * the import, since detectors run syntactically. Returns `undefined` when the
 * call is not assert-shaped.
 */
function tryParseNodeAssert(call: CallExpression): Assertion | undefined {
  const expr = call.getExpression();
  if (expr === undefined) return undefined;

  // Bare `assert(cond)` — callee is the identifier `assert`.
  const bareId = asIdentifier(expr);
  if (bareId) {
    if (bareId.getText() !== "assert") return undefined;
    return {
      framework: "node:assert",
      matcher: "assert",
      negated: false,
      modifier: undefined,
      subjectArgs: safeArgs(call),
      matcherArgs: [],
      node: call,
      matcherNode: bareId,
    };
  }

  // Member form `assert.equal(...)` / `strict.deepEqual(...)`.
  const pae = asPropAccess(expr);
  if (pae === undefined) return undefined;

  // The receiving object must look like an assert namespace.
  const objId = asIdentifier(pae.getExpression());
  const objName = objId?.getText();
  if (objName !== "assert" && objName !== "strict") return undefined;

  const method = safeName(pae);
  if (method === undefined) return undefined;
  // Only accept method names that are real assert methods; otherwise this is
  // some unrelated `assert.foo` and we should not count it as an assertion.
  if (!ASSERT_METHODS.has(method)) return undefined;

  return {
    framework: "node:assert",
    matcher: method,
    negated: ASSERT_NEGATED_METHODS.has(method),
    modifier: undefined,
    subjectArgs: safeArgs(call),
    matcherArgs: [],
    node: call,
    matcherNode: pae.getNameNode() ?? pae,
  };
}

/** Recognised `node:assert` method names (the public assert surface). */
const ASSERT_METHODS = new Set([
  "ok",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
  "match",
  "doesNotMatch",
  "ifError",
  "fail",
]);

// ----------------------------------------------------------------------------
// Mock detection
// ----------------------------------------------------------------------------

/**
 * Detect all mock-related calls in a file (or sub-tree) in a single pass:
 *   * `vi.mock(...)` / `jest.mock(...)`            -> {@link MockUsage.moduleMocks}
 *   * `vi.spyOn(...)` / `jest.spyOn(...)`          -> {@link MockUsage.spies}
 *   * `vi.fn(...)` / `jest.fn(...)`                -> {@link MockUsage.fns}
 *
 * For module mocks the first string-literal specifier is resolved (e.g.
 * `"./db"`). Never throws; returns empty arrays on bad input.
 */
export function getMockUsage(root: SourceFile | Node | undefined): MockUsage {
  const usage: MockUsage = { moduleMocks: [], spies: [], fns: [] };
  if (root === undefined) return usage;
  try {
    root.forEachDescendant((node) => {
      const call = node.asKind(SyntaxKind.CallExpression);
      if (call === undefined) return;
      const pae = asPropAccess(call.getExpression());
      if (pae === undefined) return;
      const objId = asIdentifier(pae.getExpression());
      const ns = objId?.getText();
      if (ns === undefined || !MOCK_NAMESPACES.has(ns)) return;
      const namespace = ns as "vi" | "jest";
      const member = safeName(pae);

      if (member === "mock" || member === "doMock") {
        usage.moduleMocks.push({
          namespace,
          call,
          specifier: getStringLiteralValue(safeArgs(call)[0]),
        });
      } else if (member === "spyOn") {
        const args = safeArgs(call);
        usage.spies.push({
          namespace,
          call,
          objectArg: args[0],
          method: getStringLiteralValue(args[1]),
        });
      } else if (member === "fn") {
        usage.fns.push({ namespace, call });
      }
    });
  } catch {
    // return what we collected
  }
  return usage;
}

/**
 * Convenience: just the set of mocked module specifiers in a file (the string
 * args of `vi.mock`/`jest.mock`). Drives the over-mocking-SUT smell, which
 * compares these against the module under test. Never throws.
 */
export function getMockedSpecifiers(root: SourceFile | Node | undefined): string[] {
  const out: string[] = [];
  for (const m of getMockUsage(root).moduleMocks) {
    if (m.specifier !== undefined) out.push(m.specifier);
  }
  return out;
}
