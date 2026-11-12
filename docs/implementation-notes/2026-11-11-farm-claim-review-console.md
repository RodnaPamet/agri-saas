# 2026-11-11 — the farm-claim review console

**Issue:** #2963, closing #2974 with it. **Owner rulings (2026-11-10):** build
the page; wire DISPUTE as well as VERIFY; document `REJECTED` as reserved.

## What was missing, and what was not

P3.9 shipped the whole mechanism: `farm-identity-review.ts`, a keyed queue
route, a keyed verify route, a keyed dispute route — and all of them
**Edge-reachable**, measured by importing the real `isPublicPath` rather than
grepping for an entry. Nothing was severed.

What was missing is a way IN for a human. Measured 2026-11-10: **one claim,
PENDING since 2026-10-13** — 28 days — because reviewing it meant holding
`PLATFORM_ADMIN_API_KEY` and composing a request by hand. That is #2844's
shape, not the Edge shape: a complete, reachable mechanism nothing offers
anybody.

It is not cosmetic. `FarmIdentityClaim.status = VERIFIED` is what «verified
farm» means product-wide, and P9.3d's auto-hide needs three DISTINCT verified
farms and is arithmetically unreachable while the count is zero.

## A second door, because a browser cannot use the first

Both keyed routes gate on `verifyPlatformApiKey`. A browser holds no key, and
shipping one would inline a platform credential into every user's bundle —
`route-permissions.ts` already says exactly that about the flag console. #2706
established the answer and this copies it:

| | keyed, for scripts | session-gated, for the page |
|---|---|---|
| gate | `verifyPlatformApiKey` | `requirePermission('admin.manage')` **+** `assertPlatformSupport` |

Both halves of the second gate are load-bearing, and here more than for flags:
`FarmIdentityClaim` has no `tenantId` at all, so `admin.manage` alone would let
an ADMIN of any farm verify **another farm's identity** — not curate data a
farm reads, but assert who it is.

## The one real improvement: attribution

The keyed verify route reads `reviewedBy` from the **body**, so whoever holds
the key can type any name into the audit trail. The session routes take
`ctx.userId`, and their `Body` schemas have no such field — so these are the
first places in the review path where the trail names a person the Edge
authenticated rather than a string the caller chose. That is a partial,
surface-level answer to what #2735 exists for; the keyed routes are unchanged,
because scripts depend on that field.

## There is no approve button, by construction

`verifyFarmClaim` takes *"the ЕИК the reviewer found in the register. Never
read from the row."* The claim stores `eikHash` and no endpoint returns a
number, so the reviewer looks the farm up independently and types what they
find.

**#2963 as filed called the evidence question open.** It was answered in P3.4
and the answer is the shape of that input. A page with an «Одобри» button would
let somebody promote a claim without doing the lookup, which is the single
thing the input shape prevents.

## Refusing must be no harder than approving

The first draft wired VERIFY only. `disputeFarmClaim`'s own docblock is the
argument against that: it deliberately does not require an ЕИК, because *"a
reviewer who has established that the claim is wrong may not have a correct
number to supply, and demanding one would make the refusal path harder than the
approval path."*

A console where approving is a field and a button while refusing means a
terminal does exactly that, and the asymmetry nudges a reviewer toward
approval — the opposite of what identity verification wants. Owner ruling: wire
it.

It still asks for a **reason**, because both a reviewer's verdict and the
automatic `DISPUTED_COLLISION` leave `status = DISPUTED`, and without a reason
the row cannot say which happened. The reason is **not shown to the claiming
farm**, and the page says so — a reviewer cannot otherwise know whether they
are writing to the farm or to the next reviewer.

## Seven outcomes are not two

`EIK_MISMATCH` (422) is a retryable typo. `DISPUTED_COLLISION` (409) means two
farms claim one ЕИК and needs a decision between them — and it CHANGES this
claim's status, so the client revalidates on it and deliberately does not on a
plain mismatch. `ALREADY_VERIFIED` is a 200, because the usecase is idempotent
and a double submit must not read as failure.

The status map is copied from the keyed routes rather than re-derived: two doors
answering different statuses for one outcome is how a client comes to believe
two things about one claim.

## #2974, closed here

`REJECTED` stays, documented as reserved and unimplemented in the schema. The
`ClaimStatus` narrowing to three members is documented as deliberate, and the
premise under it — that nothing writes the fourth — is now a TEST rather than a
docblock. `listFarmClaims` casts (`r.status as ClaimStatus`), and a cast
removes the target a later mistake would fail against; implement rejection, and
a REJECTED row arrives typed as one of three with every consumer's `switch`
lacking an arm. The test fails first and names the narrowing.

**Two mistakes writing that test, both worth more than the test.** Its first
window was all of `src/` and it reported FIVE offenders, every one false:
`REJECTED` is a common enum member, and those were evidence reviews and
news-derived events. A detector that cannot tell one model's REJECTED from
another's is grading the wrong thing however loudly it fails. The population is
now files that touch the claim model, and the test prints the denominator —
6 of 2415 scanned, with a floor, because the check is an absence and a
population of zero would pass while saying nothing.

And `collectSourceFiles` returns ABSOLUTE paths; joining them with ROOT again
produced an ENOENT that read as a missing file rather than a bad join.

## Mutation proofs

Seventeen — nine on the client, eight on the routes.

| mutation | assertion that went red |
|---|---|
| Verify enabled with an empty field | a PENDING claim gets an ЕИК FIELD (both viewports) |
| one failure message for every outcome | EIK_MISMATCH and DISPUTED_COLLISION read DIFFERENTLY |
| no revalidate after a collision | REVALIDATES after a collision |
| revalidate after every refusal | does NOT revalidate after a plain mismatch |
| dispute acts on first click | offers DISPUTE, and it opens a form |
| dispute without a reason | offers DISPUTE, and it opens a form |
| controls on a resolved claim | a resolved claim gets NO controls |
| filter client-side | asks the SERVER for the filtered status |
| client sends a reviewer name | sends the typed ЕИК and no reviewer name |
| `reviewedBy` **forged end-to-end** | IGNORES a `reviewedBy` supplied in the body |
| drop `assertPlatformSupport` (×2 routes) | runs BOTH gates (×2) |
| `EIK_MISMATCH` → 409 | maps EIK_MISMATCH to 422 |
| `ALREADY_VERIFIED` → 409 | maps ALREADY_VERIFIED to 200 |
| ignore the status filter | honours an explicit status |
| weaken to `admin.view` | runs BOTH gates |

**The attribution property needed a COMBINED mutation**, and that is the
finding. Adding `reviewedBy` to the schema alone changes nothing (the handler
still reads `ctx`), and preferring the body alone changes nothing (zod strips
the field). Each single-site mutation is *unable to express* the defect; only
both together forge attribution, and that kills the right assertion. The
property is defended in two places, which is why no one-line change breaks it.

**Two false passes of my own, both caught by running the tests.** My fake
request lacked `headers` and `nextUrl`, so `withApiErrorHandling` threw a
TypeError before any handler ran — and two `rejects.toThrow()` assertions,
written with no shape, accepted it. They read the response status now, which is
what a client sees. And the mock of `requirePermission` passed `params`
through unresolved, where the real wrapper awaits it (GAP-05), so every id
would have been `undefined`.
