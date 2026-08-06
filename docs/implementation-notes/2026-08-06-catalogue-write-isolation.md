# 2026-08-06 — Global catalogue writes are platform work, not tenant work

**Commit:** `fix(security): stop tenant-scoped routes writing the global framework catalogue`

Two critical cross-tenant write paths into `Framework` / `FrameworkRequirement`.
Both reachable from an ordinary farm's session, both silent.

## Design

### The architecture is right; the gates were not

`Framework` and `FrameworkRequirement` carry no `tenantId`, and that is
correct — a shared catalogue of standards with a per-tenant link table
(`ControlRequirementLink`) is the right shape for something every farm is
audited against. Duplicating GlobalG.A.P. per tenant would be worse in every
way.

But a table with no tenancy has no tenancy to constrain a write. The only thing
between "one farm edits a standard" and "every farm's coverage changes" is the
gate on the usecase — and both gates resolved from **Role**, which every farm's
OWNER already holds.

### Flag 1 — the requirement wipe

`upsertRequirements` gated on `assertCanInstallFrameworkPack`: OWNER or ADMIN
of *any* tenant. With `deprecateMissing: true` it then ran

```ts
frameworkRequirement.updateMany({
    where: { frameworkId: fw.id, code: { notIn: codes }, deprecatedAt: null },
    data:  { deprecatedAt: new Date() },
})
```

over the whole global `frameworkId`. Deprecated requirements are excluded by
`coverage.ts` and by `soa.ts`, so a single call from one farm silently zeroed
**every other farm's** coverage, readiness and Statement of Applicability.

There was no `logEvent` anywhere in `fixtures.ts`. The most destructive
operation in the catalogue left no trace of who ran it or what it removed. The
route arm had neither `requirePermission` nor `assertModuleEnabled`.

### Flag 2 — tenant-authored global schemes

`createScheme` gated on per-tenant `assertCanAdmin` and then wrote
`prisma.framework.create` into the global table, which `listSchemes` reads with
no tenant filter. One farm's scheme — its name, description and every
requirement title — appeared on every other farm's `/schemes` page, and the
globally-unique `key` was burned platform-wide. There is no delete path:
`framework.delete` / `deleteScheme` / `deleteFramework` all return zero hits.

### The fork: (a), platform-only authoring

Farms **adopt** standards; they do not author them. GlobalG.A.P. is not
something a farm defines, and a farmer being asked for a URL-safe key slug and
per-requirement codes is being handed a standards-body workflow.

Option (b) — genuinely tenant-owned custom schemes — needs a `tenantId` on
`Framework` (or a separate `TenantScheme` model), a per-tenant key namespace,
and a delete path. That is a real feature, and nothing in the product asks for
it today.

So authoring survives, behind the platform gate. The catalogue still has to
come from somewhere, and a platform-side authoring path is how a new standard
gets added without a deploy.

### The gate

`assertPlatformSupport` already existed for exactly this problem — it gates the
global promotions and companies catalogues. `assertCanWriteCatalogue` in
`framework.policies.ts` is a named wrapper so the two catalogue call sites read
as what they are, and so the guard has one symbol to look for.

Three properties worth stating, because each was chosen:

- **It 404s, not 403s.** A 403 confirms the surface exists. From an unrelated
  farm's perspective the catalogue console genuinely does not exist.
- **It fails closed.** With `PLATFORM_TENANT_SLUG` unset, `isPlatformTenant` is
  false for *every* tenant, so a misconfiguration loses the feature rather than
  opening it to everyone.
- **It does not drop the role check.** `assertPlatformSupport` calls
  `assertCanAdmin` itself, so a READER inside the platform tenant still cannot
  write. The slug check replaces the role check's *scope*, not the role check.

The gate runs **before** the catalogue read, deliberately: a denial that still
tells the caller whether a framework key exists is an enumeration oracle over
the catalogue.

### Permission registration

`route-permissions.ts` had **zero** rules for `frameworks` or `schemes`, so a
denial on either emitted no `AUTHZ_DENIED` row and neither root was visible to
the Epic C.1 coverage guardrail. That is how a tenant-scoped route able to
deprecate every requirement of a standard went unnoticed.

Both are now registered with `methods: ['POST','PUT','PATCH','DELETE']` — reads
stay open, because browsing a standard's control points is not privileged and
gating it would hide the catalogue from the readers it exists for. The
permission is the **audited role floor, not the isolation control**; the slug
check is the control. Both are load-bearing and the rule notes say so.

Adding the roots to `PRIVILEGED_ROOTS` pulled five more routes into scope:

| route | resolution |
|---|---|
| `frameworks/[key]/reorder` POST | gated — writes a per-tenant sortOrder overlay |
| `schemes/[key]/pack` POST | gated (`audits.manage`) — mints an audit pack |
| `frameworks` GET | excluded — read-only catalogue list |
| `frameworks/[key]/tree` GET | excluded — read-only requirement tree |
| `schemes/[key]/applicability.csv` GET | excluded — exports the caller's OWN tenant data |

### The UI has to agree with the gate

`page.tsx` passed `canAdmin` straight through to the "+ Scheme" button. Left
alone, every farm's owner would keep seeing a form whose submit now 404s. The
prop is now `canAuthorScheme = canAdmin && isPlatformTenant(slug)` — a UI that
offers an action the API refuses is its own defect.

## Files

| File | Role |
|---|---|
| `src/app-layer/policies/framework.policies.ts` | `assertCanWriteCatalogue` — the named platform gate |
| `src/app-layer/usecases/framework/fixtures.ts` | `upsertRequirements` gated + audited (there was no audit at all) |
| `src/app-layer/usecases/certification-scheme.ts` | `createScheme` gated |
| `src/app/api/…/frameworks/[frameworkKey]/route.ts` | POST wrapped in `requirePermission` |
| `src/app/api/…/frameworks/[frameworkKey]/reorder/route.ts` | POST wrapped |
| `src/app/api/…/schemes/route.ts` | POST wrapped + platform-gated |
| `src/app/api/…/schemes/[schemeKey]/pack/route.ts` | POST wrapped |
| `src/lib/security/route-permissions.ts` | `frameworks` + `schemes` registered |
| `tests/guardrails/api-permission-coverage.test.ts` | both roots privileged; three reads excluded with reasons |
| `src/app/t/…/schemes/{page,SchemesClient}.tsx` | authoring affordance follows the gate |

## Decisions

- **Keep the global catalogue global.** The bug is the write path, not the
  schema. Adding `tenantId` to `Framework` would fix cross-tenant writes by
  giving up the shared catalogue, which is the part that is right.
- **Reuse `assertPlatformSupport` rather than `PLATFORM_ADMIN_API_KEY`.** The
  API key has no user behind it, so its audit rows cannot answer "who
  deprecated these requirements". The platform-tenant gate runs through normal
  sessions and RBAC, so `AuditLog` gets a real `tenantId` *and* a real
  `userId`.
- **Register the permission even though it is not the control.** It resolves
  from Role, so it grants nothing the slug check doesn't already allow. What it
  buys is an audited `AUTHZ_DENIED` row on denial and membership of the Epic
  C.1 guardrail — the two things whose absence let this sit unnoticed.
- **Gate before the read.** Costs nothing; closes an enumeration oracle.
- **Widen the guard's population to `prisma/`.** The first draft walked only
  `src/app-layer/usecases`, so the ingestion pipeline — a genuine catalogue
  writer — was invisible to it. Widening immediately surfaced two more writers
  (`prisma/seed-catalog.ts`, `prisma/seed.ts`) that the narrow version would
  never have asked about. All three are exempt with written reasons: they run
  outside any request, with no `RequestContext` to gate on, reachable only by
  someone who already holds database credentials.
