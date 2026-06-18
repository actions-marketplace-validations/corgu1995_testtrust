// ============================================================================
// test/detectors/overMockingSut.test.ts
//
// Spec for the "over-mocking-sut" detector (src/detectors/overMockingSut.ts).
//
// The smell: a test file named `cart.test.ts` exists to exercise the real
// `cart` module, but does `vi.mock("./cart")` up top — so it verifies an
// auto-mock of its OWN subject. We flag a vi.mock/jest.mock whose specifier is
// the SAME module the test is named after.
//
// PRECISION FIRST: this rule feeds a CI gate, so a single false positive mutes
// the whole tool. Every uncertain step resolves toward emitting NOTHING. These
// tests pin the documented acceptance criteria:
//   AC1 — cart.test.ts importing "./cart" AND vi.mock("./cart") => one warn.
//   AC2 — mocking a DIFFERENT module while subject is "./cart" => nothing.
//   AC3 — ambiguous / no clear subject import => nothing (never guess).
//   AC4 — jest.mock variant is also detected.
//   + the detector NEVER emits severity "fail".
// ============================================================================

import { describe, expect, it } from "vitest";

import { detector } from "../../src/detectors/overMockingSut.js";
import type { Finding } from "../../src/types.js";
import { makeContext } from "../helpers/context.js";

/**
 * The detector's `run(ctx, options)` takes a DetectorRunOptions second arg.
 * AC scenarios use no severity override, so pass an empty options object.
 */
const NO_OPTIONS = {} as const;

/** Run the detector against `src` with the SUT inferred from `filePath`. */
function run(src: string, filePath = "cart.test.ts"): Finding[] {
  return detector.run(makeContext(src, { filePath }), NO_OPTIONS);
}

/**
 * Assert the array holds exactly one finding and return it (narrowed away from
 * `undefined` under noUncheckedIndexedAccess). Doubles as a hard count check so
 * "fired exactly once" is part of every single-finding assertion.
 */
function onlyFinding(findings: Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  if (finding === undefined) throw new Error("expected exactly one finding");
  return finding;
}

describe("over-mocking-sut detector", () => {
  describe("meta", () => {
    it("declares the documented id, default severity and base requirement", () => {
      expect(detector.meta.id).toBe("over-mocking-sut");
      expect(detector.meta.defaultSeverity).toBe("warn");
      // A pure smell detector — works on a single (head) file, no base ref.
      expect(detector.meta.requiresBase).toBe(false);
    });
  });

  describe("AC1: subject is mocked => one over-mocking-sut warn finding", () => {
    const src = [
      `import { addItem } from "./cart";`,
      ``,
      `vi.mock("./cart");`,
      ``,
      `test("adds an item", () => {`,
      `  expect(addItem([], "x")).toEqual(["x"]);`,
      `});`,
    ].join("\n");

    it("emits exactly one finding", () => {
      expect(run(src)).toHaveLength(1);
    });

    it("stamps the finding with the rule id and 'warn' severity", () => {
      const finding = onlyFinding(run(src));
      expect(finding.ruleId).toBe("over-mocking-sut");
      expect(finding.severity).toBe("warn");
    });

    it("reports the finding at the vi.mock call site (file + line)", () => {
      const finding = onlyFinding(run(src));
      expect(finding.file).toBe("cart.test.ts");
      // `vi.mock("./cart")` is on the 3rd line (1-based) of the source above.
      expect(finding.line).toBe(3);
    });

    it("records both the SUT and mocked specifiers in structured data", () => {
      const finding = onlyFinding(run(src));
      expect(finding.data).toEqual({
        sutSpecifier: "./cart",
        mockedSpecifier: "./cart",
      });
    });

    it("explains the smell, naming the mocked specifier in the message", () => {
      const finding = onlyFinding(run(src));
      expect(finding.message).toContain("./cart");
      expect(finding.message.toLowerCase()).toContain("mock");
    });
  });

  describe("AC1 variants: exact-specifier match still fires", () => {
    it("matches across a redundant extension on the mock specifier", () => {
      // import "./cart" + vi.mock("./cart.ts") both normalize to "./cart".
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart.ts");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(onlyFinding(run(src)).data).toMatchObject({ mockedSpecifier: "./cart.ts" });
    });

    it("matches across a redundant extension on the import specifier", () => {
      // import "./cart.js" + vi.mock("./cart") both normalize to "./cart".
      const src = [
        `import { addItem } from "./cart.js";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(onlyFinding(run(src)).data).toMatchObject({ sutSpecifier: "./cart.js" });
    });

    it("infers the subject from a .spec.tsx file name too", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(onlyFinding(run(src, "cart.spec.tsx")).ruleId).toBe("over-mocking-sut");
    });

    it("infers the subject from a full path, ignoring the directory", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const findings = run(src, "/repo/src/features/cart.test.ts");
      expect(findings).toHaveLength(1);
    });
  });

  describe("AC2: mocking a DIFFERENT module => no finding", () => {
    it("does not fire when only an unrelated module is mocked", () => {
      // Subject is "./cart"; only the logger (a collaborator) is mocked. This
      // is the legitimate, healthy pattern and must stay silent.
      const src = [
        `import { addItem } from "./cart";`,
        `import { log } from "./logger";`,
        ``,
        `vi.mock("./logger");`,
        ``,
        `test("logs on add", () => {`,
        `  addItem([], "x");`,
        `  expect(log).toHaveBeenCalled();`,
        `});`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("does not fire on a mere basename collision in a different directory", () => {
      // import "../services/cart" matches the subject BASENAME ("cart"), but the
      // mock specifier "./cart" is a different path. Normalization is trivial and
      // must NOT equate two genuinely different modules => no false positive.
      const src = [
        `import { addItem } from "../services/cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("does not fire when a different module shares no basename at all", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("node:fs");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });
  });

  describe("AC3: ambiguous / absent subject import => emit nothing (never guess)", () => {
    it("stays silent when the subject is never imported (nothing to compare)", () => {
      // The file mocks "./cart" but never imports anything resolving to "cart",
      // so the SUT import cannot be pinned down => no finding.
      const src = [
        `import { log } from "./logger";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(log).toBeDefined(); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("stays silent when two different imports both resolve to the subject basename", () => {
      // Both "./cart" and "../legacy/cart" basename to "cart"; we cannot know
      // which is the real subject, so we refuse to infer (AC3) — even though one
      // of them IS the mocked specifier.
      const src = [
        `import { addItem } from "./cart";`,
        `import { legacyAdd } from "../legacy/cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(legacyAdd()); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("stays silent when the file name is not a test/spec file", () => {
      // "cart.ts" has no .test/.spec infix => no subject can be inferred.
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src, "cart.ts")).toEqual([]);
    });

    it("stays silent when nothing precedes the test infix (e.g. test.ts)", () => {
      const src = [
        `import { thing } from "./thing";`,
        `vi.mock("./thing");`,
        `test("t", () => { expect(thing).toBeDefined(); });`,
      ].join("\n");
      expect(run(src, "test.ts")).toEqual([]);
    });

    it("stays silent when the subject is imported but no module is mocked", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `test("t", () => { expect(addItem([], "x")).toEqual(["x"]); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("stays silent for a dynamic mock specifier it cannot read", () => {
      // vi.mock(modPath) has no string-literal specifier => nothing to compare.
      const src = [
        `import { addItem } from "./cart";`,
        `const modPath = "./cart";`,
        `vi.mock(modPath);`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });
  });

  describe("AC4: jest.mock variant is detected the same way", () => {
    it("fires on jest.mock of the subject, with warn severity", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `jest.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const finding = onlyFinding(run(src));
      expect(finding.ruleId).toBe("over-mocking-sut");
      expect(finding.severity).toBe("warn");
      expect(finding.data).toMatchObject({ mockedSpecifier: "./cart" });
    });

    it("does NOT fire on jest.mock of a different module", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `jest.mock("./logger");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });
  });

  describe("severity contract: NEVER emits 'fail'", () => {
    it("defaults to 'warn' and never 'fail' on a firing case", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      for (const finding of run(src)) {
        expect(finding.severity).not.toBe("fail");
        expect(finding.severity).toBe("warn");
      }
    });

    it("honors a severity override but still refuses to escalate to 'fail'", () => {
      // Even if the engine were to hand the detector severityOverride:"fail",
      // the documented contract is that this rule never reports a failure. We
      // assert the detector respects an *info*/*warn* override and, critically,
      // that NO finding is ever stamped "fail".
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");

      const finding = onlyFinding(
        detector.run(makeContext(src, { filePath: "cart.test.ts" }), {
          severityOverride: "info",
        }),
      );
      expect(finding.severity).toBe("info");
      expect(finding.severity).not.toBe("fail");
    });
  });

  describe("partial mock that keeps the real implementation => no finding", () => {
    it("does not fire when the factory spreads an awaited importOriginal()", () => {
      // The DOMINANT legitimate self-mock: keep the real cart, override one
      // export. The real implementation is still exercised, so flagging this as
      // "exercises a mock instead of the real module" is a false positive.
      const src = [
        `import { addItem, formatPrice } from "./cart";`,
        ``,
        `vi.mock("./cart", async (importOriginal) => ({`,
        `  ...(await importOriginal()),`,
        `  formatPrice: vi.fn(),`,
        `}));`,
        ``,
        `test("adds an item", () => {`,
        `  expect(addItem([], "x")).toEqual(["x"]);`,
        `});`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("does not fire when the factory uses vi.importActual", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart", async () => {`,
        `  const actual = await vi.importActual("./cart");`,
        `  return { ...actual, formatPrice: vi.fn() };`,
        `});`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("does not fire when the factory uses requireActual (jest style)", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `jest.mock("./cart", () => ({`,
        `  ...jest.requireActual("./cart"),`,
        `  formatPrice: jest.fn(),`,
        `}));`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      expect(run(src)).toEqual([]);
    });

    it("still fires on a bare vi.mock of the SUT (no factory brings the original back)", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const finding = onlyFinding(run(src));
      expect(finding.ruleId).toBe("over-mocking-sut");
      expect(finding.data).toMatchObject({ mockedSpecifier: "./cart" });
    });

    it("still fires on a full-replacement factory that does NOT pull in the original", () => {
      // A factory that hand-rolls every export from scratch never touches the
      // real cart, so it IS the over-mocking smell and must still flag.
      const src = [
        `import { addItem } from "./cart";`,
        `vi.mock("./cart", () => ({`,
        `  addItem: vi.fn(() => ["x"]),`,
        `  formatPrice: vi.fn(),`,
        `}));`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const finding = onlyFinding(run(src));
      expect(finding.ruleId).toBe("over-mocking-sut");
      expect(finding.data).toMatchObject({ mockedSpecifier: "./cart" });
    });

    it("does not let a partial mock of a DIFFERENT module suppress the SUT mock", () => {
      // logger is partially mocked (keeps original) — irrelevant — while the SUT
      // cart is bare-mocked. The cart finding must still fire.
      const src = [
        `import { addItem } from "./cart";`,
        `import { log } from "./logger";`,
        `vi.mock("./logger", async (importOriginal) => ({ ...(await importOriginal()), log: vi.fn() }));`,
        `vi.mock("./cart");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const finding = onlyFinding(run(src));
      expect(finding.data).toMatchObject({ mockedSpecifier: "./cart" });
      // The cart mock is on the 4th line (1-based).
      expect(finding.line).toBe(4);
    });
  });

  describe("robustness: multiple mocks in one file", () => {
    it("flags only the SUT mock, leaving collaborator mocks untouched", () => {
      const src = [
        `import { addItem } from "./cart";`,
        `import { log } from "./logger";`,
        `vi.mock("./logger");`,
        `vi.mock("./cart");`,
        `vi.mock("node:fs");`,
        `test("t", () => { expect(addItem()).toBe(1); });`,
      ].join("\n");
      const finding = onlyFinding(run(src));
      expect(finding.data).toMatchObject({ mockedSpecifier: "./cart" });
      // It must be the line carrying the cart mock (4th line, 1-based).
      expect(finding.line).toBe(4);
    });
  });
});
