# #1315 — the Security gate, fixed rather than exempted

*2026-10-06 · branch `fix/1315-audit-source-map-js-and-mammoth`*

Two advisories entered npm's feed after `main`'s last green run and reddened the
`Security` gate on every branch at once, blocking #1313 and #1316. `npm audit`
is a live registry query, so an unchanged lockfile audits differently on
different days — the lockfile blob was identical across `main` and every open
branch.

Neither advisory needed an exemption. That is the point worth recording,
because the obvious response to a time-triggered gate failure is to write one.

## source-map-js — a patched version existed

Vulnerable range `>=1.0.0 <1.2.2`; the tree held **1.2.1** and **1.2.2 was
published**. So this is an `overrides` floor, not a reachability argument. The
floor *is* the fix, which is why the guard asserts both the pin and the version
the lockfile actually resolved — an override the tree never applied is a
declaration, not a fix.

## sprintf-js — no patched version exists anywhere

`<=1.1.3` is vulnerable and 1.1.3 is latest, so no floor could help. `npm audit`
suggested downgrading `ioredis-mock` to 4.7.0, a semver-**major downgrade** that
does not touch the path that mattered. Taking a suggested fix because it is
suggested would have been the error here.

Two facts turned it from a judgement call into a deletion:

1. **The gate audits production only** (`npm audit --omit=dev`). The
   `ioredis-mock → fengari` and `ts-jest → … → argparse` paths are
   devDependencies and were never in scope. In the production tree `sprintf-js`
   had exactly ONE node: `node_modules/mammoth/node_modules/sprintf-js`.
2. **`mammoth` was dead.** It arrived in #948 for SharePoint DOCX policy sync;
   its only consumers — `integrations/providers/sharepoint/docx.ts` and
   `usecases/policy-sharepoint-sync.ts` — were deleted by the GRC teardown
   (#547). Repo-wide, `mammoth` appeared in `package.json` and nowhere else.

So it was dropped, per the rule `scripts/audit-exemptions.mjs` states in its own
comments: **"Removing a vulnerable package beats arguing it unreachable."** An
absent parser cannot be reached by any code path, reviewed or not.

## The reachability argument that was NOT needed, recorded anyway

Had removal been unavailable, the argument was already assembled, and it is
worth keeping because the next person will meet the same advisory:

The advisory is DoS via unbounded **precision specifiers** — it requires control
of the *format string*. `argparse@1.0.10` calls `sprintf` at three sites, all
with string literals:

```js
sprintf('ignored explicit argument %r', explicitArg)
```

An attacker controls `explicitArg`, not the `%` directives. That is the shape of
the argument; it was not needed because the package left the tree.

## Why a guard, given the fix is a deletion

Removal is strictly stronger than an exemption and strictly more fragile to
silent reversal — re-adding `mammoth` for a .docx feature reintroduces the
advisory, and the temptation then is to paste in an exemption rather than
re-argue the case. `tests/guardrails/docx-dependency-stays-out.test.ts` holds
both invariants, with a population floor on the "nothing imports it" claim so an
empty walk cannot read as clean.

Mutation-proved: re-adding `mammoth` reddens one case; drifting the override
back to `^1.2.1` reddens two; emptying the source walk reddens three.

## A process note, because it cost time

I used `git checkout package.json` to undo a mutation during the proof — on
**uncommitted** work. That reverted the fix itself rather than the mutation, and
the new test file, being untracked, kept its mutation. The subsequent "restored"
run was therefore measuring neither the fix nor a clean tree. Mutation proofs
need a file backup, not `git checkout`, until the work is committed.
