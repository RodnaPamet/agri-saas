# 2026-09-10 — the required `Lint` check could not fail

**Branch:** `fix/874-lint-gate-cannot-fail` · Refs #874

## Design

`Lint` is a required context on this repo. It runs `npm run lint`, which was
`package.json:47` = `cross-env ESLINT_USE_FLAT_CONFIG=true eslint .` — no
`--max-warnings`. ESLint exits 0 on warnings, so the job was green over every
warning in the tree. `next.config.js:147` sets `eslint.ignoreDuringBuilds:
true`, so `Build` was not a backstop either.

That is the empty-selection shape one level up: the gate's unit of work was
"errors", the tree had none, and the 159 findings it *did* produce were
invisible to the exit code. It is not hypothetical — `react-hooks/rules-of-hooks`
was one of the rules downgraded to `warn`, and the crash that #872 had to
repair (a
`useMemo` after an early return, hook count 2 → 3) is exactly what that rule
reports.

Two levers close it:

1. **Promote the rule that matters to `error`.** An error-level rule makes
   ESLint exit non-zero regardless of `--max-warnings`, so the gate can fail
   today without waiting for the whole warning backlog.
2. **`--max-warnings=0`**, which needs the count at 0 first. Not done — see
   *Left undone*.

## Measurement

Full-repo `npx eslint . -f json`, branched from `33f01ed`:

| count | rule | real? |
|------:|------|-------|
| 37 | `react-hooks/exhaustive-deps` | real, ~30 are a missing `t` from next-intl |
| 34 | unused `eslint-disable` directives | real, mechanically removable |
| 33 | `react-hooks/set-state-in-effect` | real, deferred epic |
| 33 | `@typescript-eslint/no-explicit-any` | all in `tests/`; rule is `warn` by policy |
| 8 | `react-hooks/refs` | real, deferred epic |
| 5 | `@next/next/no-location-assign-relative-destination` | real rule, **deliberate** call sites |
| 4 | `react-hooks/rules-of-hooks` | **false positives** — `use*` naming heuristic |
| 2 | `react-hooks/immutability` | real, deferred epic |
| 1 | `react-hooks/error-boundaries` | real, deferred epic |
| 1 | `react-hooks/purity` | real, deferred epic |
| 1 | `jsx-a11y/role-has-required-aria-props` | real, test fixture |

**159 warnings, 0 errors, exit 0.**

## Decisions

- **The four `rules-of-hooks` hits are the naming heuristic, and the fix is a
  RENAME, not a suppression.** `useSecureCookies` (`src/lib/auth/sso-session.ts`,
  flagged at three call sites) derives a boolean from `NEXTAUTH_URL` and
  contains zero React hooks — it runs in route handlers and in
  `establishSsoSession`, on the server. `useTemplate`
  (`TemplateLibraryModal.tsx`) is an `onClick` handler. A `use*` prefix on a
  non-hook misleads humans as well as ESLint, so they became
  `secureCookiesEnabled` and `applyTemplate`. That is what lets the rule be an
  `error` with zero violations rather than an `error` with four disables.

- **`--max-warnings=0` is deliberately NOT set.** Setting it would have
  required suppressing 120 findings, which is the same defect wearing a
  different hat: a gate that passes because nothing is looked at. The flag goes
  in when the count is genuinely 0.

- **The React-compiler family stays at `warn`.** `eslint.config.mjs` already
  records why (`~140 existing call sites`, migration is its own epic); the 45
  remaining hits across `set-state-in-effect` / `refs` / `immutability` /
  `error-boundaries` / `purity` are each a real refactor of a hot client
  component. `rules-of-hooks` is separated out of that block because its
  failure mode is a runtime crash, not a render inefficiency.

- **`exhaustive-deps` needs per-hook verification, not a sweep.** The common
  case is a missing `t` from `useTranslations`. `t` is a `useMemo` over nine
  `IntlContext` values (`use-intl/dist/.../react.js`), so its referential
  stability is a property of the provider, not of the call site. Adding an
  unstable `t` to a `useEffect` dependency array that fetches is a refetch
  loop. ~30 dep arrays across `PersistedProcessCanvas`, the admin pages and the
  journal modal is not a change to make blind.

- **The five `no-location-assign-relative-destination` sites were read and are
  all deliberate.** Three are hard reloads immediately after an auth-state
  change (`change-password`, `reset-password`, `revoke-current` → `/login`),
  where dropping the client cache is the point; two are the
  "Go to Dashboard" escape hatch in `error.tsx` / the tenant `error.tsx`, where
  the React tree has already crashed and `router.push` would keep it. Each
  wants a reasoned `eslint-disable-next-line`, but five disables do not reach
  zero on their own, so they were left visible rather than papered over.

- **`no-explicit-any` stays `warn` by existing policy.** CLAUDE.md's
  codebase-hygiene section states the rule is intentionally `warn` and that the
  `as any` ratchet (`tests/guardrails/no-explicit-any-ratchet.test.ts`) is the
  enforcement. All 33 hits are in `tests/`. Changing that is a policy decision,
  not lint hygiene, and does not belong in this PR.

## Left undone

`--max-warnings=0`, and the 120 warnings behind it, in the five categories
above. The gate can now fail on `rules-of-hooks` and on any future error-level
rule; it still passes over those 120.
