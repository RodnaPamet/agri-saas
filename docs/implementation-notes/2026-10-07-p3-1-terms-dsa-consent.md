# P3.1 — terms, a DSA contact point, and consent that records what was seen

*2026-10-07 · roadmap #1194*

Three public pages' worth of prose and one small schema change. The interesting
part is not the pages; it is what "capture consent" has to mean to be worth
capturing.

## I declined this item too broadly first

P3.1 reads "Terms (DSA Art 14), a DSA contacts page, an honest privacy notice,
consent capture." I recorded it as *legal text needing a lawyer* and stopped,
which was wrong about three of its four parts:

| part | what it actually is |
|---|---|
| Terms (DSA Art 14) | legal prose — genuinely the owner's call |
| a DSA contacts page | a page naming a point of contact; code |
| an honest privacy notice | `/privacy` already existed; a review of it |
| consent capture | a schema field, a checkbox, a recorded version; code |

Declining the item because one quarter of it needed a lawyer left a real gap in
what P3.8 had just shipped: the registration wizard had no consent control at
all, on the signup path of an EU social product. The owner's answer on the
remaining quarter was to draft the terms from what the software does and mark
the page clearly as an unreviewed draft.

## The banner is rendered from a constant, not placed by hand

`TERMS_ARE_LEGALLY_REVIEWED` in `src/lib/legal/terms.ts` is `false`, and the
page renders the draft banner only while it is. Flipping one boolean when a
reviewed version lands removes the banner.

The alternative — markup somebody deletes later — fails in the direction that
matters. A *reviewed* document still telling users it is unreviewed is as wrong
as the reverse, and only one of the two arrangements corrects itself. The same
reasoning puts `-draft` in `TERMS_VERSION`: a stored consent row reading
`2026-10-07-draft` cannot later be mistaken for acceptance of a reviewed
document, which a bare `1.0` would allow the moment a reviewed version exists.

## Consent records what the person SAW, which is why the client sends a version

The naive shape is a boolean column: `acceptedTerms`. It answers almost nothing
— not which terms, so not whether the person agreed to the ones now in force.

The next shape is a timestamp plus the server's current version. That is wrong
in a specific and silent way: somebody who loads the signup page, reads the
terms, and submits after a terms change is recorded as having accepted a
document they never saw. Nothing errors; the row simply says something untrue.

So the client sends the version it DISPLAYED, and the server refuses anything
other than what it is currently serving:

```
acceptedTerms !== true                 -> 400 terms_not_accepted
termsVersion !== TERMS_VERSION         -> 400 terms_version_stale { currentVersion }
```

Both before the password is hashed, for the same reason the Turnstile screen is
first: a refusal that runs after bcrypt still refuses, having already paid the
cost a flood is trying to impose.

`acceptedTerms` is compared for IDENTITY with `true`, not truthiness. A
`!acceptedTerms` check accepts `'yes'`, `1`, `{}` and `[]`, which means a client
that never rendered a checkbox can satisfy a consent gate by sending any
non-empty value. The route test drives all four.

`terms_version_stale` carries `currentVersion`, which does two jobs: the wizard
can say "the terms changed, please reload and read them" instead of a generic
failure, and the k6 enumeration probe can DISCOVER the live version instead of
hardcoding a second spelling of the constant in a file no build checks.

## The columns are nullable with no backfill, deliberately

```sql
ALTER TABLE "User" ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "acceptedTermsVersion" TEXT;
```

Every user who registered before this shipped genuinely has no consent record.
A `DEFAULT` would manufacture one. A null means "we do not know whether this
person accepted anything", which is true, and is what a reader should take from
it. `acceptedTermsVersion` is text rather than an enum so a superseded value
stays readable after the constant moves on — the column records a historical
fact, and an enum would force every old value to remain a member of the live
type.

## Both pages are public, and that needed two lists to agree

`/privacy` shipped broken once in exactly this way: allowlisted in the
tenant-isolation structural guard, so it was allowed to live outside
`/t/[tenantSlug]`, but absent from the middleware's public-path list — and in
production it answered `307 → /login`. Satisfying one of the two lists looks
identical to being finished.

Both new pages are worse to get wrong than `/privacy` was:

- `/terms` is linked from the consent checkbox. Behind a login wall, the only
  way to read the terms is to already hold the account you need them for.
- `/dsa-contact` exists so a restricted user, an authority or a court can reach
  us. Every one of those is, by definition, not signed in.

`tests/unit/legal-pages-public.test.ts` pins both lists for both pages.

## The address comes from configuration, and absence renders as absence

`DSA_CONTACT_EMAIL` is optional env. Unset renders a line saying no address is
configured — not a placeholder that reads as real. This repository is public and
the operator's own mailbox is not ours to publish; an authority writing to an
invented address is worse served than one told to ask. Same rule, and the same
reason, as the privacy notice's controller block.

## Files

| file | role |
|---|---|
| `src/lib/legal/terms.ts` | `TERMS_VERSION` + `TERMS_ARE_LEGALLY_REVIEWED`, the one place each is spelled |
| `src/app/terms/page.tsx` | the terms, with the constant-gated draft banner |
| `src/app/dsa-contact/page.tsx` | the DSA Art 11/12 point of contact |
| `src/app/api/auth/register/start/route.ts` | requires consent, checks the version, records both |
| `src/app/start/FarmWizard.tsx` | the checkbox; names the stale-version refusal |
| `src/app/start/page.tsx` | passes the served version down to the client |
| `prisma/schema/auth.prisma` + migration | the two nullable columns |
| `src/env.ts`, `deploy/env.prod.example` | `DSA_CONTACT_EMAIL` |
| `src/lib/auth/guard.ts` | both pages in `PUBLIC_PATH_EXACT` |
| `src/lib/openapi/paths/auth-public.paths.ts` | the two new required body fields |
| `tests/load/enumeration-timing.js` | discovers the version; fails loudly on a non-200 |

## Decisions

- **A required field on a documented route is a breaking API change, and this
  one is intentional.** The OpenAPI breaking-change gate flags it, correctly.
  Consent cannot be optional without defeating the point. #1371 tracks the iOS
  side, because a server-side check cannot know what a client calls — and it
  offers to add the version to `GET /api/auth/ui-config`, which the
  registration screen already calls, rather than making a mobile client probe
  for a 400.
- **The k6 script now fails on a non-200.** It posts to `register/start`, and
  every one of these refusals returns before bcrypt. Without the status check
  the timing comparison would have gone on collecting fast, uniform 400s and
  passing its p(95) threshold while measuring nothing — a green run over a void
  measurement, which is the failure mode that script exists to avoid.
- **One test was deleted for having no teeth.** It asserted the route stores
  the server constant rather than the request's value; the mutation proof
  showed all 27 tests stayed green when the write was switched to the request
  value. It cannot fail, because the equality check means the two are identical
  wherever the insert is reachable. The concern is about the CHECK, which two
  other tests cover. If that check is ever loosened the test becomes possible —
  the file says so, in place of the test.
- **`prisma format` was not run.** It rewrites 17 files and 484 lines with none
  of this change applied, so the committed schema is not format-canonical and
  CI does not enforce it. Carrying that cleanup here would have buried two
  added columns in a 248-line diff.
- **The privacy notice needed no edit.** Reviewed against the code as the item
  asks: its claims about encryption, isolation, consent recording and the
  retention window are all still implemented, and the retention figure is
  already rendered from the constants the sweep job runs on.
