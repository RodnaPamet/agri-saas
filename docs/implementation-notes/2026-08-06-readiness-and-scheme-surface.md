# 2026-08-06 — Readiness that means something, and a scheme page you can open

**Commit:** `feat(schemes): make readiness a real ratio and /schemes a real surface`

Five defects. Four are one number that was wrong in three independent ways;
the fifth is a page that promised a click and had nowhere to go.

## Design

### The number was wrong three times over

`auto-evidence.ts` states the guarantee in its own header — *"Readiness scoring
only counts APPROVED evidence, so nothing unreviewed silently inflates a
scheme's readiness"* — and `scheme-pack.ts` implements it correctly. Coverage
did not.

**1. The evidence query had no filter.** The status half was fixed in #489; the
`where` clause was still absent entirely, so a soft-deleted or archived
APPROVED row went on satisfying its control. Evidence a farm had explicitly
removed kept propping up its certification score. `scheme-pack.ts` filters
status, `deletedAt` and `isArchived`; coverage filtered one of the three, and
only in memory.

Status stays unfiltered *at the query* on purpose — the `awaitingReview`
breakdown needs to see SUBMITTED rows to tell "nobody filed anything" apart
from "waiting on a reviewer".

**2. The formula subtracted counts from a percentage.**

```
readinessScore = coveragePercent − missingEvidence×2 − overdueTasks×3
```

Three consequences, each silent:

- **Not comparable across schemes.** The same farm scores differently on a
  7-point demo and a 200-point standard, because the subtrahend grows with the
  control count while the minuend is capped at 100.
- **Saturates at 0.** Fifty controls missing evidence is −100. Every serious
  standard reads zero regardless of actual progress, so the number stops
  distinguishing a farm that has done nothing from one that is nearly there.
- **The overdue term was structurally always 0.** Pack templates set no
  `dueAt` (`catalog-applier.ts`), and the overdue test requires one. A third of
  the formula could never fire.

And it produced **92 on a completely empty farm**, because it started from
mapping coverage — which a pack install sets to 100 — and subtracted from
there. That number is printed on a farmer-facing PDF with a `%` suffix.

Readiness is now `satisfied ÷ applicable`: control points backed by approved
records, over control points this farm can actually satisfy.

**3. Per-requirement satisfaction did not exist.** `coveragePercent` asks only
"does a control row LINK to this requirement". A link is a promise to do the
work, not the work — which is why installing a starter pack produced 100%
instantly, **and fired the confetti milestone**, on a farm with zero records.
The milestone now waits on `satisfiedPercent`; congratulating someone for
pressing Install is worse than not celebrating at all.

Three states, not two, and the detail page renders all three:

| state | meaning |
|---|---|
| **satisfied** | a mapped control holds approved evidence |
| **mapped only** | a control exists; nothing approved against it yet |
| **not started** | nothing claimed for this control point at all |

**Applicable** excludes requirements whose every mapped control is
`NOT_APPLICABLE`. A farm with no livestock cannot satisfy a livestock control
point, and counting it against them would put 100% permanently out of reach for
a real holding. An **unmapped** requirement is *not* N/A — nothing has been
claimed for it, so it stays in the denominator and the score says so.

### The certifier pack shipped without its Statement of Applicability

Three defects in `packs.ts`, stacked so that each hid the next.

`entityType: 'EXPORT_ARTIFACT'` was cast with `as AuditPackItemEntityType` and
a comment reading *"not yet in enum; pending schema migration"*. The migration
never landed, so the insert threw on the enum constraint **every time** — and
the throw was swallowed by a bare `catch {}` around the whole block. A pack
frozen for a certifier shipped with no SoA, silently, always. The enum value is
added; the failure is now logged. It stays non-fatal (the freeze already
committed, and unwinding it would lose the snapshots) but non-fatal must not
mean invisible.

With that fixed, the second defect became reachable: `getSoA` was called with
no `frameworkKey`, so `soa.ts` fell back to `resolveInstalledFrameworkKey` —
the alphabetically-first installed key. **A GlobalG.A.P. pack would have
shipped an EU-Organic SoA**, correctly formatted and about the wrong standard,
which an auditor has no way to detect. The key now comes from the pack's own
`FRAMEWORK_COVERAGE` item.

Third: the freeze switch had no `FRAMEWORK_COVERAGE` case, so it fell to
`default` and froze `{ entityType, entityId, snapshotAt }` — a stub naming an
id — while `scheme-pack.ts` documented the opposite ("the existing freeze flow
fills it from the live entity at freeze time"). It now snapshots real coverage,
including the satisfaction figures.

### /schemes was a dead end

Rows carried `hover:bg-bg-muted`, which promises a click, and had no
`onRowClick`. There was no `[schemeKey]` route to click through to. The only
working adoption path — `installPack`, which genuinely creates controls and
requirement links — sat at `/frameworks/[key]/install`, reachable only through
the command palette.

New: a scheme detail page answering the three questions someone actually has in
front of a standard — what does it require, how much of it have I got, what do
I do next — with an **Adopt this scheme** action wired to `installPack` and the
applicability CSV export surfaced (both export routes existed with zero UI
callers).

Two smaller things on the list page:

- The `loading` flag was `isLoading && !data`. `fallbackData` is always
  supplied by the server component, so `data` is never undefined and the flag
  was **permanently false**. With server-rendered initial data there is nothing
  to wait for on first paint; the real loading is a revalidation with nothing
  to show.
- `error` was never passed. A failed refetch fell through to the empty state,
  which reads as "this platform has no certification schemes" — a very
  different claim from "the request failed". Gated on having nothing to show,
  so a failed background refetch keeps stale rows on screen.

### Dead code removed on the way past

`getSchemeReadiness` was a one-line wrapper over `generateReadinessReport` with
**zero callers** — no route, no page, no test — alongside
`CACHE_KEYS.schemes.readiness` pointing at `/schemes/:key/readiness`, a route
that has never existed. Nothing fetched it, so nothing broke; it just described
a surface that was not there.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/framework/coverage.ts` | evidence `where`; per-requirement satisfaction; readiness as a ratio; satisfaction exposed from `computeCoverage` |
| `src/app-layer/usecases/audit-readiness/packs.ts` | SoA attachment logged not swallowed; right framework; `FRAMEWORK_COVERAGE` snapshot |
| `prisma/schema/enums.prisma` + migration | `EXPORT_ARTIFACT` |
| `src/app-layer/usecases/certification-scheme.ts` | `getSchemeDetail`; dead readiness wrapper removed |
| `src/app/api/…/schemes/[schemeKey]/route.ts` | **new** — scheme + this farm's progress |
| `src/app/t/…/schemes/[schemeKey]/{page,SchemeDetailClient}.tsx` | **new** — detail page, adopt, export |
| `src/app/t/…/schemes/SchemesClient.tsx` | clickable rows; loading + error fixed |
| `src/app/t/…/frameworks/[frameworkKey]/page.tsx` | confetti waits for satisfaction |
| `src/lib/swr-keys.ts` | `detail` added, dangling `readiness` removed |

## Decisions

- **Ratio, not a penalty score.** Subtracting counts from a percentage cannot
  be made to work by tuning the coefficients — the units don't match. The only
  fix is to compute the thing the label claims.
- **Filter deleted/archived at the query, status in memory.** The status
  breakdown genuinely needs the unfiltered rows; the other two conditions have
  no such use and belong in the WHERE.
- **Unmapped ≠ not applicable.** Both leave a requirement unsatisfied, and
  conflating them would let a farm raise its score by never mapping anything.
- **The SoA failure stays non-fatal but becomes loud.** Throwing would unwind a
  freeze that already committed and lose the snapshots; swallowing is what shipped
  packs without their SoA for months. Logging is the only option that is both.
- **Adopt reuses `installPack` rather than a new path.** It already does the
  right thing — creates controls, links requirements, in one transaction. The
  defect was that it had no reachable entry point, not that it was wrong.
