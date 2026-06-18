# testtrust

> Grade whether your tests actually test anything.

[![CI](https://github.com/corgu1995/testtrust/actions/workflows/ci.yml/badge.svg)](https://github.com/corgu1995/testtrust/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](#install)

`testtrust` reviews your **test files** — not your product code — and flags the ways a
suite goes green without verifying anything. Its headline feature is the one thing no
other tool catches: **an assertion that was silently weakened, deleted, or skipped to
turn a failing test green** — the favourite move of a coding agent told *"make CI pass."*

It runs on a diff in CI, emits a **0–100 Test-Trust score** and a `pass` / `neutral` /
`fail` gate verdict, and is tuned to be quiet on legitimate refactors so the gate stays
trusted, not muted.

```
Score: 51/100   Verdict: FAIL   (fail under 60)

s/auth.test.ts:5  warn  assertion-weakened
  Assertion on "user" in test "auth > returns the user" was weakened from
  `toEqual` to `toBeTruthy`, so it now catches fewer bugs.
s/auth.test.ts:7  warn  assertion-deleted
  Test "auth > has a token" asserted something on the base ref but now has no
  assertions (removed or commented out).
s/auth.test.ts:10  warn  test-skipped
  Test "auth > checks role" was running on the base ref but is now skipped.
```

## Why

Coding agents now write a large share of new code, and they game coverage gates: they
stub the system under test, write assertion-free or snapshot-only tests, add tautologies
like `expect(x).toBe(x)`, and — most insidiously — **loosen or delete existing
assertions** to flip a red test green. Coverage stays at 100%; the bug ships.

- Diff reviewers (CodeRabbit, Greptile, Qodo) grade the *product* code, not whether the
  tests mean anything.
- Classic mutation tools are too slow to run on every PR.

`testtrust` grades the *tests*, fast (static analysis + a base-branch diff — it never runs
your suite), and it's the only tool that flags an assertion getting weaker from one commit
to the next.

## Install

An npm release is planned. Until then, run from source:

```bash
git clone https://github.com/corgu1995/testtrust
cd testtrust
npm install
npm run build
node dist/cli.js --help
# optional: `npm link` then use `testtrust` anywhere
```

> Requires Node ≥ 18.18 (developed and tested on 22).

## Usage

### On specific files (local)

```bash
testtrust "src/**/*.test.ts"
```

```
testtrust  v0.1.0
Score: 78/100   Verdict: NEUTRAL   (fail under 60)
Analyzed 1 file · 3 findings (0 fail · 2 warn · 1 info)

src/cart.test.ts:6  warn  tautology
  This assertion compares a value to itself via .toBe() and can never fail.
      6 | expect(total).toBe(total);
        |              ^
```

### On a diff (CI) — unlocks the regression wedge

```bash
testtrust --base origin/main --format json
```

In diff mode, `testtrust` resolves the merge-base, finds the changed test files, loads
each file's **head and base versions**, and runs the regression rules that catch
weakened / deleted / skipped assertions. JSON output is a stable, CI-friendly artifact:

```json
{
  "version": "0.1.0",
  "mode": "diff",
  "baseRef": "origin/main",
  "score": { "score": 51, "verdict": "fail", "failThreshold": 60, "totalFindings": 5, "...": "..." },
  "findings": [
    { "ruleId": "assertion-weakened", "severity": "warn", "file": "s/auth.test.ts", "line": 5,
      "message": "Assertion on \"user\" ... weakened from `toEqual` to `toBeTruthy` ...",
      "data": { "baseMatcher": "toEqual", "headMatcher": "toBeTruthy" } }
  ]
}
```

### In GitHub Actions

```yaml
name: test-trust
on: pull_request
jobs:
  test-trust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the regression rules diff against the base
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx testtrust --base "origin/${{ github.base_ref }}" --fail-under 60
```

The step fails (exit 1) only when the verdict is `fail`.

## What it detects

| Rule | Severity | What it catches |
|------|:--------:|-----------------|
| **`assertion-weakened`** | warn / info | An existing assertion downgraded to a weaker matcher (`toEqual`→`toBeTruthy`). `warn` when it collapses to a vacuous check; `info` for milder, often-legitimate loosenings. |
| **`assertion-deleted`** | warn | A test that asserted something on the base ref now has no assertions (removed or commented out). |
| **`test-skipped`** | warn | A previously-running test is now `.skip`/`xit`/`describe.skip`/`.todo`. |
| `assertion-free` | warn / info | A test that runs code but asserts nothing. |
| `snapshot-only` | warn | A test whose only assertion is `toMatchSnapshot()`. |
| `tautology` | warn / info | An assertion that can never fail (`expect(x).toBe(x)`, `expect(true).toBe(true)`). |
| `over-mocking-sut` | warn | The module the test is named after is itself mocked (partial mocks that keep the real impl are not flagged). |
| `trivial-assertion` | info | The only check is a weak matcher (`toBeDefined`, `not.toThrow`) that pins no concrete value. |

The first three require a base ref (diff mode); the rest run in both modes.

## Score, verdict & exit codes

- **Score** starts at 100; each finding subtracts a weight (heaviest for the regression
  rules). `info` findings count half.
- **Verdict**: `fail` if any finding is severity `fail` **or** the score is below
  `--fail-under`; else `neutral` if there are any `warn` findings; else `pass`.
- **Exit codes** (the CI contract): `0` pass/neutral · `1` fail · `2` usage error · `3` runtime error.

`neutral` never blocks CI — by design, so a single advisory finding can't mute the gate.

## Options

```
testtrust [files...] [flags]

  -b, --base <ref>      diff against this git ref (enables diff mode + regression rules)
  -f, --format <fmt>    human (default) | json
      --fail-under <n>  score at/under which the verdict is fail (default 60)
      --rule <id[:sev]> enable only the listed rule(s); optional :severity; repeatable
      --disable <id>    disable a rule; repeatable
      --cwd <dir>       project root (default: cwd)
      --no-color        disable ANSI color (also honors NO_COLOR)
  -q, --quiet           suppress progress logging on stderr
  -V, --version    -h, --help
```

## How it works

`testtrust` parses test files with [ts-morph](https://ts-morph.com) and reasons purely
over the syntax tree — it **never executes your tests**. In diff mode it reads each
changed file's base-branch version via `git show`, pairs tests by their `describe > it`
title path, pairs assertions by subject, and uses a conservative matcher-strength model
to decide whether an assertion genuinely got weaker. Precision is the priority: when in
doubt, it stays silent.

## Scope (v1)

**In:** Jest/Vitest-style JS/TS tests, static smells + the base-branch regression wedge,
human + JSON output, a CI gate.

**Not yet:** mutation testing (the planned Layer 2), a hosted dashboard, frameworks beyond
Jest/Vitest, config files, and baseline/suppression. Contributions welcome.

## Contributing

Issues and PRs welcome. `npm run lint && npm run typecheck && npm test` must pass (CI
enforces it). Detectors live one-per-file under `src/detectors/`; add one with a single
entry in `src/core/registry.ts`.

## License

[MIT](./LICENSE) © Santiago Parra
