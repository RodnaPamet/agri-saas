/**
 * Epic 49 — `getComplianceCalendarEvents` usecase.
 *
 * Single aggregation that fans out across the date-bearing entities and
 * normalises every result into the unified `CalendarEvent` shape:
 *
 *   - Evidence       (nextReviewDate, expiredAt)
 *   - Policy         (nextReviewAt)
 *   - Vendor         (nextReviewAt, contractRenewalAt)
 *   - VendorDocument (validTo)
 *   - AuditCycle     (periodStartAt → periodEndAt — the only duration source today)
 *   - Control        (nextDueAt)
 *   - ControlTestPlan(nextDueAt)
 *   - Task           (dueAt — FARM_TASK rows split into their own category)
 *   - Risk           (nextReviewAt, targetDate)
 *   - Finding        (dueDate)
 *   - ParcelLease    (startDate → endDate — duration)
 *   - Contract       (deliveryStart → deliveryEnd — duration)
 *   - Planting       (sowDate → harvestEndDate — duration)
 *   - AgroSignal     (signalDate)
 *   - NewsDerivedEvent (eventDate — AI-proposed, APPROVED rows only)
 *
 * Tenant isolation: every Prisma query starts with `tenantId: ctx.tenantId`
 * (AgroSignal has no `deletedAt` column — see its loader for why).
 *
 * Range bounding: the schema guarantees `from <= to <= from + 2y`. Inside
 * the usecase we issue parallel point queries with date predicates so the
 * DB can use the per-entity indexes on the date columns + `(tenantId, …)`.
 *
 * Status mapping: each source maps its lifecycle status into one of
 * `scheduled | due_soon | overdue | done | unknown`. The map is local
 * to the source (one place to look when a new entity is added).
 *
 * Resilience: the fan-out is `Promise.allSettled`, not `Promise.all` — a
 * NEW source is a NEW way for the whole calendar to go blank if a query
 * throws (a bad index, an RLS edge case, a null the mapper doesn't
 * expect). A rejected source is logged and the survivors still render;
 * see `logRejectedSources` below.
 *
 * Truncation: every loader requests one row past its `perSourceLimit`
 * (the same +1 trick `getUpcomingDeadlineCount` uses for the badge) and
 * now carries an `orderBy`, so a capped source drops its LATEST rows in
 * a stable, deterministic order rather than an arbitrary DB-order slice.
 * `CalendarResponse.truncated` is true when any source hit its cap.
 *
 * Transaction budget: all 17 loaders run on ONE `runInTenantContext`
 * interactive transaction (one PgBouncer connection, held for the whole
 * fan-out) with a raised `timeout`/`maxWait` — see `CALENDAR_TX_TIMEOUT_MS`
 * below for why that beat splitting the fan-out into per-source
 * transactions.
 */

import { runInTenantContext } from '@/lib/db-context';
import type { AgriEventCategory } from '@/app-layer/schemas/agri-event.schemas';
import type { NewsDerivedEventKind } from '@/app-layer/schemas/news-derived-event.schemas';
import type { PrismaTx } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import type { WorkItemStatus, AgroSignalKind } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import type { RequestContext } from '../types';
import {
    type CalendarEvent,
    type CalendarEventCategory,
    type CalendarEventStatus,
    type CalendarEventType,
    type CalendarResponse,
    CALENDAR_EVENT_CATEGORIES,
    CALENDAR_EVENT_STATUSES,
} from '../schemas/calendar.schemas';

// ─── Public entry point ──────────────────────────────────────────────

export interface GetCalendarEventsInput {
    from: Date;
    to: Date;
    /** Optional filter — when set, only these types are returned. */
    types?: ReadonlyArray<CalendarEventType>;
    /** Optional filter — when set, only these categories are returned. */
    categories?: ReadonlyArray<CalendarEventCategory>;
    /** Override "now" for tests. Default: new Date(). */
    now?: Date;
    /**
     * Per-source result cap. Default: 500. Stops a runaway entity (one
     * tenant with 50k overdue tasks) from overwhelming the response.
     */
    perSourceLimit?: number;
}

/** One source loader's normalised output. */
interface SourceResult {
    events: CalendarEvent[];
    /** True when the loader's query hit `perSourceLimit` and had to cap. */
    truncated: boolean;
}

/**
 * 1:1, in order, with the `Promise.allSettled` array in
 * `getComplianceCalendarEvents`. Used only to name a rejected source in
 * the log line below — keep it in sync when a source is added/removed.
 */
const CALENDAR_SOURCE_NAMES = [
    'evidence',
    'policy',
    'vendor',
    'vendorDocument',
    'auditCycle',
    'control',
    'testPlan',
    'task',
    'risk',
    'finding',
    'treatmentMilestone',
    'treatmentPlan',
    'parcelLease',
    'contract',
    'planting',
    'agroSignal',
    'agriEvent',
    'newsDerivedEvent',
] as const;

/**
 * Interactive-transaction budget for the calendar fan-out.
 *
 * `runInTenantContext` opens ONE Prisma interactive transaction — one
 * PgBouncer (transaction-mode) connection held for the transaction's
 * full duration. Prisma's default `timeout`/`maxWait` (5s / 2s) was
 * sized for a handful of loaders; the fan-out grew from 12 to 17 in the
 * agriculture-sources PR and now sits at 18 with the AI news-derived
 * source. The per-query cost is what the indexes added in the
 * calendar-agri-source-date-indexes migration fix — each loader is a
 * bounded, index-backed point/range read — but the DEFAULT ceiling is
 * still shared across all 18 sequential statements on that one
 * connection (SET LOCAL ROLE + SET LOCAL app.tenant_id/app.request_id +
 * 18 queries), so a slow one (cold cache, a large tenant, a brief lock
 * wait) has no headroom before Prisma kills the whole transaction and
 * blanks the calendar for every source, not just the slow one.
 *
 * We raise the ceiling rather than splitting the fan-out into 18
 * separate `runInTenantContext` transactions: that would trade one
 * held connection for up to 18 concurrent ones per calendar page load,
 * which is worse for a shared PgBouncer pool under real traffic than
 * one connection held a few seconds longer, and it would also lose the
 * single consistent read snapshot the sources currently share. Values
 * mirror the precedent in `audit-readiness/packs.ts` and
 * `framework/install.ts` (60s/10s) scaled down for a read-only fan-out
 * instead of a multi-step write.
 */
const CALENDAR_TX_TIMEOUT_MS = 15_000;
const CALENDAR_TX_MAX_WAIT_MS = 10_000;

export async function getComplianceCalendarEvents(
    ctx: RequestContext,
    input: GetCalendarEventsInput,
): Promise<CalendarResponse> {
    assertCanRead(ctx);

    const now = input.now ?? new Date();
    const limit = input.perSourceLimit ?? 500;
    const range = { from: input.from, to: input.to };

    // Fan-out to every source in parallel inside one tenant-bound
    // transaction. `runInTenantContext` binds the per-tx `app_user`
    // role + sets `app.tenant_id` so every read goes through the
    // RLS policies — that's belt-and-braces with the explicit
    // `tenantId: ctx.tenantId` filter inside each loader.
    //
    // `Promise.allSettled`, NOT `Promise.all`: with 18 sources fanning
    // out, one throwing loader must not blank the other 17. A rejected
    // source is logged and dropped; the rest still render.
    //
    // Timeout raised, transaction NOT split — see
    // `CALENDAR_TX_TIMEOUT_MS` above for why.
    const settled = await runInTenantContext(
        ctx,
        (db) =>
            Promise.allSettled<SourceResult>([
                loadEvidenceEvents(db, ctx, range, now, limit),
                loadPolicyEvents(db, ctx, range, now, limit),
                loadVendorEvents(db, ctx, range, now, limit),
                loadVendorDocumentEvents(db, ctx, range, now, limit),
                loadAuditCycleEvents(db, ctx, range, now, limit),
                loadControlEvents(db, ctx, range, now, limit),
                loadTaskEvents(db, ctx, range, now, limit),
                loadFindingEvents(db, ctx, range, now, limit),
                // Epic G-7 — milestones contribute one event per milestone;
                // plans contribute one per non-completed plan target.
                // Agriculture data sources (PR 2 of the calendar roadmap).
                loadParcelLeaseEvents(db, ctx, range, now, limit),
                loadContractEvents(db, ctx, range, now, limit),
                loadPlantingEvents(db, ctx, range, now, limit),
                loadAgroSignalEvents(db, ctx, range, now, limit),
                // Global curated catalogue — see loadAgriEventEvents on why
                // this one carries no tenantId predicate.
                loadAgriEventEvents(db, ctx, range, now, limit),
                // Calendar roadmap PR 3 — AI news-derived proposals. Same
                // no-tenantId shape as loadAgriEventEvents; ONLY reads
                // status: 'APPROVED' rows.
                loadNewsDerivedEventEvents(db, ctx, range, now, limit),
                loadSupportSchemeEvents(db, ctx, range, now, limit),
            ]),
        { timeout: CALENDAR_TX_TIMEOUT_MS, maxWait: CALENDAR_TX_MAX_WAIT_MS },
    );

    let all: CalendarEvent[] = [];
    let truncated = false;
    settled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            all.push(...result.value.events);
            if (result.value.truncated) truncated = true;
            return;
        }
        // A partial calendar beats no calendar — log the failure and let
        // the surviving sources render rather than rethrowing.
        logger.error('compliance-calendar: source failed, serving a partial calendar', {
            component: 'compliance-calendar',
            tenantId: ctx.tenantId,
            source: CALENDAR_SOURCE_NAMES[i],
            error:
                result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
        });
    });

    // Apply the type / category filter post-aggregation. The per-source
    // queries don't filter by type because most sources contribute one
    // type only; pushing the predicate up keeps the loaders simple.
    if (input.types && input.types.length > 0) {
        const allowed = new Set<string>(input.types);
        all = all.filter((e) => allowed.has(e.type));
    }
    if (input.categories && input.categories.length > 0) {
        const allowed = new Set<string>(input.categories);
        all = all.filter((e) => allowed.has(e.category));
    }

    // Stable order: ascending by date — heatmap + month rendering
    // consumes events in chronological order.
    all.sort((a, b) => a.date.localeCompare(b.date));

    return {
        events: all,
        counts: countSummaries(all),
        range: {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
        },
        truncated,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Shared truncation-detection helper. Every loader below requests
 * `limit + 1` rows; if the extra row came back, the source was
 * truncated. Mirrors the `MAX_BADGE_COUNT + 1` trick in
 * `getUpcomingDeadlineCount` — cheaper than a second COUNT query, and it
 * tells the caller the truth instead of silently dropping rows.
 */
function capRows<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
    if (rows.length > limit) {
        return { rows: rows.slice(0, limit), truncated: true };
    }
    return { rows, truncated: false };
}

interface DateRange {
    from: Date;
    to: Date;
}

/**
 * Map a date+status into a calendar status. `now` is the comparison
 * anchor; `due_soon` window is 7 days. `done`/`scheduled` are decided
 * by the caller's domain logic and pass through verbatim.
 */
function classifyStatus(
    eventDate: Date,
    now: Date,
    isDone: boolean,
): CalendarEventStatus {
    if (isDone) return 'done';
    const diffMs = eventDate.getTime() - now.getTime();
    if (diffMs < 0) return 'overdue';
    if (diffMs <= 7 * 86_400_000) return 'due_soon';
    return 'scheduled';
}

function tenantHrefFromCtx(ctx: RequestContext, path: string): string {
    // Usecases don't know the slug, only the tenantId. The route handler
    // resolves slug; we leave a `/t/{slug}` placeholder that the route
    // handler rewrites. Keeping it server-side stops every UI from
    // re-implementing the same prefix.
    if (!ctx.tenantSlug) return path;
    return `/t/${ctx.tenantSlug}${path.startsWith('/') ? path : `/${path}`}`;
}

function countSummaries(events: CalendarEvent[]) {
    const byCategory: Record<CalendarEventCategory, number> = Object.fromEntries(
        CALENDAR_EVENT_CATEGORIES.map((c) => [c, 0]),
    ) as Record<CalendarEventCategory, number>;
    const byStatus: Record<CalendarEventStatus, number> = Object.fromEntries(
        CALENDAR_EVENT_STATUSES.map((s) => [s, 0]),
    ) as Record<CalendarEventStatus, number>;
    for (const e of events) {
        byCategory[e.category]++;
        byStatus[e.status]++;
    }
    return { total: events.length, byCategory, byStatus };
}

// ─── Per-source loaders ──────────────────────────────────────────────

async function loadEvidenceEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.evidence.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            nextReviewDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewDate: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.nextReviewDate)
        .map((r): CalendarEvent => {
            const date = r.nextReviewDate as Date;
            const isDone = r.status === 'APPROVED' && date > now;
            return {
                id: `EVIDENCE:${r.id}:evidence-review`,
                type: 'evidence-review',
                category: 'evidence',
                titleKey: 'evidenceReview',
                titleParams: { name: r.title },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'EVIDENCE',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/evidence/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return { events, truncated };
}

async function loadPolicyEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.policy.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            nextReviewAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewAt: true,
            status: true,
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.nextReviewAt)
        .map((r): CalendarEvent => {
            const date = r.nextReviewAt as Date;
            const isDone = r.status === 'ARCHIVED';
            return {
                id: `POLICY:${r.id}:policy-review`,
                type: 'policy-review',
                category: 'policy',
                titleKey: 'policyReview',
                titleParams: { name: r.title },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'POLICY',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/policies/${r.id}`),
            };
        });
    return { events, truncated };
}

async function loadVendorEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.vendor.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { nextReviewAt: { not: null, gte: range.from, lte: range.to } },
                {
                    contractRenewalAt: {
                        not: null,
                        gte: range.from,
                        lte: range.to,
                    },
                },
            ],
        },
        select: {
            id: true,
            name: true,
            nextReviewAt: true,
            contractRenewalAt: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isOffboarded = r.status === 'OFFBOARDED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-review`,
                type: 'vendor-review',
                category: 'vendor',
                titleKey: 'vendorReview',
                titleParams: { name: r.name },
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isOffboarded),
                entityType: 'VENDOR',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/vendors/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
        if (
            r.contractRenewalAt &&
            r.contractRenewalAt >= range.from &&
            r.contractRenewalAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-renewal`,
                type: 'vendor-renewal',
                category: 'vendor',
                titleKey: 'vendorRenewal',
                titleParams: { name: r.name },
                date: r.contractRenewalAt.toISOString(),
                status: classifyStatus(
                    r.contractRenewalAt,
                    now,
                    isOffboarded,
                ),
                entityType: 'VENDOR',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/vendors/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
    }
    return { events, truncated };
}

async function loadVendorDocumentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.vendorDocument.findMany({
        where: {
            tenantId: ctx.tenantId,
            validTo: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            type: true,
            validTo: true,
            vendorId: true,
            vendor: { select: { name: true } },
        },
        orderBy: { validTo: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.validTo)
        .map((r): CalendarEvent => {
            const date = r.validTo as Date;
            return {
                id: `VENDOR_DOCUMENT:${r.id}:vendor-document-expiry`,
                type: 'vendor-document-expiry',
                category: 'vendor',
                titleKey: 'vendorDocExpiry',
                titleParams: { type: String(r.type), name: r.vendor.name },
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'VENDOR_DOCUMENT',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/vendors/${r.vendorId}`),
            };
        });
    return { events, truncated };
}

async function loadAuditCycleEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    // AuditCycle is the only duration source today: emits an event with
    // `start` (periodStartAt) and `end` (periodEndAt). Either bound
    // intersecting the queried range surfaces the cycle.
    const rawRows = await db.auditCycle.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { periodStartAt: { gte: range.from, lte: range.to } },
                { periodEndAt: { gte: range.from, lte: range.to } },
                {
                    AND: [
                        { periodStartAt: { lte: range.from } },
                        { periodEndAt: { gte: range.to } },
                    ],
                },
            ],
        },
        select: {
            id: true,
            name: true,
            frameworkKey: true,
            periodStartAt: true,
            periodEndAt: true,
            status: true,
        },
        orderBy: { periodStartAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.periodStartAt || r.periodEndAt)
        .map((r): CalendarEvent => {
            const start = r.periodStartAt ?? r.periodEndAt!;
            const end =
                r.periodEndAt && r.periodStartAt && r.periodEndAt !== r.periodStartAt
                    ? r.periodEndAt
                    : undefined;
            const isDone = r.status === 'COMPLETE';
            return {
                id: `AUDIT_CYCLE:${r.id}:audit-cycle`,
                type: 'audit-cycle',
                category: 'audit',
                titleKey: 'auditCycle',
                titleParams: { name: r.name },
                date: start.toISOString(),
                end: end?.toISOString(),
                status: classifyStatus(end ?? start, now, isDone),
                entityType: 'AUDIT_CYCLE',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/audits/cycles/${r.id}`),
                detail: r.frameworkKey,
            };
        });
    return { events, truncated };
}

async function loadControlEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.control.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            applicability: 'APPLICABLE',
            nextDueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            nextDueAt: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.nextDueAt)
        .map((r): CalendarEvent => {
            const date = r.nextDueAt as Date;
            const isDone = r.status === 'IMPLEMENTED';
            return {
                id: `CONTROL:${r.id}:control-review`,
                type: 'control-review',
                category: 'control',
                titleKey: 'controlReview',
                titleParams: { name: r.name },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'CONTROL',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/controls/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return { events, truncated };
}

/**
 * Task — both compliance to-dos and farm work share this model.
 * `type: 'FARM_TASK'` rows are field work, not a compliance deadline, and
 * get their own category/type/title (`farm-task-due` vs `task-due`) so
 * they read as "your farm's own to-do" rather than a GRC obligation.
 *
 * Farm tasks link WHICH field via `TaskLink` (LOCATION/PARCEL) — a
 * polymorphic join table with no typed Prisma relation to either target
 * model, so it can't be resolved with a single nested `include`. The
 * `links` nested select below IS a real Task -> TaskLink relation
 * (one batched query, not per-row); resolving LOCATION/PARCEL names off
 * of it is a second pair of batched `id IN (...)` lookups — the same
 * "hoist to one findMany + in-memory map" shape the N+1 guardrail
 * prescribes, never a read inside the per-row loop.
 */
async function loadTaskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.task.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueAt: true,
            status: true,
            type: true,
            assigneeUserId: true,
            links: {
                where: { entityType: { in: ['LOCATION', 'PARCEL'] } },
                select: { entityType: true, entityId: true },
            },
        },
        orderBy: { dueAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);

    const locationIds = new Set<string>();
    const parcelIds = new Set<string>();
    for (const r of rows) {
        if (r.type !== 'FARM_TASK') continue;
        for (const link of r.links) {
            if (link.entityType === 'LOCATION') locationIds.add(link.entityId);
            if (link.entityType === 'PARCEL') parcelIds.add(link.entityId);
        }
    }
    const [locations, parcels] = await Promise.all([
        locationIds.size
            ? db.location.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: [...locationIds] } },
                  select: { id: true, name: true },
              })
            : Promise.resolve([]),
        parcelIds.size
            ? db.parcel.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: [...parcelIds] } },
                  select: { id: true, name: true },
              })
            : Promise.resolve([]),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.name]));
    const parcelNameById = new Map(parcels.map((p) => [p.id, p.name]));

    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            const isDone =
                r.status === 'RESOLVED' ||
                r.status === 'CLOSED' ||
                r.status === 'CANCELED';
            const isFarmTask = r.type === 'FARM_TASK';
            const fieldNames = isFarmTask
                ? r.links
                      .map((link) =>
                          link.entityType === 'LOCATION'
                              ? locationNameById.get(link.entityId)
                              : parcelNameById.get(link.entityId),
                      )
                      .filter((name): name is string => Boolean(name))
                : [];
            return {
                id: `TASK:${r.id}:${isFarmTask ? 'farm-task-due' : 'task-due'}`,
                type: isFarmTask ? 'farm-task-due' : 'task-due',
                category: isFarmTask ? 'farm-task' : 'task',
                titleKey: isFarmTask ? 'farmTaskDue' : 'taskDue',
                titleParams: { name: r.title },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TASK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/farm-tasks/${r.id}`),
                ownerUserId: r.assigneeUserId ?? undefined,
                detail: fieldNames.length ? fieldNames.join(', ') : undefined,
            };
        });
    return { events, truncated };
}

async function loadFindingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.finding.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            dueDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            status: true,
            owner: true,
        },
        orderBy: { dueDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.dueDate)
        .map((r): CalendarEvent => {
            const date = r.dueDate as Date;
            const isDone = r.status === 'CLOSED';
            return {
                id: `FINDING:${r.id}:finding-due`,
                type: 'finding-due',
                category: 'finding',
                titleKey: 'findingDue',
                titleParams: { name: r.title },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'FINDING',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/findings/${r.id}`),
                ownerUserId: r.owner ?? undefined,
            };
        });
    return { events, truncated };
}

// ─── Lightweight badge query ─────────────────────────────────────────

/**
 * Cheap count of upcoming + overdue deadlines used by the sidebar
 * Calendar nav badge. Bounded to a 7-day forward window + everything
 * already overdue that hasn't been resolved. Caps at `MAX_BADGE_COUNT`
 * so the badge never renders a huge number that's effectively noise
 * (we render `99+` past the cap on the UI side).
 */
const MAX_BADGE_COUNT = 99;

export async function getUpcomingDeadlineCount(
    ctx: RequestContext,
    options: { now?: Date; horizonDays?: number } = {},
): Promise<number> {
    assertCanRead(ctx);
    const now = options.now ?? new Date();
    const horizon = new Date(
        now.getTime() + (options.horizonDays ?? 7) * 86_400_000,
    );

    // Count, don't fetch — we only need a number for the badge. The
    // `take: MAX_BADGE_COUNT + 1` pattern lets us know if the real
    // number exceeds the cap without doing a full COUNT. Wrapped in
    // `runInTenantContext` so the read goes through RLS-bound `app_user`.
    const [tasks, controls, evidence, policies, vendors] =
        await runInTenantContext(ctx, (db) =>
            Promise.all([
                db.task.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        dueAt: { not: null, lte: horizon },
                        status: {
                            // Cast through readonly → mutable WorkItemStatus[]
                            // because Prisma's `notIn` rejects the
                            // `as const` literal type, and the shared
                            // ACTIVE_STATUS_FILTER constant types its
                            // payload as `string[]` which Prisma's
                            // newer generated client also rejects.
                            notIn: [
                                ...TERMINAL_WORK_ITEM_STATUSES,
                            ] as WorkItemStatus[],
                        },
                    },
                    take: MAX_BADGE_COUNT + 1,
                }),
                db.control.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        applicability: 'APPLICABLE',
                        nextDueAt: { not: null, lte: horizon },
                        status: { notIn: ['IMPLEMENTED', 'NOT_APPLICABLE'] },
                    },
                    take: MAX_BADGE_COUNT + 1,
                }),
                db.evidence.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        nextReviewDate: { not: null, lte: horizon },
                        status: { not: 'APPROVED' },
                    },
                    take: MAX_BADGE_COUNT + 1,
                }),
                db.policy.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        nextReviewAt: { not: null, lte: horizon },
                        status: { not: 'ARCHIVED' },
                    },
                    take: MAX_BADGE_COUNT + 1,
                }),
                db.vendor.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        status: { not: 'OFFBOARDED' },
                        OR: [
                            { nextReviewAt: { not: null, lte: horizon } },
                            { contractRenewalAt: { not: null, lte: horizon } },
                        ],
                    },
                    take: MAX_BADGE_COUNT + 1,
                }),
            ]),
        );

    return Math.min(
        MAX_BADGE_COUNT + 1,
        tasks + controls + evidence + policies + vendors,
    );
}

// ─── Epic G-7 — treatment plan + milestone calendar loaders ─────────

// ─── Agriculture catalogue ───────────────────────────────────────────

/**
 * AgriEvent.category (a free String on the model) -> calendar event type.
 *
 * Typed as an exhaustive Record over AgriEventCategory ON PURPOSE: a new
 * curated category becomes a COMPILE ERROR here rather than silently
 * falling through to a wrong label. The /events page carried the same
 * device, and it is what caught a subsidy deadline rendering as Fair.
 */
const AGRI_CATEGORY_TO_TYPE: Record<AgriEventCategory, CalendarEventType> = {
    fair: 'agri-fair',
    training: 'agri-training',
    webinar: 'agri-webinar',
    'subsidy-deadline': 'agri-subsidy-deadline',
};

/**
 * Curated agriculture events — fairs, trainings, webinars, subsidy
 * deadlines — merged into the schedule so a farmer sees them alongside
 * their own work rather than on a separate page.
 *
 * TENANCY: `AgriEvent` deliberately carries NO tenantId. It is a global,
 * platform-curated catalogue, written only through the
 * PLATFORM_ADMIN_API_KEY admin route and read identically by every
 * tenant. The absence of the usual `tenantId: ctx.tenantId` predicate
 * here is intentional, not an omission — adding one would not compile,
 * because the column does not exist.
 *
 * RANGE: matches events that START inside the window, plus multi-day
 * events that merely SPAN it (a three-day fair should appear on a month
 * that contains none of its start). `listUpcomingAgriEvents` cannot be
 * reused: it is upcoming-only and ignores `from`, so it would silently
 * drop everything in a month the user navigated back to.
 */
async function loadAgriEventEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.agriEvent.findMany({
        where: {
            OR: [
                { startsAt: { gte: range.from, lte: range.to } },
                {
                    AND: [
                        { startsAt: { lte: range.from } },
                        { endsAt: { gte: range.from } },
                    ],
                },
            ],
        },
        select: {
            id: true,
            title: true,
            description: true,
            category: true,
            startsAt: true,
            endsAt: true,
            place: true,
            url: true,
        },
        orderBy: { startsAt: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);

    const events = rows.map((r): CalendarEvent => {
        const type = AGRI_CATEGORY_TO_TYPE[
            r.category as AgriEventCategory
        ] ?? 'agri-fair';
        return {
            id: `AGRI_EVENT:${r.id}:${type}`,
            type,
            category: 'agri-event',
            titleKey: 'raw',
            titleParams: { name: r.title },
            detail: r.place ?? r.description ?? undefined,
            date: r.startsAt.toISOString(),
            end: r.endsAt ? r.endsAt.toISOString() : undefined,
            // A catalogue entry is an announcement, not an obligation the
            // tenant is measured against, so it is never overdue: it is
            // `done` once it has passed and `scheduled` before that.
            status: r.endsAt
                ? r.endsAt < now
                    ? 'done'
                    : 'scheduled'
                : r.startsAt < now
                  ? 'done'
                  : 'scheduled',
            entityType: 'AGRI_EVENT',
            entityId: r.id,
            // Off-site organiser page when we have one. Where the curator
            // recorded no URL the entry is purely informational, so it
            // points back at the calendar rather than fabricating a
            // destination or emitting a broken link.
            href: r.url ?? tenantHrefFromCtx(ctx, '/calendar'),
            external: r.url != null,
        };
    });
    return { events, truncated };
}

/**
 * NewsDerivedEvent.kind (subsidy-deadline/regulation-effective) -> calendar
 * event type + category. Exhaustive Record ON PURPOSE, mirroring
 * AGRI_CATEGORY_TO_TYPE above: a third kind added to
 * NEWS_DERIVED_EVENT_KINDS is a compile error here rather than a silently
 * mis-labeled dot.
 */
const NEWS_DERIVED_EVENT_KIND_TO_TYPE: Record<NewsDerivedEventKind, CalendarEventType> = {
    'subsidy-deadline': 'ai-news-subsidy-deadline',
    'regulation-effective': 'ai-news-regulation-effective',
};

/**
 * AI news-derived calendar-event proposals (calendar roadmap PR 3) —
 * extracted from GLOBAL policy-category MarketNewsItem headlines by the
 * daily `news-event-extraction` job. See `NewsDerivedEvent`'s model doc in
 * prisma/schema/agriculture.prisma for the full provenance story.
 *
 * TENANCY: like `loadAgriEventEvents`, NO tenantId predicate — the model
 * has none, every tenant reads the same rows.
 *
 * VISIBILITY: UNLIKE `loadAgriEventEvents`, only `status: 'APPROVED'` rows
 * are ever read here. A PROPOSED row is an unreviewed AI guess and stays
 * invisible to every tenant until a platform admin promotes it via
 * `POST /api/admin/news-derived-events/[id]/approve`. This is the one
 * loader in the whole fan-out that filters by anything other than the
 * date range — that filter IS the "proposed, never auto-published"
 * guarantee, not a policy check layered on top of it.
 *
 * PROVENANCE: every event here carries `provenance: 'ai-news'` +
 * `confidence` + `sourceUrl` so the renderer can never confuse this with a
 * database fact — see `CalendarEvent.provenance`'s docblock.
 */
/**
 * APPROVED support-scheme application windows, as calendar deadlines.
 *
 * Reuses the EXISTING subsidy-deadline calendar types rather than inventing a
 * parallel deadline concept — a subsidy deadline is a subsidy deadline whether
 * it came from a curated AgriEvent, a news-derived date-point, or a support
 * scheme's window. Three features wanted this upstream; three calendar types
 * would have been three ways to say the same thing.
 *
 * A scheme yields up to TWO events (opens, closes): both are dates a farmer
 * plans around, and collapsing them would drop whichever was not chosen.
 *
 * Only APPROVED rows appear, for the same reason the tenant-facing list filters
 * on it — an unreviewed AI extraction is a guess, and a guessed ДФЗ deadline on
 * a farmer's calendar is the failure this whole feature is shaped to avoid.
 */
async function loadSupportSchemeEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawSchemeRows = await db.supportScheme.findMany({
        where: {
            reviewStatus: 'APPROVED',
            OR: [
                { applicationOpensAt: { gte: range.from, lte: range.to } },
                { applicationClosesAt: { gte: range.from, lte: range.to } },
            ],
        },
        select: {
            id: true, title: true, authority: true,
            applicationOpensAt: true, applicationClosesAt: true,
            sourceUrl: true, source: true, confidence: true,
        },
        orderBy: { applicationClosesAt: 'asc' },
        take: limit + 1,
    });
    const { rows: schemeRows, truncated } = capRows(rawSchemeRows, limit);

    const schemeEvents: CalendarEvent[] = [];
    for (const scheme of schemeRows) {
        const isAi = scheme.source === 'ai-news';
        const type = isAi ? 'ai-news-subsidy-deadline' : 'agri-subsidy-deadline';
        for (const [phase, date] of [
            ['opens', scheme.applicationOpensAt],
            ['closes', scheme.applicationClosesAt],
        ] as const) {
            if (!date || date < range.from || date > range.to) continue;
            schemeEvents.push({
                id: `SUPPORT_SCHEME:${scheme.id}:${phase}`,
                type,
                category: 'ai-news',
                titleKey: 'raw',
                titleParams: { name: `${scheme.authority} · ${scheme.title}` },
                date: date.toISOString(),
                status: date < now ? 'done' : 'scheduled',
                entityType: 'SUPPORT_SCHEME',
                entityId: scheme.id,
                // Click-through goes to the Схеми (support measures) page, NOT the
                // source article: a farmer clicking a deadline wants the
                // measure's window and eligibility, and the article is one
                // field on that row. `sourceUrl` still travels so the side
                // panel can show "Source: <link>" beside the provenance chip.
                href: `/t/${ctx.tenantSlug ?? ''}/schemes`,
                external: false,
                ...(isAi ? { provenance: 'ai-news' as const } : {}),
                ...(scheme.confidence != null ? { confidence: scheme.confidence } : {}),
                ...(scheme.sourceUrl ? { sourceUrl: scheme.sourceUrl } : {}),
            });
        }
    }
    return { events: schemeEvents, truncated };
}

async function loadNewsDerivedEventEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.newsDerivedEvent.findMany({
        where: {
            status: 'APPROVED',
            eventDate: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            kind: true,
            eventDate: true,
            confidence: true,
            sourceUrl: true,
        },
        orderBy: { eventDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);

    const events = rows.map((r): CalendarEvent => {
        const type = NEWS_DERIVED_EVENT_KIND_TO_TYPE[
            r.kind as NewsDerivedEventKind
        ] ?? 'ai-news-subsidy-deadline';
        return {
            id: `NEWS_DERIVED_EVENT:${r.id}:${type}`,
            type,
            category: 'ai-news',
            titleKey: 'raw',
            titleParams: { name: r.title },
            date: r.eventDate.toISOString(),
            // An APPROVED proposal reads the same as a curated
            // announcement: never overdue, done once it has passed.
            status: r.eventDate < now ? 'done' : 'scheduled',
            entityType: 'NEWS_DERIVED_EVENT',
            entityId: r.id,
            href: r.sourceUrl,
            external: true,
            provenance: 'ai-news',
            confidence: r.confidence,
            sourceUrl: r.sourceUrl,
        };
    });
    return { events, truncated };
}

// ─── Agriculture data sources (PR 2 of the calendar roadmap) ────────
//
// Thirteen date-bearing agriculture models existed with zero calendar
// presence before this PR. Four are wired up here, chosen for having a
// clear "this belongs on a schedule a farmer checks" shape: land
// obligations (lease), commercial commitments (contract), crop cycles
// (planting), and time-sensitive advisories (agro-signal). Each follows
// `loadAgriEventEvents`'s shape above: tenant predicate (or documented
// absence), a range predicate that also matches rows SPANNING the
// window, `orderBy` + the `limit + 1`/`capRows` truncation trick, and a
// `titleKey`/`titleParams` pair — never an English string built here.

/**
 * A land-use agreement (ParcelLease) — duration event from `startDate`
 * to `endDate`. Both bounds are nullable (a lease can be recorded
 * before a start/end date is agreed); `capRows`'s slice runs after the
 * null-bound rows are already excluded so `truncated` still reflects
 * the real query, not the post-filter count.
 */
async function loadParcelLeaseEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.parcelLease.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { startDate: { gte: range.from, lte: range.to } },
                { endDate: { gte: range.from, lte: range.to } },
                {
                    AND: [
                        { startDate: { lte: range.from } },
                        { endDate: { gte: range.to } },
                    ],
                },
            ],
        },
        select: {
            id: true,
            lessorName: true,
            startDate: true,
            endDate: true,
            parcel: { select: { name: true } },
        },
        orderBy: { startDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.startDate || r.endDate)
        .map((r): CalendarEvent => {
            const start = r.startDate ?? r.endDate!;
            const end =
                r.endDate && r.startDate && r.endDate !== r.startDate
                    ? r.endDate
                    : undefined;
            return {
                id: `PARCEL_LEASE:${r.id}:parcel-lease-term`,
                type: 'parcel-lease-term',
                category: 'lease',
                titleKey: 'parcelLease',
                titleParams: { name: r.parcel.name },
                date: start.toISOString(),
                end: end?.toISOString(),
                // No lifecycle status on ParcelLease — an ended term with
                // no renewal recorded genuinely IS overdue attention.
                status: classifyStatus(end ?? start, now, false),
                entityType: 'PARCEL_LEASE',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, '/rent'),
                detail: r.lessorName,
            };
        });
    return { events, truncated };
}

/** Terminal Contract statuses — no further delivery-window action needed. */
const CONTRACT_DONE_STATUSES = new Set(['DELIVERED', 'SETTLED', 'CANCELLED']);

/**
 * A grain marketing/supply contract — duration event from
 * `deliveryStart` to `deliveryEnd`.
 */
async function loadContractEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.contract.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { deliveryStart: { gte: range.from, lte: range.to } },
                { deliveryEnd: { gte: range.from, lte: range.to } },
                {
                    AND: [
                        { deliveryStart: { lte: range.from } },
                        { deliveryEnd: { gte: range.to } },
                    ],
                },
            ],
        },
        select: {
            id: true,
            counterparty: true,
            commodity: true,
            deliveryStart: true,
            deliveryEnd: true,
            status: true,
        },
        orderBy: { deliveryStart: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.deliveryStart || r.deliveryEnd)
        .map((r): CalendarEvent => {
            const start = r.deliveryStart ?? r.deliveryEnd!;
            const end =
                r.deliveryEnd && r.deliveryStart && r.deliveryEnd !== r.deliveryStart
                    ? r.deliveryEnd
                    : undefined;
            const isDone = CONTRACT_DONE_STATUSES.has(r.status);
            return {
                id: `CONTRACT:${r.id}:contract-delivery-window`,
                type: 'contract-delivery-window',
                category: 'contract',
                titleKey: 'contractDelivery',
                titleParams: { name: r.counterparty },
                date: start.toISOString(),
                end: end?.toISOString(),
                status: classifyStatus(end ?? start, now, isDone),
                entityType: 'CONTRACT',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, '/grain/contracts'),
                detail: r.commodity ?? undefined,
            };
        });
    return { events, truncated };
}

/** Terminal Planting statuses — the succession finished its life cycle. */
const PLANTING_DONE_STATUSES = new Set(['HARVESTED', 'TERMINATED']);

/**
 * One succession instance (Planting) — duration event from `sowDate` to
 * `harvestEndDate`. Labeled by variety when the succession has one,
 * falling back to the parent crop plan's crop type (both nullable on a
 * DIRECT_SOW or not-yet-varietal plan); the field it's growing in
 * (parcel, else location) rides in `detail`.
 */
async function loadPlantingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.planting.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { sowDate: { gte: range.from, lte: range.to } },
                { harvestEndDate: { gte: range.from, lte: range.to } },
                {
                    AND: [
                        { sowDate: { lte: range.from } },
                        { harvestEndDate: { gte: range.to } },
                    ],
                },
            ],
        },
        select: {
            id: true,
            cropPlanId: true,
            sowDate: true,
            harvestEndDate: true,
            status: true,
            variety: { select: { name: true } },
            location: { select: { name: true } },
            parcel: { select: { name: true } },
            cropPlan: { select: { cropType: { select: { name: true } } } },
        },
        orderBy: { sowDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows
        .filter((r) => r.sowDate || r.harvestEndDate)
        .map((r): CalendarEvent => {
            const start = r.sowDate ?? r.harvestEndDate!;
            const end =
                r.harvestEndDate && r.sowDate && r.harvestEndDate !== r.sowDate
                    ? r.harvestEndDate
                    : undefined;
            const isDone = PLANTING_DONE_STATUSES.has(r.status);
            const fieldLabel = r.parcel?.name ?? r.location?.name;
            return {
                id: `PLANTING:${r.id}:planting-cycle`,
                type: 'planting-cycle',
                category: 'planting',
                titleKey: 'plantingCycle',
                titleParams: { name: r.variety?.name ?? r.cropPlan.cropType.name },
                date: start.toISOString(),
                end: end?.toISOString(),
                status: classifyStatus(end ?? start, now, isDone),
                entityType: 'PLANTING',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/planning/${r.cropPlanId}`),
                detail: fieldLabel,
            };
        });
    return { events, truncated };
}

/**
 * AgroSignal.kind (SPRAY_WINDOW/DISEASE_RISK) -> calendar event type +
 * titleKey. Exhaustive Record ON PURPOSE, mirroring AGRI_CATEGORY_TO_TYPE
 * above: a third kind added to the enum is a compile error here rather
 * than a silently mis-labeled point.
 */
const AGRO_SIGNAL_KIND_TO_TYPE: Record<AgroSignalKind, CalendarEventType> = {
    SPRAY_WINDOW: 'agro-signal-spray-window',
    DISEASE_RISK: 'agro-signal-disease-risk',
};
const AGRO_SIGNAL_KIND_TO_TITLE_KEY: Record<AgroSignalKind, string> = {
    SPRAY_WINDOW: 'agroSignalSprayWindow',
    DISEASE_RISK: 'agroSignalDiseaseRisk',
};

/**
 * AgroSignal — point event on `signalDate`. NO `deletedAt` filter: the
 * model has no such column (it's an idempotency/provenance ledger the
 * daily weather job claims rows into, not a user-editable record — see
 * the model doc in agro.prisma). A signal is already a fired, historical
 * reading rather than an obligation, so it is never `due_soon`/`overdue`:
 * `done` once its date has passed, `scheduled` for the (rare) same-day
 * case where `now` lands before end-of-day.
 */
async function loadAgroSignalEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<SourceResult> {
    const rawRows = await db.agroSignal.findMany({
        where: {
            tenantId: ctx.tenantId,
            signalDate: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            kind: true,
            signalDate: true,
            locationId: true,
            location: { select: { name: true } },
        },
        orderBy: { signalDate: 'asc' },
        take: limit + 1,
    });
    const { rows, truncated } = capRows(rawRows, limit);
    const events = rows.map((r): CalendarEvent => {
        const date = r.signalDate;
        const type = AGRO_SIGNAL_KIND_TO_TYPE[r.kind];
        return {
            id: `AGRO_SIGNAL:${r.id}:${type}`,
            type,
            category: 'agro-signal',
            titleKey: AGRO_SIGNAL_KIND_TO_TITLE_KEY[r.kind],
            titleParams: { name: r.location.name },
            date: date.toISOString(),
            status: date.getTime() <= now.getTime() ? 'done' : 'scheduled',
            entityType: 'AGRO_SIGNAL',
            entityId: r.id,
            href: tenantHrefFromCtx(ctx, `/locations/${r.locationId}`),
        };
    });
    return { events, truncated };
}
