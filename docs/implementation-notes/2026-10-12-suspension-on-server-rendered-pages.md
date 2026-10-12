# 2026-10-12 — no page reached the suspension check

**Issue:** #1657 (part of #1600)

## Design

P5.9 put `isAccountSuspended` in `getSessionOrThrow`; #1652 routed nine API
routes through it. **No page was covered**, and the reason is one line of a
signature:

```ts
export async function getTenantServerContext(params: {
    tenantSlug: string;
    userId: string;          // <- handed in, never resolved
}): Promise<TenantServerContext>
```

That function is the gate every server-rendered tenant page passes through. It
takes the id, so `getSessionOrThrow` is not on the path and neither is the
check. **A parameter is not a question**: a helper handed an id cannot ask
whether that id is allowed to be here.

The Edge cannot cover it either, for P5.9's own reason — middleware runs on the
Edge and this deployment has neither Prisma nor Redis there.

`redirectIfSuspended` now runs inside `getTenantServerContext`, plus at the two
person-scoped entry points that read data directly (`/tenants`,
`account/layout`), and a suspended account lands on `/suspended`.

## What was exposed

| how data arrived | files | what a suspended person saw |
|---|---|---|
| direct Prisma in the server component | `tenants/page.tsx`, `t/{slug}/(app)/admin/billing`, `.../admin/rbac`, `t/{slug}/(app)/layout` | **the real data, rendered** |
| via a usecase | the invite previews, `t/{slug}/layout` | the usecase's data |
| shell only, client fetches after | the remaining 12 | the chrome, then API refusals |

`admin/billing` is the sharpest: a suspended account rendered the farm's billing
state server-side.

## A redirect, not a 404 — and the catch that nearly decided otherwise

Owner ruling: a suspended person is told so. The alternative was the tenant
layout's existing `notFound()`, which would say the farm does not exist —
unactionable, and indistinguishable from a typo.

**`redirect()` works by throwing**, with a `digest` of `NEXT_REDIRECT;…`. And
the tenant layout was:

```ts
try { serverCtx = await getTenantServerContext({…}); }
catch { notFound(); }
```

So a redirect raised inside would have been swallowed and turned into a 404 —
exactly the answer the ruling rejected, arriving by accident. That catch now
re-throws control flow via `isNextControlFlow`, which matches on `digest`
because that is the only stable surface; `sentry.ts` already filters
`NEXT_REDIRECT` the same way, so the convention was established rather than
invented.

This is a latent bug independent of suspension: any `catch` around something
that may redirect converts it.

## Files

| file | role |
|---|---|
| `src/lib/auth/suspension-page.ts` | NEW — `redirectIfSuspended`, `isNextControlFlow`, `SUSPENDED_PATH` |
| `src/lib/server/tenant-context.server.ts` | the check, before the membership lookup |
| `src/app/t/[tenantSlug]/layout.tsx` | the catch re-throws control flow |
| `src/app/suspended/page.tsx` | NEW — the destination |
| `src/app/{tenants/page,account/layout}.tsx` | the two person-scoped entry points |
| `messages/{en,bg}.json` | `suspended.*`, 4 keys each |
| `tests/guards/server-pages-check-suspension.test.ts` | NEW — the count, governed |
| `tests/unit/suspension-on-server-rendered-pages.test.ts` | NEW |

## Decisions

- **The check goes BEFORE `resolveTenantContext`, and the order is the answer
  rather than an optimisation.** That resolver throws for a non-member and the
  layout turns the throw into `notFound()` — so checking afterwards would answer
  "no such farm" to a suspended member, which is the 404 the ruling rejected.
  Mutation-proved: moving it after fails exactly that assertion.

- **The guard verifies the INDIRECT hop, because the first version did not.**
  It counts `getTenantServerContext(` as coverage — a file calling a resolver
  that calls the check. Deleting the check from the resolver left every tenant
  page "covered" and the guard green. Measured as a surviving mutation, then
  closed by asserting the resolver's own source. The lesson is that a guard
  about a choke point has to grade the choke point, not the call to it.

- **And its ordering assertion was inert for one iteration.** It compared
  `indexOf('redirectIfSuspended')` with `indexOf('resolveTenantContext(')` —
  both names appear in the IMPORT block, so it was comparing line 17 with line
  16 and passed whatever the body did. Anchored on the call spellings now, with
  an existence check on both anchors so `-1 < n` cannot pass by matching
  nothing.

- **`/suspended` is NOT gated on being suspended**, and it is the one allowlist
  entry whose reason is mechanical rather than editorial: gating it would
  redirect it to itself. Anyone may open it, so its reachability does not depend
  on the condition it describes.

- **Ten allowlist entries, each justified by what the page RENDERS.** The root
  layout reads a user id only to namespace the SWR cache bucket; `/dashboard` is
  a router; `/start`, `/no-tenant` and `/accept-terms` render no farm or person
  data and the writes they lead to are refused by the API; the two invite
  previews proceed under #1652's ruling; `/org/{slug}` has no suspension story
  yet and is listed so the decision is visible. "It is only a layout" is
  explicitly not a reason — `account/layout.tsx` is a layout and it is gated.

- **The page names no reason and offers no appeal.** Why an account was
  suspended is delivered as an Art 17 statement of reasons to the person's own
  inbox; repeating a summary here would be a second, un-versioned channel for
  the same obligation. And there is no appeal surface, so a button would do
  nothing on the one page somebody reads when they have just lost access.

- **Exposure was nil.** Production holds three tenants of the owner's own test
  data and no suspended accounts, so nothing live was ever rendered to a
  suspended person. That is why this is a correctness fix rather than an
  incident.
