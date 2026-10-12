# 2026-10-12 — the platform console was never reachable in production (#1669)

**Commit:** pending

## Design

`assertPlatformSupport` is fail-closed: with `PLATFORM_TENANT_SLUG` unset,
`isPlatformTenant` returns false for every tenant and the console is unreachable
rather than universally reachable. `platform-support.ts` argues for that
direction explicitly, and it is right — an env var that silently grants global
write access when blank is a far worse failure.

**The gap is that losing the feature produces no signal.** "Deliberately closed"
and "never configured" are the same observation from outside, and on the
`agrent` VM they have been the same observation since #12 merged. Probed
2026-10-12, PRESENT/ABSENT only:

```
PLATFORM_TENANT_SLUG:    ABSENT
DSA_CONTACT_EMAIL:       ABSENT     (known — #1599)
PLATFORM_ADMIN_API_KEY:  PRESENT
```

So every route behind the gate — `admin/promotions`,
`admin/promotions/[id]/image`, `admin/companies/[id]`, `admin/market-prices` —
has been inert in production. The global catalogues (`Company`, `Promotion`,
market prices) could only ever be changed by direct database access or a seed.

`capabilities.platformConsole` on `/api/readyz` closes it: the #781 treatment,
WATCHED rather than gated.

## Files

| file | role |
|---|---|
| `src/lib/auth/platform-console-capability.ts` | the four-state probe |
| `src/app/api/readyz/route.ts` | reports it, outside `checks`/`failed` |
| `deploy/env.prod.example` | points an operator at the probe instead of this file |
| `tests/unit/platform-console-capability.test.ts` | the states, including both failure directions |
| `tests/unit/readyz-platform-console-capability.test.ts` | the SEAM — that it reaches the response and never gates |

## Decisions

- **Four states, and the fourth is a false-alarm guard.** `unconfigured` is the
  legitimate self-hosted state. `misconfigured` is a slug naming no live tenant
  — the distinction the gate itself cannot make, since a typo fails identically
  to an absent value. `unknown` is a lookup that could not run, reported rather
  than collapsed into `misconfigured`, because during a database incident every
  probe from six regions would otherwise shout about a configuration fault that
  does not exist while the real signal sat in `checks.database` beside it.
  `a-finding-wants-both-questions`: guard against the false alarm as well as
  the miss.
- **Outside `checks`/`failed`**, like its three siblings. This endpoint is the
  GCP uptime check's target and the alert policy fires on sustained failure from
  more than one region, so a capability that could 503 it would page an operator
  for a typo'd env var. The placement is load-bearing, not stylistic.
- **It checks something the gate does not.** `isPlatformTenant` compares slugs
  and nothing else, so a soft-deleted platform tenant still opens the gate while
  being invisible to every other consumer (#1389 filters `deletedAt: null`
  everywhere else). Reporting `reachable` there would be a stale reassurance, so
  it reports `misconfigured`.
- **Never the slug.** A closed enum, like `basemap`'s branch and `email`'s
  provider. The body is served to an unauthenticated prober from six regions,
  and the operator who needs the value already has the env.
- **Not memoized**, unlike `basemapBranchStatus` — that one scans ~560 chunk
  files once at ~90ms, while this is a single indexed `findUnique` on a `@unique`
  column. More importantly the state can change WITHOUT a restart: deleting the
  platform tenant moves `reachable` → `misconfigured` while the process keeps
  running, and a cached `reachable` would then be the stale reassurance the whole
  report exists to prevent.
- **The env var stays commented and `.optional()`.** It is genuinely not
  prod-required — a self-hosted deployment has no platform tenant — so making it
  required to satisfy `deploy-env-parity` would be forcing a value to fix a
  reporting gap. The probe is the fix; the example file now says so.

## The import that broke 28 tests before any of them ran

The capability first imported `@/lib/prisma`. That module reads `Prisma.dmmf` at
load, and three existing readyz suites mock `@prisma/client` with `PrismaClient`
alone — so `Cannot read properties of undefined (reading 'dmmf')` killed them at
module resolution: **28 failures across 3 suites, with every assertion of mine
still green.**

The same class as #1655's lazy-import fix, reached the same way: a transitive
import widening what a caller's module graph touches, into suites whose doubles
were already incomplete. Here the better fix was not a lazy import but an
injected dependency — `readyz` already constructs a raw `PrismaClient` for its
database check and passes it. That raw client is also the correct one: `slug` and
`deletedAt` are not encrypted columns, so the extended client's per-tenant DEK
resolution would be work this does not need.

Worth noticing as a shape: the first run after wiring showed **two mutations
caught and the control red**. A control that fails is not a weak signal to work
around — it meant the measurement apparatus was broken, and the mutation results
either side of it were not yet trustworthy. Both were re-proved on the final
implementation.

## What this does NOT do

It does not decide whether production should have a platform tenant. That is an
operator question, and #1669 asks it: if yes, create the tenant, set the var and
`deploy/apply.sh`; if no, record the decision so the next reader does not treat
the absence as a bug. A deploy-time gate was not added, on the same
proportionality grounds #781 settled for the basemap.
