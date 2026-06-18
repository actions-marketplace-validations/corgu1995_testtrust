// ============================================================================
// src/core/ast.ts
// The ts-morph loader. Turns raw file inputs into the FROZEN `TestFileContext`
// objects that every detector + the regression engine consume.
//
// Design goals (why this file is so deliberately minimal):
//   1. PARSE, don't type-check. We only ever walk the syntax tree; we never ask
//      ts-morph for types, diagnostics, or symbols. So the Project is configured
//      to do the least possible work: no tsconfig discovery, no dependency
//      resolution, no lib files. Adding a source file must NEVER kick off a
//      program-wide type-check (that would be slow and could throw on code that
//      references modules we don't have).
//   2. One Project per run. Creating a ts-morph Project is comparatively
//      expensive; callers build it once via `createProject()` and reuse it
//      across every file in the run.
//   3. Head vs. base never collide. When a base (pre-change) version of a file
//      is supplied, it is parsed under a DISTINCT virtual path so it can coexist
//      with the head version inside the same Project.
//   4. Respect `exactOptionalPropertyTypes`. The optional `base*` fields are
//      OMITTED entirely (not set to `undefined`) when there is no base.
// ============================================================================

import { readFileSync } from "node:fs";
import { Project, ScriptKind, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { TestFileContext } from "../types.js";

/**
 * Suffix appended to a file path to derive the virtual path under which the
 * base (pre-change) version of that file is parsed. Kept distinct from any real
 * source path so head and base versions never collide inside the shared
 * Project. Exported so other modules can recognize/filter these synthetic files
 * if they ever enumerate `project.getSourceFiles()`.
 */
export const BASE_FILE_SUFFIX = ".testtrust-base.ts";

/**
 * The single normalized input shape accepted by {@link buildContext} and
 * {@link buildContexts}. The orchestrator (core/analyze.ts) produces these from
 * either explicit file args or a computed diff.
 */
export interface BuildContextInput {
  /** Path as the user referenced it (cwd-relative or absolute). The HEAD text
   *  is read from this path off the real disk. */
  filePath: string;
  /** Full text of the file on the base ref, when a base ref was supplied AND
   *  the file existed there. When present, a base SourceFile is parsed and the
   *  resulting context carries `baseSourceFile` + `baseText`. */
  baseText?: string;
  /** True when this file is part of the diff/changeset (vs. an explicit file
   *  argument). Copied straight onto the context. */
  isChanged: boolean;
}

/**
 * Create the single, shared in-memory ts-morph {@link Project} used for an
 * entire run.
 *
 * The configuration is tuned so that *adding a source file only parses it* —
 * it never triggers program-wide type resolution or errors:
 *   - `skipAddingFilesFromTsConfig` / `skipFileDependencyResolution`: never go
 *     hunting for a real tsconfig or follow imports. We grade test files in
 *     isolation; their dependencies are irrelevant to us.
 *   - `skipLoadingLibFiles`: we set `noLib` below, so the bundled standard-lib
 *     declaration files are pure overhead — don't load them.
 *   - compilerOptions:
 *       - `allowJs`            so plain `.js`/`.jsx`/`.mjs`/`.cjs` test files parse.
 *       - `jsx: Preserve`      so `.tsx`/`.jsx` files parse (JSX is preserved in
 *                              the AST rather than transformed/erased).
 *       - `noLib`              don't pull in lib.d.ts; we never need global types.
 *       - `isolatedModules`    treat every file as an independent module; no
 *                              cross-file program semantics.
 *
 * Note `JsxEmit` is not a top-level ts-morph export in v28; the JSX mode is
 * accessed via the bundled compiler namespace as `ts.JsxEmit.Preserve`.
 */
export function createProject(): Project {
  return new Project({
    // Don't discover or read a real tsconfig — we own the compiler options.
    skipAddingFilesFromTsConfig: true,
    // Never follow imports / resolve dependencies; we grade files standalone.
    skipFileDependencyResolution: true,
    // With `noLib` set we never consult lib files, so skip loading them.
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: true,
      // Preserve JSX so `.tsx`/`.jsx` parse without erasing/transforming it.
      jsx: ts.JsxEmit.Preserve,
      // No standard library declarations: we only walk syntax, never types.
      noLib: true,
      // Each file stands alone — no program-wide module graph semantics.
      isolatedModules: true,
    },
  });
}

/**
 * Choose the ts-morph {@link ScriptKind} for a file based on its extension so
 * the parser uses the correct grammar:
 *   - `.tsx`              -> TSX (TypeScript + JSX)
 *   - `.jsx`              -> JSX (JavaScript + JSX)
 *   - `.js` `.mjs` `.cjs` -> JS
 *   - everything else     -> TS  (default; `.ts`, `.mts`, `.cts`, no ext, …)
 *
 * This is derived from the ORIGINAL file path and applied to BOTH the head and
 * base SourceFiles, so the base file keeps the head file's grammar even though
 * its synthetic virtual path always ends in `.ts`.
 */
function scriptKindFor(filePath: string): ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ScriptKind.JS;
  }
  // `.ts`, `.mts`, `.cts`, and anything unrecognized parse as TypeScript.
  return ScriptKind.TS;
}

/**
 * Build a {@link TestFileContext} for ONE test file.
 *
 * The HEAD version's text is read from `input.filePath` off the real disk (the
 * only IO this module performs) and parsed into the shared Project under that
 * same path (with `overwrite: true`, so re-analyzing a path in the same run is
 * idempotent).
 *
 * When `input.baseText` is provided, a second SourceFile is parsed from that
 * text under the distinct virtual path `filePath + BASE_FILE_SUFFIX`, and the
 * returned context carries `baseSourceFile` + `baseText`. When it is absent,
 * those two fields are OMITTED entirely to satisfy `exactOptionalPropertyTypes`.
 *
 * @param project A Project from {@link createProject}, reused across the run.
 * @param input   Normalized file input ({@link BuildContextInput}).
 */
export function buildContext(project: Project, input: BuildContextInput): TestFileContext {
  const { filePath, baseText, isChanged } = input;

  // The grammar to parse with, taken from the real file's extension and shared
  // by the head and (if any) base SourceFile.
  const scriptKind = scriptKindFor(filePath);

  // Read the current (head) text off disk — the only filesystem read we do.
  const headText = readFileSync(filePath, "utf8");

  // Parse the head version under its real path. `overwrite: true` makes this
  // safe to call again for the same path within a single run.
  const sourceFile: SourceFile = project.createSourceFile(filePath, headText, {
    overwrite: true,
    scriptKind,
  });

  // Assemble the always-present fields first. `getText()` returns the head text
  // straight from the parsed SourceFile (which equals `headText`).
  const base: TestFileContext = {
    filePath,
    sourceFile,
    project,
    getText: () => sourceFile.getText(),
    isChanged,
  };

  // Only attach base* fields when a base version was actually supplied. Building
  // the object this way (rather than assigning `undefined`) keeps it compatible
  // with `exactOptionalPropertyTypes`, under which `baseSourceFile?: undefined`
  // is NOT assignable to an omitted optional property.
  if (baseText !== undefined) {
    const baseSourceFile: SourceFile = project.createSourceFile(
      filePath + BASE_FILE_SUFFIX,
      baseText,
      { overwrite: true, scriptKind },
    );
    return { ...base, baseSourceFile, baseText };
  }

  return base;
}

/**
 * Build {@link TestFileContext} objects for many files, reusing the one shared
 * Project. Order is preserved 1:1 with `inputs`.
 *
 * @param project A Project from {@link createProject}, reused across the run.
 * @param inputs  Normalized file inputs ({@link BuildContextInput}).
 */
export function buildContexts(
  project: Project,
  inputs: BuildContextInput[],
): TestFileContext[] {
  return inputs.map((input) => buildContext(project, input));
}
