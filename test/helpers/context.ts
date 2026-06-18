import { Project } from "ts-morph";
import type { TestFileContext } from "../../src/types.js";

export interface MakeContextOptions {
  /** Pre-change (base ref) source. When provided, base* fields are populated
   *  so regression rules can run. */
  baseText?: string;
  /** Virtual path; controls inferred framework/extension. Default a .test.ts. */
  filePath?: string;
  isChanged?: boolean;
}

/**
 * Build a TestFileContext from inline source text for unit tests — no disk, no
 * git. Mirrors what src/core/ast.ts produces at runtime: a head SourceFile and,
 * when baseText is given, a base SourceFile under a distinct virtual path.
 */
export function makeContext(headText: string, options: MakeContextOptions = {}): TestFileContext {
  const filePath = options.filePath ?? "virtual/sample.test.ts";
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });
  const sourceFile = project.createSourceFile(filePath, headText, { overwrite: true });
  const ctx: TestFileContext = {
    filePath,
    sourceFile,
    project,
    getText: () => headText,
    isChanged: options.isChanged ?? true,
  };
  if (options.baseText !== undefined) {
    ctx.baseSourceFile = project.createSourceFile(
      `${filePath}.testtrust-base.ts`,
      options.baseText,
      { overwrite: true },
    );
    ctx.baseText = options.baseText;
  }
  return ctx;
}
