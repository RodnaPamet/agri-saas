# P6.1 — FarmBrand, PersonProfile, PublicFarmProfile

Tables only. The phase rule is that tables ship one release before the code
that writes them, so the field allowlist and the projection writer are a
separate PR. Nothing in `src/` reads or writes these three yet.

Issue: #1810. Phase: #1197.

## The handle is a separate public identifier

Owner ruling, 2026-10-14. `/f/[handle]` uses its own namespace rather than the
tenant slug, so a shared link or printed QR survives a slug rename and the
internal routing key in `/t/[tenantSlug]/…` stays private.

**The handle lives on `FarmBrand`, not on the projection.** If it lived only on
`PublicFarmProfile`, unpublishing would free it — and P6.7 prints handles onto
A6 paper and into QR codes, so a freed handle makes printed material resolve to
a different farm later. Holding it on the owner's row reserves it for as long as
the farm exists. That answers "can a handle be reused?" with **no**, by
construction.

Availability is observable through the unique index: a taken handle fails with
23505 regardless of RLS. That is how every username system behaves and is
intended here — the constraint answers "reserved" and says nothing about
`published`.

## Three models, three different RLS answers

| model | bucket | policies |
|---|---|---|
| `FarmBrand` | `TENANT_SCOPED_MODELS` (automatic, via `tenantId`) | `tenant_isolation`, `tenant_isolation_insert`, `superuser_bypass`, FORCE RLS |
| `PersonProfile` | `NO_RLS_NOT_APP_USER_MODELS` | none |
| `PublicFarmProfile` | `GLOBAL_BY_DESIGN_MODELS` | none, and FORCE RLS deliberately off |

Verified against the live test database after migrating:

```
FarmBrand          rls=true  force=true   → superuser_bypass, tenant_isolation, tenant_isolation_insert
PersonProfile      rls=false force=false  → (none)
PublicFarmProfile  rls=false force=false  → (none)
```

### Why `PersonProfile` has no policy

I first wrote a user-scoped fail-closed policy on the `app.user_id` axis,
citing P1.4's "defence in depth ahead of the code". **That was the wrong
precedent.** P1.4 narrowed tables that already had an over-permissive policy —
`UserSession`'s unconditional null-tenant arm let any session read every
null-tenant row — so there was a live over-permission to close.

`PersonProfile` has no policy and no reader of any kind. That is the `User` /
`Tenant` / `FeatureFlag` situation, and `NO_RLS_NOT_APP_USER_MODELS` is where
those 16 models sit with exactly this reason. The policy belongs to the first PR
that routes a person-scoped read through `app_user` — P6.6's editor or P6.9's
iOS profile view — which is also the only PR that can write an integration test
with real negative controls for it.

### Why `PublicFarmProfile` has no policy, and no `FORCE`

Cross-tenant readability **is** the product, the same argument `ExchangeListing`
carries. Two things make that safe and neither is discipline:

1. **No PII columns exist.** `egn`, `eik`, `address`, `municipality` and
   `settlement` are on `FarmProfile` and have no counterpart here, so a
   projection writer cannot leak them by forgetting an allowlist entry — there
   is nowhere for the value to land. P6.10's "0 hits" hardening test is
   structurally satisfied for anything read from this table.
2. **Writes never come from a tenant session**, so there is no write surface for
   RLS to constrain.

`FORCE ROW LEVEL SECURITY` is off for a specific reason: with no policy, forcing
it makes the table unreadable under `app_user`, which reads as isolation but
would be an outage of the public page.

## Two corrections the work produced

**The phase's call form is wrong.** It writes
`runWithoutRls('public-projection-read')`. The real signature is
`runWithoutRls({ reason }, cb)`, and `'public-projection-read'` did not exist —
it is added here to **both** `RlsBypassReason` and `REASON_REGISTRY`, because
`REASON_REGISTRY` is a `Record<RlsBypassReason, true>` and the file records what
happened last time someone added one and not the other: `tsc` passed, and only
the unmocked suites caught it.

**The projection must not carry `tenantId`.** I first gave it one so the writer
could find its row. The rls-coverage ratchet refused, and was right twice:
`TENANT_SCOPED_MODELS` is DMMF-derived from the *presence* of a `tenantId`, so
the column put the model in the tenant-scoped set **and** in the global bucket —
classified twice, with no policies. It is also wrong on product grounds, since a
public read model carrying the internal tenant id publishes that identifier to
anyone who reads the row. `FarmBrand.projectedHandle` replaces it: the writer
finds rows by `handle` and knows which stale row to remove after a rename.

## What the integration test proves, and what it cannot

`tests/integration/p6-1-farm-brand-rls.test.ts`, run with
`INTEGRATION_REQUIRE_DB=1` so a skipped run is red rather than silently green.

- an outsider reads zero rows, **and** the owner reads its own — so the zero is
  isolation rather than a fixture that never landed;
- `app_user` cannot create a brand attributed to another farm (42501), paired
  with a positive control that it **can** create its own. That pairing is not
  optional: `farm-identity-claim-unique.test.ts` measured that with both
  tenant policies dropped, its refusal case still passed, because the only
  surviving policy was `superuser_bypass` and every access was denied. A
  refusal is not evidence of a correct refusal;
- the handle namespace is global — tenant B cannot take a handle tenant A holds
  and cannot see, because a unique index operates below RLS.

Two defects in my own first version, both caught by running it:

- a shared tenant pair made the suite order-dependent, because
  `FarmBrand.tenantId` is `@unique`: the first seed consumed that tenant's one
  brand and the positive control failed for a fixture reason;
- the handle-namespace case asserted `/Unique constraint|23505/`, which matches
  a `FarmBrand_tenantId_key` violation just as well as a
  `FarmBrand_handle_key` one — so it passed while proving nothing about the
  namespace it names. Both cases now assert the **constraint name**, and each
  arranges its fixture so the other constraint cannot fire.

The tenant rows are deliberately not cleaned up: the audit log is immutable by
trigger and `AuditLog_tenantId_fkey` is `ON DELETE RESTRICT`, so any suite that
writes through `withTenantDb` cannot delete its own tenants. Ids are per-run
UUID fragments.

## Rollback

`migration.down.sql` drops the three tables. Destructive, and safe only while
nothing writes them — true for exactly one release. After the writer ships,
rolling back costs every published profile.
