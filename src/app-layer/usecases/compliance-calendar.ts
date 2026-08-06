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
 *   - Task           (dueAt)
 *   - Risk           (nextReviewAt, targetDate)
 *   - Finding        (dueDate)
 *
 * Tenant isolation: every Prisma query starts with `tenantId: ctx.tenantId`.
 *
 * Range bounding: the schema guarantees `from <= to <= from + 2y`. Inside
 * the usecase we issue parallel point queries with date predicates so the
 * DB can use the per-entity indexes on the date columns + `(tenantId, …)`.
 *
 * Status mapping: each source maps its lifecycle status into one of
 * `scheduled | due_soon | overdue | done | unknown`. The map is local
 * to the source (one place to look when a new entity is added).
 */

import { runInTenantContext } from '@/lib/db-context';
import type { AgriEventCategory } from '@/app-layer/schemas/agri-event.schemas';
import type { PrismaTx } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import type { WorkItemStatus } from '@prisma/client';
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
    const [
        evidenceEvents,
        policyEvents,
        vendorEvents,
        vendorDocEvents,
        auditCycleEvents,
        controlEvents,
        testPlanEvents,
        taskEvents,
        riskEvents,
        findingEvents,
        treatmentMilestoneEvents,
        treatmentPlanEvents,
        agriEventEvents,
    ] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            loadEvidenceEvents(db, ctx, range, now, limit),
            loadPolicyEvents(db, ctx, range, now, limit),
            loadVendorEvents(db, ctx, range, now, limit),
            loadVendorDocumentEvents(db, ctx, range, now, limit),
            loadAuditCycleEvents(db, ctx, range, now, limit),
            loadControlEvents(db, ctx, range, now, limit),
            loadTestPlanEvents(db, ctx, range, now, limit),
            loadTaskEvents(db, ctx, range, now, limit),
            loadRiskEvents(db, ctx, range, now, limit),
            loadFindingEvents(db, ctx, range, now, limit),
            // Epic G-7 — milestones contribute one event per milestone;
            // plans contribute one per non-completed plan target.
            loadTreatmentMilestoneEvents(db, ctx, range, now, limit),
            loadTreatmentPlanEvents(db, ctx, range, now, limit),
            // Global curated catalogue — see loadAgriEventEvents on why
            // this one carries no tenantId predicate.
            loadAgriEventEvents(db, ctx, range, now, limit),
        ]),
    );

    let all: CalendarEvent[] = [
        ...evidenceEvents,
        ...policyEvents,
        ...vendorEvents,
        ...vendorDocEvents,
        ...auditCycleEvents,
        ...controlEvents,
        ...testPlanEvents,
        ...taskEvents,
        ...riskEvents,
        ...findingEvents,
        ...treatmentMilestoneEvents,
        ...treatmentPlanEvents,
        ...agriEventEvents,
    ];

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
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────

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
): Promise<CalendarEvent[]> {
    const rows = await db.evidence.findMany({
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
        take: limit,
    });
    return rows
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
}

async function loadPolicyEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.policy.findMany({
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
        take: limit,
    });
    return rows
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
}

async function loadVendorEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.vendor.findMany({
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
        take: limit,
    });
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
    return events;
}

async function loadVendorDocumentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.vendorDocument.findMany({
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
        take: limit,
    });
    return rows
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
}

async function loadAuditCycleEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    // AuditCycle is the only duration source today: emits an event with
    // `start` (periodStartAt) and `end` (periodEndAt). Either bound
    // intersecting the queried range surfaces the cycle.
    const rows = await db.auditCycle.findMany({
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
        take: limit,
    });
    return rows
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
}

async function loadControlEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.control.findMany({
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
        take: limit,
    });
    return rows
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
}

async function loadTestPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.controlTestPlan.findMany({
        where: {
            tenantId: ctx.tenantId,
            status: 'ACTIVE',
            nextDueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            nextDueAt: true,
            controlId: true,
            control: { select: { name: true } },
        },
        take: limit,
    });
    return rows
        .filter((r) => r.nextDueAt)
        .map((r): CalendarEvent => {
            const date = r.nextDueAt as Date;
            return {
                id: `CONTROL_TEST_PLAN:${r.id}:control-test-due`,
                type: 'control-test-due',
                category: 'control',
                titleKey: 'testDue',
                titleParams: { name: r.name },
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'CONTROL_TEST_PLAN',
                entityId: r.id,
                href: tenantHrefFromCtx(
                    ctx,
                    `/controls/${r.controlId}/tests/${r.id}`,
                ),
                detail: r.control.name,
            };
        });
}

async function loadTaskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.task.findMany({
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
            assigneeUserId: true,
        },
        take: limit,
    });
    return rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            const isDone =
                r.status === 'RESOLVED' ||
                r.status === 'CLOSED' ||
                r.status === 'CANCELED';
            return {
                id: `TASK:${r.id}:task-due`,
                type: 'task-due',
                category: 'task',
                titleKey: 'taskDue',
                titleParams: { name: r.title },
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TASK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/farm-tasks/${r.id}`),
                ownerUserId: r.assigneeUserId ?? undefined,
            };
        });
}

async function loadRiskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.risk.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [
                { nextReviewAt: { not: null, gte: range.from, lte: range.to } },
                { targetDate: { not: null, gte: range.from, lte: range.to } },
            ],
        },
        select: {
            id: true,
            title: true,
            nextReviewAt: true,
            targetDate: true,
            status: true,
        },
        take: limit,
    });
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isClosed = r.status === 'CLOSED' || r.status === 'ACCEPTED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-review`,
                type: 'risk-review',
                category: 'risk',
                titleKey: 'riskReview',
                titleParams: { name: r.title },
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}`),
            });
        }
        if (
            r.targetDate &&
            r.targetDate >= range.from &&
            r.targetDate <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-target`,
                type: 'risk-target',
                category: 'risk',
                titleKey: 'riskTarget',
                titleParams: { name: r.title },
                date: r.targetDate.toISOString(),
                status: classifyStatus(r.targetDate, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}`),
            });
        }
    }
    return events;
}

async function loadFindingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.finding.findMany({
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
        take: limit,
    });
    return rows
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

/**
 * Each non-completed milestone contributes one calendar event keyed
 * by its `dueDate`. Completed milestones surface with status `done`
 * so the heatmap can show "this was on the calendar; here's the
 * receipt". Click-through lands on the parent risk's detail page,
 * scrolled to the treatment-plan card section.
 */
async function loadTreatmentMilestoneEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.treatmentMilestone.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueDate: { gte: range.from, lte: range.to },
            // Skip milestones whose parent plan was soft-deleted or
            // whose linked risk was retired.
            treatmentPlan: { deletedAt: null },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            completedAt: true,
            sortOrder: true,
            treatmentPlan: {
                select: {
                    id: true,
                    riskId: true,
                    risk: { select: { title: true } },
                },
            },
        },
        orderBy: { dueDate: 'asc' },
        take: limit,
    });
    return rows.map((r): CalendarEvent => {
        const date = r.dueDate;
        const isDone = r.completedAt !== null;
        const riskTitle = r.treatmentPlan?.risk?.title ?? 'Risk';
        return {
            id: `TREATMENT_MILESTONE:${r.id}:treatment-milestone-due`,
            type: 'treatment-milestone-due',
            category: 'risk',
            titleKey: 'milestone',
            titleParams: { name: r.title },
            date: date.toISOString(),
            status: classifyStatus(date, now, isDone),
            entityType: 'TREATMENT_MILESTONE',
            entityId: r.id,
            href: tenantHrefFromCtx(
                ctx,
                `/risks/${r.treatmentPlan?.riskId ?? ''}`,
            ),
            detail: riskTitle,
        };
    });
}

/**
 * Treatment plans contribute one event per non-completed plan keyed
 * by `targetDate` so the calendar shows the plan-level deadline next
 * to its constituent milestone deadlines.
 */
async function loadTreatmentPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarEvent[]> {
    const rows = await db.riskTreatmentPlan.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
            targetDate: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            riskId: true,
            strategy: true,
            targetDate: true,
            risk: { select: { title: true } },
        },
        orderBy: { targetDate: 'asc' },
        take: limit,
    });
    return rows.map((r): CalendarEvent => {
        const date = r.targetDate;
        return {
            id: `RISK_TREATMENT_PLAN:${r.id}:treatment-plan-target`,
            type: 'treatment-plan-target',
            category: 'risk',
            titleKey: 'planTarget',
            titleParams: { name: r.risk?.title ?? '' },
            date: date.toISOString(),
            status: classifyStatus(date, now, false),
            entityType: 'RISK_TREATMENT_PLAN',
            entityId: r.id,
            href: tenantHrefFromCtx(ctx, `/risks/${r.riskId}`),
            detail: `${r.strategy} strategy`,
        };
    });
}

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
): Promise<CalendarEvent[]> {
    const rows = await db.agriEvent.findMany({
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
        take: limit,
    });

    return rows.map((r): CalendarEvent => {
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
}
