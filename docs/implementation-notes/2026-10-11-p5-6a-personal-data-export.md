# 2026-10-11 — P5.6a: the personal-data export

**Commit:** `<pending>` P5.6a: export my data, from one registry the erasure shares

## Design

```
                      personal-data-registry.ts
                      18 tenantless person columns, each with a Disposition
                               │
              ┌────────────────┴────────────────┐
     EXPORTED_MODELS                      ERASED_MODELS / RETAINED_MODELS
          │                                      │
 GET /api/account/export                   (P5.6b, next)
   └─ getUserCtx(req)            ← refuses API keys, MFA-pending, operator persona
   └─ enforceRateLimit(...)      ← INLINE: the wrapper skips non-mutations
   └─ exportPersonalData(ctx.userId)
        └─ privileged client, 12 bounded reads, each filtered on the person

              personal-data-registry-complete.test.ts
              walks Prisma.dmmf → fails on an unclassified column
```

## Decisions

- **One registry, two consumers.** The export and the erasure must agree, or
  something is exported and never erased, or erased and never shown. Each entry
  carries the disposition both read.

- **Derived-complete, not enumerated.** The guard reads the DMMF, so a new
  tenantless model with a person id fails CI until somebody decides what
  erasure does to it. That decision would otherwise never get made — an
  unclassified column silently survives erasure and nothing notices.

- **Tenantless only.** 49 of 67 person columns sit on tenant-scoped models.
  Those are farm records; the person's name is authorship, and the farm has its
  own retention duty. Stated in the response rather than left implicit.

- **The `where` clause is the control, because the client is privileged.** No
  session context can read across three policy regimes. So every test asserts a
  second person's rows are ABSENT — the assertion a dropped clause fails.

- **Statements of reasons are exported**, reversing P5.1's no-read posture on
  purpose: an export is not a policy arm, and withholding a copy of a letter we
  wrote to someone is indefensible under Art 15. `actionId` is omitted.

- **Credentials and `emailHash` are never exported.** The first is a leak; the
  second is a correlation input rather than information about the person.

## Two things I got wrong, and what they generalise to

- **A rate limit configured on a GET cannot fire.** `resolveRateLimitScope`
  returns `null` outside `MUTATION_METHODS`. I shipped `rateLimit: { config }`
  with a docblock justifying the budget, which was inert. Now `rateLimit: false`
  plus an explicit `enforceRateLimit`. Generalises: a wrapper option is only a
  control where the wrapper runs.

- **`tsc` does not catch a wrong `select` key on the extended Prisma client.**
  Five column names were wrong and typechecked clean, failing at runtime. The
  extension loosens `select` typing, so column names want checking against the
  DMMF rather than against a green typecheck — which is also how the registry
  guard works, and the reason it is worth having.

## Not in here

- **The erasure** (P5.6b): the deletion request, the frozen-but-recoverable
  grace period, the 30-day job, and the chain-verifier test. The freeze calls
  P5.9's platform revocation entry point, already merged.
- **The privacy notice.** #1597's third exit criterion is that it states what
  survives and matches the code. `RETAINED_MODELS` is exported as data for
  exactly that, so the notice can be written against the registry rather than
  against someone's memory — but it belongs with the erasure, since until that
  ships nothing survives an erasure that does not happen.
- **The iOS half**, which lands in the same release as P5.6b per the owner's
  ruling on #1598: Apple rejects a build where deletion exists on the web and
  not in the app, and the recoverable grace period means the app needs a
  recovery screen too.
