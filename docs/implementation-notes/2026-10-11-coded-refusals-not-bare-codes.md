# 2026-10-11 — five refusals that put their code in the message field

**Issue:** #1645

## Design

`forbidden`, `badRequest` and their eleven siblings take a **message**:

```ts
export const forbidden = (message: string = 'Forbidden') =>
    new ForbiddenError(message);          // code defaults to 'FORBIDDEN'
```

Five call sites passed a CODE to one of them. The response then carried the
right token in the wrong field, which fails in both directions at once: a
client branching on `error.code` got the generic `FORBIDDEN` / `BAD_REQUEST`,
and a client rendering `error.message` could show a farmer the literal string
`MFA_REQUIRED`.

```
src/app-layer/context.ts                 forbidden('API_KEY_NOT_PERSON_SCOPED')
src/app-layer/context.ts                 forbidden('MFA_REQUIRED')
src/app-layer/context.ts                 forbidden('OPERATOR_SCOPE')
src/app-layer/usecases/farm-profile.ts   badRequest('FARM_PROFILE_EIK_NOT_EDITABLE')
src/app-layer/ai/budget.ts               forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')
```

All five are now `codedForbidden(code, message)` / `codedBadRequest(...)`.

## What made this invisible

Each of the five sat under a comment arguing — **correctly** — that a bare code
beats untranslatable English prose, because a message thrown from `src/lib` or
`src/app-layer` reaches the client verbatim and the iOS app renders the
envelope. Being deliberate about the code is what hid the mistake: the reasoning
was right and the helper it reached for was wrong. `codedForbidden` is the shape
that satisfies both halves — the code is the contract a client switches on, the
message is the English fallback for a code it has never heard of, and
`no-server-authored-user-copy` exempts a coded throw, so the sentence costs
nothing the comments were avoiding.

The second-order cost is the one worth recording. **These five codes were
invisible to every code-aware check in the repo.**
`tests/contracts/error-codes-are-documented.test.ts` derives its population from
the `coded*()` helpers and the two coded error classes, so a code emitted
through `forbidden` was not collected, was not on that test's undocumented
baseline, and was never required to appear in the spec. Converting them made
four of the five go red there immediately — which is the proof that the
conversion did something, not just the tidying it looks like.

**And three unit tests PINNED the defect.** `p1-5-get-user-ctx.test.ts` asserted
`message: 'API_KEY_NOT_PERSON_SCOPED'`, and `ai-budget` / `farm-profile-merge-
semantics` asserted `.rejects.toThrow(/CODE/)`, which matches the message. Nine
green tests reported that the code was being sent while `error.code` was
generic. All now assert `code`, and the sentence beside it, so a revert cannot
satisfy them by moving the token back.

## Document or baseline — decided per code, not in bulk

| code | where it went | why |
|---|---|---|
| `MFA_REQUIRED` | already in the spec | the shared 403 description names it |
| `API_KEY_NOT_PERSON_SCOPED` | shared 403 description | from `getUserCtx`, the choke point 11 person-scoped route files reach; 3 of their paths are not in the spec, so a per-operation list would be wrong by omission |
| `OPERATOR_SCOPE` | shared 403 description | same reasoning |
| `FARM_PROFILE_EIK_NOT_EDITABLE` | the PUT operation's 400 | one route, and it IS in the spec |
| `AI_BUDGET_REQUIRES_VERIFIED_FARM` | undocumented baseline | **no route that reaches it is in the spec** — the `COMPANY_NAME_TAKEN` case verbatim. Corrected 2026-10-31 (#2578): this row said "its only route is `/api/t/{slug}/ai/copilot`", which was wrong even in October — `knowledge/ask` reaches `completeWithRouting` through `safety/advisor.ts` — and that route has since been retired for having no caller. Both routes sit in the undocumented baseline, so the exemption holds; it is a property of the population, not of one path |

The two shared-403 entries say explicitly that their scope is **narrower** than
the four middleware codes above them: person-scoped routes only, and no tenant
route can answer either. Lumping them in with "reachable on EVERY route" would
have been the easier sentence and a false one.

## Files

| file | role |
|---|---|
| `src/app-layer/context.ts` | three conversions; the `assertSecondFactorPresented` docblock no longer defers to #1645 |
| `src/app-layer/ai/budget.ts` | one conversion |
| `src/app-layer/usecases/farm-profile.ts` | one conversion |
| `src/lib/openapi/paths/helpers.ts` | the two person-scoped codes in the shared 403 |
| `src/lib/openapi/paths/farm-profile.paths.ts` | `FARM_PROFILE_EIK_NOT_EDITABLE` on the PUT's 400 |
| `src/generated/openapi.json` | regenerated |
| `tests/guards/uncoded-helper-called-with-a-code.test.ts` | NEW — the class, held at zero |
| `tests/contracts/error-codes-are-documented.test.ts` | one baseline entry, with its reason |
| `tests/guards/farm-profile-eik-has-one-write-path.test.ts` | character window → brace-bound block |
| `tests/unit/{p1-5-get-user-ctx,ai-budget,farm-profile-merge-semantics}.test.ts` | nine assertions moved off `message` |

## Decisions

- **The helper population is DERIVED from `src/lib/errors/types.ts`**, not
  listed in the guard. Thirteen helpers take a bare `message` today; a
  fourteenth is in scope the moment it exists. `staleData` is the one worth
  naming — it carries a FIXED code (`'STALE_DATA'`) and still takes a message
  first, so `staleData('SOME_CODE')` would make `error.code` confidently wrong
  rather than merely generic. It was derived in rather than reasoned about,
  which is the argument for deriving.

- **There is no coded sibling for 401**, and the guard says so in its failure
  message. `UnauthorizedError` hard-codes `'UNAUTHORIZED'`, so `unauthorized` is
  in the population with nothing to migrate a violation to. Reported rather than
  excluded: the fix is a code parameter on that class, not something a call site
  can route around.

- **The closing quote is part of the detector's pattern.** Anchoring only the
  opening one matches `'MFA verification required.'` — three leading capitals
  and then prose — so a half-anchored pattern would have reported every call
  site this PR created as a violation.

- **Comments are blanked first, and that is load-bearing rather than hygiene.**
  The conversions deliberately leave SCARS: each call site quotes its old
  `forbidden('…')` form to explain what was wrong with it. Without blanking the
  guard would report every explanation of the defect as an instance of it.

- **The allowlist is empty, so the mutation proof is the teeth.** Zero live
  violations means every assertion passes over an empty selection, so the
  detector is run against synthetic sources in both directions and the
  DENOMINATOR is printed (13 helpers, 602 calls, 2146 files). Proved at a real
  call site too: restoring `forbidden('AI_BUDGET_REQUIRES_VERIFIED_FARM')` fails
  the guard naming `budget.ts:164`.

- **A character window broke, for the third time in this repo, and was replaced
  rather than widened.** `farm-profile-eik-has-one-write-path` asserted
  `said('eik')[\s\S]{0,600}?FARM_PROFILE_EIK_NOT_EDITABLE`; the four comment
  lines added here pushed the real throw to 641. `error-codes-are-documented`
  records the previous instance with the right conclusion — raising the constant
  fixes today's comment and leaves the next one to break it — so the bound now
  comes from the source: the enclosing `if (said('eik')) { … }` block, to its
  matching brace.

  The more interesting half is what the OLD pattern did on this diff. Against
  the raw file it still matched, 541 characters in — on the token inside the new
  comment. `blankNonCode` is the only reason it went red rather than silently
  grading a comment.
