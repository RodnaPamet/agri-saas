# 2026-11-07 — P6's missing entry point, and a guard for the class

**Commit:** `<pending> fix(nav): mount the public-profile and usage consoles`

## What was wrong

`/admin/public-profile` shipped with P6: route resolving, flag on, `/robots.txt`
allowing `/f/`, sitemap rendering. It was linked from **nowhere** — not the
`/admin` hub, not `canonical-parents.ts`, not the sidebar.

```
FarmBrand rows in production ....... 0
  with a handle .................... 0
  published ........................ 0
PublicFarmProfile projections ...... 0
```

Not "profiles nobody visits" — **not one farm had ever started a brand**,
because the only path to the screen was typing a URL nobody had seen. #2782
framed P6's problem as adoption. It was construction, in the one place nothing
looked.

Every P6 check asked whether the surface was REACHABLE and it was. None asked
whether a person could FIND it.

## What shipped

- A `/admin` hub pill for `/admin/public-profile`, gated on
  `social.public-profile`, resolved server-side — absent rather than disabled
  when off, since a disabled control advertises a feature that does not exist.
- A `canonical-parents.ts` entry so its breadcrumb resolves.
- A pill for `/admin/usage` as well, gated on `isPlatformTenant` ∧ `canAdmin`:
  the guard found it, and the platform operator had no discoverable path to
  their own console either. Server-gated, so another tenant is told nothing —
  that page answers `notFound()` rather than a denial precisely because a
  denial would confirm there is a surface worth looking for.
- `tests/guards/pages-are-reachable.test.ts`.

## The guard found four pages, and two were real defects

| page | verdict |
|---|---|
| `/admin/public-profile` | **defect** — P6's. Mounted. |
| `/admin/usage` | **defect** — platform console, unreachable even for the operator. Mounted. |
| `/issues/[issueId]` | deliberate: a legacy redirect to `/farm-tasks/[id]`, kept for bookmarks. |
| `/grain/payroll` | deliberate: retired surface kept as a redirect to `/grain/costs`. |

The two redirects are in `DELIBERATELY_UNLINKED` with reasons; being unlinked
is the *point* of a bookmark catcher.

## The guard was useless twice before it worked, and the mutation proof is why

Each version passed its own tests. Each was confirmed useless by removing the
hub pill — the exact defect — and watching the suite stay green.

1. **First version**: `src/generated/` excluded, nothing else. Green with the
   pill removed, because `src/lib/assistant/generated/page-routes.ts` is a
   generated inventory of *every* route — so under a naive scan every page is
   always linked and the guard can never fail. `canonical-parents.ts` did the
   same: it says where you came FROM, not that anything takes you there.
2. **Second version**: both registries excluded. Still green, because
   `/admin/public-profile` is named in two **docblocks**. My own comment had
   waved this away — "a docblock citation still counts, which is a known
   looseness… the alternative is stripping comments from 2,389 files" — and
   that reasoning was the whole bug. Nobody can click a docblock.
3. **Third version**: comments blanked via the shared `blankNonCode`. Catches
   it, and immediately found `/grain/payroll` too.

Then: 53 seconds, because blanking sat inside the per-route loop — 78 routes ×
2,387 files. Blanking once into a cache is the same answer in 3.8s. A slow
guard is one somebody eventually moves out of the default population.

## Each protection is proved load-bearing, not just present

A loosening is invisible while every page is linked, so each was paired with
the P6 defect:

| mutation | result |
|---|---|
| remove the pill | **fails** — the guard catches the defect |
| remove the pill + don't blank comments | passes — blanking is load-bearing |
| remove the pill + let the assistant inventory count | passes — that exclusion is load-bearing |
| remove the pill + let `canonical-parents` count | passes — that exclusion is load-bearing |
| remove the usage pill | **fails** |

Two protections are **defensive and unproven**, stated rather than implied: the
own-directory rule (a page citing its own path is not a way in) and the
terminator on the link pattern (without it `/exchange` matches inside
`'/exchange/threads'`, so a parent reads as linked because a child is). Neither
has an observable effect on today's repo, because no page depends on them yet.
