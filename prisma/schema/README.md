# Prisma multi-file schema (GAP-09)

The schema lives in this directory, not in a single `prisma/schema.prisma`.
Prisma reads every `.prisma` file in this folder and concatenates them
into one logical model graph at generate / migrate time.

This requires the `prismaSchemaFolder` preview feature, which is
enabled in `base.prisma`. The feature is GA in Prisma 6.0+; on our
current Prisma 5.22.0 it is opt-in.

## Layout

| File | What lives here |
|---|---|
| `base.prisma` | `generator client` + `datasource db` (the only ones — Prisma rejects duplicates across the folder) |
| `enums.prisma` | All shared enum declarations |
| `auth.prisma` | Tenant, Organization, User, Account, Session, UserSession, TenantMembership, OrgMembership, TenantCustomRole, TenantInviteToken, TenantSecuritySettings, SsoConnection, ScimToken |
| `work.prisma` | Task, TaskKeySequence, TaskLink, TaskComment, TaskWatcher — **the farm task system**. A `FARM_TASK` / `FIELD_OPERATION` row IS a farm task; `farm-task.ts` is a thin orchestration over this module |
| `files.prisma` | FileRecord (backs the БАБХ ДНЕВНИК register), Evidence (the `/evidence` "Docs" surface), EvidenceReview |
| `assets.prisma` | Asset (the machine register — `Equipment` was merged into it), AssetMaintenance, AssetKeySequence |
| `automation.prisma` | AutomationRule/Execution/Event, IntegrationConnection/Credential, SyncMapping, Webhook, Notification, **and the process-map models** (ProcessMap/Node/Edge — the rule builder's storage) |
| `audit.prisma` | `AuditLog` + `OrgAuditLog` — the hash-chained PLATFORM audit trail. Nothing else |
| `agriculture.prisma`, `agro.prisma`, `ai.prisma`, `exchange.prisma`, `grain.prisma`, `insurance.prisma`, `inventory.prisma`, `journal.prisma`, `knowledge.prisma`, `market.prisma`, `planning.prisma`, `promotions.prisma` | One file per agri domain |
| `schema.prisma` | **Transitional**. Empty today; a staging location for a model that does not yet have a domain. |

## The GRC teardown

This codebase was spun out of the `inflect-compliance` GRC SaaS and carried a
large inherited surface, removed across three phases. The KILL / KEEP lists
live in `docs/implementation-notes/2026-08-12-grc-teardown-plan.md`; the
schema drop is written up in
`docs/implementation-notes/2026-08-15-grc-teardown-phase3.md`.

Phase 1 moved the load-bearing models — the Task family, FileRecord +
Evidence, Asset, and the process maps — OUT of the GRC files and into the
agri-owned files above. It was a pure move: all 278 model/enum blocks compared
identical before and after, so no migration was needed. Phase 2 deleted the
GRC application code. Phase 3 deleted `compliance.prisma`, `vendor.prisma` and
`processes.prisma` outright, trimmed `audit.prisma` to the two platform
audit-log models, and dropped 47 tables + 44 enums from the database.

**Those files are gone — do not recreate them.** A new model goes in the
matching agri domain file above.

## Conventions

### One owner per declaration

A model or enum lives in exactly one file. Cross-domain references
(`tenant Tenant @relation(...)`) are declared on the OWNING side —
i.e. the model's own domain file. The reverse-relation field on the
referenced model is declared in the referenced model's home file.

### Generator and datasource

Exactly one generator and one datasource block, both in `base.prisma`.
Prisma rejects duplicates across the folder, so adding a new domain
file MUST NOT redeclare these.

### Enum policy

All shared enums live in `enums.prisma`, even when only one domain
references them today. Reasons:

* Enums tend to grow new consumers across domains over time
  (e.g. `Severity` started on `Risk`, now used by `Finding`, `Issue`,
  and several Task variants).
* A single home avoids accidental duplicate declarations during
  refactors.
* Schema diffs for enum changes are localised to one file.

### Migration discipline

The split is **purely organisational** — no field, relation, index,
default, or `@@map` should change as part of moving a model between
files. Each file-relocation PR must include a clean
`prisma migrate diff` that reports zero drift between the resulting
schema and the prior committed state.

The CI guardrail in `tests/guardrails/...prisma...` enforces this.

## Running Prisma

The standard commands are unchanged — Prisma auto-detects the folder
when `prismaSchemaFolder` is enabled in the generator block:

```
npx prisma generate         # codegen for @prisma/client
npx prisma migrate dev      # local migration
npx prisma migrate deploy   # production / CI migration
npx prisma format           # format every .prisma file in the folder
```

Tooling that explicitly passed `--schema=./prisma/schema.prisma` has
been updated to point at the folder (`./prisma/schema`) — see
`scripts/entrypoint.sh`.

## Why split

The monolithic schema reached ~2,900 lines and 96 models. Splitting
by domain:

* Localises change diffs (a vendor-only change touches one file, not
  the same monolith every other PR also touches).
* Reduces merge-conflict surface — adjacent unrelated changes across
  domains stop conflicting on the same file.
* Makes ownership readable at a glance — a contributor opening
  its domain file immediately sees the boundary.
* Aligns the schema layout with the `src/app-layer/` and
  `src/app/api/` layouts, both of which already split by domain.

## What this PR does

This is the **foundation** PR. It enables the preview feature, sets
up the folder layout, and pre-creates header-commented placeholder
files documenting where models WILL live. It does NOT relocate any
model — every model + enum still lives in `schema.prisma`. The
relocation lands in follow-up PRs, one domain at a time.
