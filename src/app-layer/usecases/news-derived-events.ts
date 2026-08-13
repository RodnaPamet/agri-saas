/**
 * News-derived calendar events (calendar roadmap PR 3) — the platform-admin
 * REVIEW surface for `NewsDerivedEvent`, the GLOBAL table the daily
 * `news-event-extraction` job writes PROPOSED rows into (see
 * `src/app-layer/jobs/news-event-extraction.ts`).
 *
 * **Population.** Every row starts life written by the extraction job
 * (never by a tenant, never by this module). This module only ever
 * TRANSITIONS an existing row's `status`:
 *   - `listNewsDerivedEvents` — the review queue read (defaults to
 *     `PROPOSED`, the admin's inbox).
 *   - `approveNewsDerivedEvent` / `rejectNewsDerivedEvent` — the ONLY two
 *     writes, both gated by `POST /api/admin/news-derived-events/[id]/
 *     approve|reject` (PLATFORM_ADMIN_API_KEY, the `agri-events.ts`
 *     pattern). A row that reaches `APPROVED` becomes visible on every
 *     tenant's calendar via `loadNewsDerivedEventEvents` in
 *     `calendar.ts`; `REJECTED` (and `PROPOSED`) never surface
 *     there. There is deliberately NO auto-promotion path anywhere in the
 *     codebase — every approval is a human decision.
 *
 * Like `agri-events.ts`, these take no `RequestContext` — the caller has no
 * user session (platform-admin key auth only) — and are NOT written to
 * `AuditLog` for the identical structural reason `agri-events.ts` documents:
 * `AuditLog.tenantId` is non-nullable with a per-tenant hash-chain lock, and
 * a global table has no tenant to hang a row on. The structured log lines
 * below are the equivalent trail.
 *
 * @module app-layer/usecases/news-derived-events
 */
import { logger } from '@/lib/observability';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    NEWS_DERIVED_EVENT_STATUSES,
    type NewsDerivedEventDto,
    type NewsDerivedEventKind,
    type NewsDerivedEventStatus,
} from '@/app-layer/schemas/news-derived-event.schemas';

export interface PlatformActor {
    /** Propagated from `x-request-id`; falls back to 'platform-admin'. */
    requestId: string;
}

/**
 * The global prisma handle, resolved lazily — mirrors `agri-events.ts`'s
 * `globalDb()`: this module has no tenant transaction to borrow (every
 * caller is platform-admin-key-gated with no `RequestContext`), and lazy
 * resolution keeps module load free for importers that never actually
 * call into it.
 */
async function globalDb() {
    const { prisma } = await import('@/lib/prisma');
    return prisma;
}

function toDto(row: {
    id: string;
    title: string;
    kind: string;
    eventDate: Date;
    confidence: number;
    sourceExcerpt: string;
    sourceNewsItemId: string;
    sourceUrl: string;
    sourceTitle: string;
    status: string;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    createdAt: Date;
}): NewsDerivedEventDto {
    return {
        id: row.id,
        title: row.title,
        kind: row.kind as NewsDerivedEventKind,
        eventDate: row.eventDate.toISOString(),
        confidence: row.confidence,
        sourceExcerpt: row.sourceExcerpt,
        sourceNewsItemId: row.sourceNewsItemId,
        sourceUrl: row.sourceUrl,
        sourceTitle: row.sourceTitle,
        status: row.status as NewsDerivedEventStatus,
        reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
        reviewedBy: row.reviewedBy,
        createdAt: row.createdAt.toISOString(),
    };
}

/** Bounds the admin review-queue page — this is a curation inbox, not a report. */
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/**
 * The platform-admin review queue. Defaults to `PROPOSED` (the inbox);
 * pass `status` to inspect the approved/rejected history instead.
 */
export async function listNewsDerivedEvents(opts: {
    status?: NewsDerivedEventStatus;
    limit?: number;
} = {}): Promise<NewsDerivedEventDto[]> {
    const status = opts.status ?? 'PROPOSED';
    const limit = Math.min(Math.max(opts.limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
    const rows = await (await globalDb()).newsDerivedEvent.findMany({
        where: { status },
        orderBy: { eventDate: 'asc' },
        take: limit,
    });
    return rows.map(toDto);
}

/** Shared state-machine guard: only a PROPOSED row can be reviewed. */
async function claimForReview(id: string) {
    const existing = await (await globalDb()).newsDerivedEvent.findUnique({ where: { id } });
    if (!existing) throw notFound('News-derived event not found');
    if (existing.status !== 'PROPOSED') {
        throw badRequest(
            `Cannot review an event already ${existing.status.toLowerCase()} — only PROPOSED events accept a decision`,
        );
    }
    return existing;
}

export async function approveNewsDerivedEvent(
    id: string,
    actor: PlatformActor,
): Promise<NewsDerivedEventDto> {
    await claimForReview(id);
    const now = new Date();
    const updated = await (await globalDb()).newsDerivedEvent.update({
        where: { id },
        data: { status: 'APPROVED', reviewedAt: now, reviewedBy: actor.requestId },
    });
    logger.info('news-derived-events.approved', {
        component: 'news-derived-events',
        actorType: 'PLATFORM_ADMIN',
        requestId: actor.requestId,
        newsDerivedEventId: id,
        kind: updated.kind,
        eventDate: updated.eventDate.toISOString(),
    });
    return toDto(updated);
}

export async function rejectNewsDerivedEvent(
    id: string,
    actor: PlatformActor,
): Promise<NewsDerivedEventDto> {
    await claimForReview(id);
    const now = new Date();
    const updated = await (await globalDb()).newsDerivedEvent.update({
        where: { id },
        data: { status: 'REJECTED', reviewedAt: now, reviewedBy: actor.requestId },
    });
    logger.info('news-derived-events.rejected', {
        component: 'news-derived-events',
        actorType: 'PLATFORM_ADMIN',
        requestId: actor.requestId,
        newsDerivedEventId: id,
        kind: updated.kind,
    });
    return toDto(updated);
}

// Re-exported so callers (and tests) don't need a second import for the
// status literal union used by the query schema.
export { NEWS_DERIVED_EVENT_STATUSES };
