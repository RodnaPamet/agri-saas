# Application Layer Architecture Guide

## Folder Responsibilities

```
src/app-layer/
├── types.ts          # RequestContext, PaginatedResult
├── context.ts        # getTenantCtx, getScopeCtx, getLegacyCtx
├── execute.ts        # executeInTenant, executeInScope, executeInLegacy
├── policies/         # Authorization checks (assertCanRead/Write/Admin/Audit)
│   ├── common.ts     # Shared RBAC policies
│   └── risk.policies.ts  # Risk-specific policies
├── repositories/     # DB access (accepts PrismaTx, enforces tenantId filters)
├── usecases/         # Business logic orchestration (policy → repo → events)
└── events/           # Audit/event writers (logEvent, typed domain emitters)
    ├── audit.ts       # Central event writer
    └── risk.events.ts # Risk-specific event emitters
```

### Rules

| Layer | Can import | Cannot import |
|---|---|---|
| **Routes** (`src/app/api/`) | context, execute, usecases, schemas, errors | prisma, repositories, policies, events |
| **Usecases** | policies, repositories, events, db-context | prisma (except allowlisted globals), routes |
| **Policies** | types | prisma, repositories, routes |
| **Repositories** | db-context (PrismaTx) | prisma (except allowlisted globals), routes |
| **Events** | db-context (PrismaTx), types | prisma, routes |

---

## How to Add a New Endpoint

### 1. Define the Zod Schema

```typescript
// src/lib/schemas/index.ts
export const CreateWidgetSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
}).strip();
```

### 2. Create the Repository

```typescript
// src/app-layer/repositories/WidgetRepository.ts
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export const WidgetRepository = {
    list: (db: PrismaTx, ctx: RequestContext) =>
        db.widget.findMany({
            where: { tenantId: ctx.tenantId },  // Index usage
            orderBy: { createdAt: 'desc' },
        }),

    create: (db: PrismaTx, ctx: RequestContext, data: { name: string; description?: string }) =>
        db.widget.create({
            data: { ...data, tenantId: ctx.tenantId },
        }),
};
```

> **Why `where: { tenantId }`?** RLS enforces isolation, but explicit filters use the `tenantId` index for performance. RLS = seatbelt, `WHERE` = steering wheel.

### 3. Create the Usecase

```typescript
// src/app-layer/usecases/widget.ts
import { RequestContext } from '../types';
import { WidgetRepository } from '../repositories/WidgetRepository';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';

export async function listWidgets(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        WidgetRepository.list(db, ctx)
    );
}

export async function createWidget(ctx: RequestContext, data: { name: string }) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const widget = await WidgetRepository.create(db, ctx, data);
        await logEvent(db, ctx, {
            action: 'WIDGET_CREATED',
            entityType: 'Widget',
            entityId: widget.id,
            details: `Created widget: ${widget.name}`,
        });
        return widget;
    });
}
```

### 4. Create the Route Handler

```typescript
// src/app/api/t/[tenantSlug]/widgets/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listWidgets, createWidget } from '@/app-layer/usecases/widget';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateWidgetSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';

export const GET = withApiErrorHandling(async (req: NextRequest, { params }) => {
    const ctx = await getTenantCtx(params, req);
    return NextResponse.json(await listWidgets(ctx));
});

export const POST = withApiErrorHandling(
    withValidatedBody(CreateWidgetSchema, async (req, { params }, body) => {
        const ctx = await getTenantCtx(params, req);
        return NextResponse.json(await createWidget(ctx, body), { status: 201 });
    })
);
```

---

## How to Add a Policy

```typescript
// src/app-layer/policies/common.ts (or a domain-specific file)
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

export function assertIsOwnerOrAdmin(ctx: RequestContext, ownerId: string) {
    if (ctx.userId !== ownerId && !ctx.permissions.canAdmin) {
        throw forbidden('Only the owner or an admin can perform this action.');
    }
}
```

Policies:
- Accept `RequestContext` (and optional entity data)
- Throw typed errors (`forbidden()`, `unauthorized()`)
- Are called by usecases, never by routes

---

## Tenant Isolation (RLS)

See [docs/rls.md](./rls.md) for full details.

**Key points:**
- Every tenant-scoped table has `ROW LEVEL SECURITY` enabled + forced
- RLS policies check `current_setting('app.tenant_id')` against row `tenantId`
- Usecases call `runInTenantContext(ctx, (db) => ...)` which sets the session variable
- Repositories use `db: PrismaTx` (the scoped transaction), never global `prisma`

---

## CI Guardrails

The CI guard (`tests/unit/no-direct-prisma.test.ts`) scans all source files and **fails if**:

| Check | Scans | Violations |
|---|---|---|
| `prisma.*` in routes | All 60+ routes | logAudit, requireRole imports |
| `logAudit(` in routes | All business routes | Must be in events |
| `requireRole(` in routes | All business routes | Must be in policies |
| `prisma` import in repos | All repos except allowlist | Must use `PrismaTx` |
| `prisma` import in usecases | All usecases except allowlist | Must use `runInTenantContext` |
| `withTenantDb(` in usecases | All usecases | Must use `runInTenantContext` |

Auth routes (`auth/[...nextauth]`, `auth/route.ts`, `auth/me/route.ts`, `auth/logout/route.ts`) are explicitly allowlisted.

---

## Event Writing

All audit events go through `logEvent(db, ctx, payload)`:

```typescript
await logEvent(db, ctx, {
    action: 'WIDGET_CREATED',
    entityType: 'Widget',
    entityId: widget.id,
    details: `Created widget: ${widget.name}`,
    detailsJson: {
        category: 'entity_lifecycle',
        entityName: 'Widget',
        operation: 'created',
        after: { name: widget.name },
        summary: `Created widget ${widget.name}`,
    },
});
```

`detailsJson` is not optional in practice — `tests/guards/audit-structured-events.test.ts`
fails any `logEvent` call site under `src/app-layer/usecases` without one. `details`
is the human string; `detailsJson` is the machine-readable payload and the only
part `streamAuditEvent` ships to a tenant's SIEM.

The event writer automatically attaches:
- `requestId` (from `ctx.requestId`)
- `tenantId` (from `ctx.tenantId`)
- `userId` (from `ctx.userId`)

### Choosing the `action` verb

The example above says `WIDGET_CREATED`, not `CREATE`, and that is deliberate.
`action` is a free-form `string` with no enum, no registry and no guard, so the
convention is the only thing holding it — and the tree reflects a **split, not
drift**. Measured over every `logEvent` call site in `src/app-layer` carrying a
literal action: **193 sites — 65 canonical (34%) and 128 bespoke (66%) across
106 distinct domain verbs.**

- **CRUD verb** (`CREATE` / `UPDATE` / `SOFT_DELETE` / `DELETE`) when the
  operation genuinely is a create, field edit or delete of the row, and
  `changedFields` already says what moved. A lot move is an `UPDATE` of
  `locationId`, not a `LOT_MOVED` event (#391).
- **Domain verb** (`<DOMAIN>_<PAST_TENSE>`: `LOTS_BLENDED`, `STOCK_RECEIVED`,
  `HARVEST_LOT_CREATED`, …) when the operation has its own business meaning
  that the row-level shape understates. Keep `detailsJson.operation` for the
  CRUD shape underneath.

Decide per **model family**, not per PR — all six `InventoryLot` writes are
visible in one grep and five of them are domain verbs, so canonicalising the
sixth would make it the odd one out. And note that **a verb is a permanent,
streamed contract**: `streamAuditEvent` ships it verbatim to a tenant's SIEM,
so renaming one later breaks their filters.

For domain-specific events, create typed emitter wrappers (see
`events/onboarding.events.ts`).
