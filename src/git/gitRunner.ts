// ============================================================================
// src/git/gitRunner.ts
// The single low-level chokepoint for shelling out to `git`. Every other module
// that needs git data goes through runGit() here — nothing else in the codebase
// spawns a child process. Keeping all process invocation in one tiny file makes
// the surface trivial to audit, mock in tests, and reason about on Windows.
// ============================================================================
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Promisified execFile. We use execFile (not exec) deliberately: it does NOT
 *  spawn a shell, so arguments are passed as a literal argv array and there is
 *  no shell-quoting/injection surface, regardless of what a ref or path
 *  contains. This also behaves identically across POSIX shells and Windows. */
const execFileAsync = promisify(execFile);

/** Upper bound on captured stdout/stderr. `git show <base>:<path>` can return a
 *  whole file blob, so the default 1 MiB exec buffer is far too small; 64 MiB
 *  comfortably covers any realistic source/test file while still bounding RAM. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Thrown when `git` exits non-zero (or the process can't be spawned at all).
 *  Carries the raw exitCode and stderr so callers can branch on *why* git
 *  failed — e.g. diff.ts distinguishes "blob does not exist on base" (a normal,
 *  expected condition for newly-added files) from a genuine error. */
export class GitError extends Error {
  /** Process exit code, or null when git could not be spawned (e.g. not on
   *  PATH) or was killed by a signal before producing a code. */
  readonly exitCode: number | null;
  /** Captured stderr text from git, trimmed. Empty string when none. */
  readonly stderr: string;
  /** The argv passed to git, retained for diagnostics/error messages. */
  readonly args: readonly string[];

  constructor(
    message: string,
    options: { exitCode: number | null; stderr: string; args: readonly string[] },
  ) {
    super(message);
    this.name = "GitError";
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
    this.args = options.args;
    // Restore the prototype chain so `instanceof GitError` works after the
    // TS/Babel down-level of `extends Error` (the well-known ES5 target caveat;
    // harmless and correct under our ES2022 target too).
    Object.setPrototypeOf(this, GitError.prototype);
  }
}

/** Shape of the error object Node attaches when execFile fails. Node augments a
 *  plain Error with these fields; we narrow to them instead of using `any`. */
interface ExecFileError extends Error {
  code?: number | string;
  /** Present when the child was terminated by a signal rather than exiting. */
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

/** Normalize execFile's stdout/stderr (string under the default utf8 encoding,
 *  but typed as string | Buffer) into a plain string. */
function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Run `git` with the given argv array in `cwd` and resolve with its trimmed
 * stdout. This is the ONLY function in testtrust that launches a subprocess.
 *
 * @param args - argv passed verbatim to git (no shell, so no quoting needed).
 * @param cwd  - working directory git runs in (the repo root the run targets).
 * @returns trimmed stdout on success (exit 0).
 * @throws {GitError} on any non-zero exit or spawn failure, carrying exitCode + stderr.
 */
export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      // utf8 so blobs/diffs come back as strings; git emits forward slashes in
      // paths on every platform, and we intentionally preserve them.
      encoding: "utf8",
      // Keep the environment pristine so locale/i18n settings can't translate
      // git's porcelain/plumbing output out from under our parsers.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      // Never let git block waiting on an interactive credential prompt.
      windowsHide: true,
    });
    return toText(stdout).trim();
  } catch (err) {
    const e = err as ExecFileError;
    // `code` is the numeric exit code for a process that ran and exited; for a
    // spawn failure (git not found) it is a string like "ENOENT". Normalize to
    // a number | null so GitError.exitCode has a stable type.
    const exitCode = typeof e.code === "number" ? e.code : null;
    const stderr = toText(e.stderr).trim();
    const detail =
      stderr ||
      e.message ||
      (typeof e.code === "string" ? `git failed to start (${e.code})` : "git failed");
    throw new GitError(`git ${args.join(" ")} failed: ${detail}`, {
      exitCode,
      stderr,
      args,
    });
  }
}
