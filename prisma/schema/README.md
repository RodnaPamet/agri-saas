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
| `compliance.prisma` | **INHERITED GRC — being torn down.** Practice, Policy, Finding, Framework, Clause and their satellites. Do not add to it |
| `vendor.prisma` | **INHERITED GRC — being torn down.** Empties out entirely in phase 3 |
| `audit.prisma` | `AuditLog` + `OrgAuditLog` are the hash-chained PLATFORM audit trail and STAY. The rest (Audit, AuditPack, AuditorAccount, ReadinessSnapshot …) is inherited GRC being torn down |
| `processes.prisma` | Emptied in teardown phase 1 — its models moved to `automation.prisma`. The file is removed in phase 3 |
| `schema.prisma` | **Transitional**. Holds models not yet relocated to a domain file. Shrinks toward empty as splits land in follow-up PRs. |

## The GRC teardown

This codebase was spun out of the `inflect-compliance` GRC SaaS and carries a
large inherited surface that is being removed in three phases. The authoritative
KILL / KEEP lists live in
`docs/implementation-notes/2026-08-12-grc-teardown-plan.md`.

Phase 1 (done) moved the load-bearing models — the Task family, FileRecord +
Evidence, Asset, and the process maps — OUT of the GRC files and into the
agri-owned files above, so the agri product no longer depends on a
compliance-owned file. It was a pure move: all 278 model/enum blocks compared
identical before and after, so no migration was needed.

**Do not add a new agri model to `compliance.prisma`, `vendor.prisma` or
`audit.prisma`.** Those files are being deleted; only `AuditLog` and
`OrgAuditLog` survive out of the three.

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
  `compliance.prisma` immediately sees the domain boundary.
* Aligns the schema layout with the `src/app-layer/` and
  `src/app/api/` layouts, both of which already split by domain.

## What this PR does

This is the **foundation** PR. It enables the preview feature, sets
up the folder layout, and pre-creates header-commented placeholder
files documenting where models WILL live. It does NOT relocate any
model — every model + enum still lives in `schema.prisma`. The
relocation lands in follow-up PRs, one domain at a time.
