/**
 * Company promotions ("Offers" / Промоции) — #12.
 *
 * `Promotion` is a GLOBAL catalogue (no tenantId, like `Unit` / `AgriEvent`),
 * so the feed is the same for every tenant. Read-only from the app; population
 * is via seed / admin tooling. `createPromotionLead` captures an "Ask for
 * offer" lead (mirrors the Exchange inquiry flow) — the lead row commits first,
 * then a best-effort confirmation notification fires (fail-open).
 *
 * @module app-layer/usecases/promotions
 */
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, conflict, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { translateFor } from '@/lib/i18n/server-messages';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { Prisma } from '@prisma/client';

export interface PromotionDto {
    id: string;
    company: string;
    title: string;
    body: string | null;
    mediaUrl: string | null;
    category: string;
    ctaUrl: string | null;
    validFrom: string | null;
    validTo: string | null;
    /**
     * Has the VIEWING tenant already sent a lead for this promotion?
     *
     * Viewer-relative, computed in the projection rather than at the call
     * site — the same shape `ExchangePublicListing.isOwn` uses. It exists
     * because `@@unique([promotionId, inquirerTenantId])` makes a second
     * lead impossible: without this the UI cheerfully invites the operator
     * to retype a message the database will refuse.
     */
    hasRequested: boolean;
}

/**
 * Active promotions, newest first. A promotion is shown only if it clears
 * BOTH gates:
 *
 *   - **published** — `publishedAt` is set. A draft stays invisible however
 *     its dates read, so support can save a half-finished ad without it
 *     appearing in every tenant's feed.
 *   - **in window** — `validFrom` in the past or unset, `validTo` in the
 *     future or unset.
 *
 * Bounded to a sensible page. The global catalogue carries no tenant scope,
 * but we still read it through the tenant transaction (no RLS on the table —
 * mirrors how the Unit / AgriEvent catalogues are read).
 *
 * Only the supplier's PUBLIC name is joined in — the encrypted contact fields
 * on `Company` are internal and must never reach a tenant-facing DTO.
 */
/**
 * Lazy prisma for the GLOBAL catalogue read that carries no `RequestContext`
 * (the nav probe runs in the tenant layout, before any usecase context
 * exists). Mirrors `agri-events.ts` — the sibling global catalogue.
 */
async function globalDb() {
    const { prisma } = await import('@/lib/prisma');
    return prisma;
}

/**
 * The visibility predicate — BOTH gates, shared so the nav gate and the feed
 * agree on the word. It must stay in lockstep with the docblock above: a
 * catalogue holding only drafts is an EMPTY feed, so the nav must treat it as
 * empty too.
 */
function visibleWhere(now: Date): Prisma.PromotionWhereInput {
    return {
        AND: [
            { publishedAt: { not: null } },
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ validTo: null }, { validTo: { gte: now } }] },
        ],
    };
}

/**
 * Does the catalogue hold at least one VISIBLE promotion? Gates the sidebar
 * entry so the nav never links to a page that can only render its empty state.
 *
 * Memoised in-process for the same reason as `hasUpcomingAgriEvents`: the
 * answer is IDENTICAL for every tenant and user (it depends only on the
 * catalogue and the clock), while the tenant layout is `force-dynamic` +
 * `noStore()` for permission freshness and would otherwise re-run this once per
 * navigation per user. The short TTL means a cached `true` can briefly outlive
 * the last expiring promotion — harmless, since the page still renders its own
 * empty state and the gate is a polish affordance, not a permission.
 */
const NONEMPTY_TTL_MS = 60_000;
let nonEmptyMemo: { value: boolean; expiresAt: number } | null = null;

export async function hasVisiblePromotions(now: Date = new Date()): Promise<boolean> {
    if (nonEmptyMemo && nonEmptyMemo.expiresAt > now.getTime()) return nonEmptyMemo.value;
    const row = await (await globalDb()).promotion.findFirst({
        where: visibleWhere(now),
        select: { id: true },
    });
    const value = row !== null;
    nonEmptyMemo = { value, expiresAt: now.getTime() + NONEMPTY_TTL_MS };
    return value;
}

/** Drop the memo so a curation write is reflected without waiting out the TTL. */
export function invalidatePromotionsCache(): void {
    nonEmptyMemo = null;
}

export async function listActivePromotions(
    ctx: RequestContext,
    opts: { limit?: number; now?: Date } = {},
): Promise<PromotionDto[]> {
    assertCanRead(ctx);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const now = opts.now ?? new Date();
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.promotion.findMany({
            // Shared with the `hasVisiblePromotions` nav gate — two copies of
            // "visible" is how a nav link outlives the content it points at.
            where: visibleWhere(now),
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { company: { select: { name: true } } },
        });

        // Which of these has this tenant already asked about? One indexed
        // lookup over the page we just read — `@@unique([promotionId,
        // inquirerTenantId])` IS the index, so this is a covered scan of at
        // most `limit` (<=100) keys, inside the same tenant transaction.
        // Bounded by the page above, so no `take:` of its own is needed.
        const requestedIds =
            rows.length === 0
                ? new Set<string>()
                : new Set(
                      (
                          await db.promotionLead.findMany({
                              where: {
                                  promotionId: { in: rows.map((p) => p.id) },
                                  inquirerTenantId: ctx.tenantId,
                                  deletedAt: null,
                              },
                              select: { promotionId: true },
                          })
                      ).map((l) => l.promotionId),
                  );

        return rows.map((p) => ({
            id: p.id,
            company: p.company.name,
            title: p.title,
            body: p.body,
            mediaUrl: p.mediaUrl,
            category: p.category,
            ctaUrl: p.ctaUrl,
            validFrom: p.validFrom ? p.validFrom.toISOString() : null,
            validTo: p.validTo ? p.validTo.toISOString() : null,
            hasRequested: requestedIds.has(p.id),
        }));
    });
}

/**
 * Normalised dedup key for a supplier name — lowercase, trimmed, internal
 * whitespace collapsed. Mirrored in the `20260720100000_promotion_company`
 * migration; the `Company.nameKey` unique index is the actual guarantee, this
 * is just how callers compute the value to look up or insert.
 */
export function companyNameKey(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface CreatePromotionLeadInput {
    promotionId: string;
    message: string;
    contextParcelId?: string | null;
    /**
     * The farmer's explicit consent to share their name and message with the
     * supplier. Enforced twice on purpose: `z.literal(true)` rejects it at the
     * HTTP edge, and the check below refuses it again here, because the
     * usecase is also reachable from jobs and future callers that never pass
     * through that schema.
     */
    consent: boolean;
}

/**
 * Capture an "Ask for offer" lead against a global promotion. The lead commits
 * first (inside the tenant transaction); a P2002 on the
 * @@unique([promotionId, inquirerTenantId]) becomes a friendly conflict so a
 * tenant can't spam a promotion. After commit, a best-effort confirmation
 * notification is written for the requesting user — fail-open, so a
 * notification error can never roll back the lead.
 */
export async function createPromotionLead(ctx: RequestContext, input: CreatePromotionLeadInput) {
    assertCanWrite(ctx);
    // No lead without recorded consent. This is a lawfulness gate, not
    // validation: the row is contact PII that exists to be forwarded to a
    // third party, so without consent there is no basis to store it at all.
    if (input.consent !== true) {
        throw badRequest('Consent is required before a request can be sent to the supplier');
    }
    const consentedAt = new Date();
    const sanitizedMessage = sanitizePlainText(input.message);

    const { lead, promotion } = await runInTenantContext(ctx, async (db) => {
        const promotion = await db.promotion.findUnique({
            where: { id: input.promotionId },
            include: { company: { select: { name: true } } },
        });
        if (!promotion) throw notFound('Promotion not found');
        // A draft or expired promotion must not accept leads — the card is
        // gone from the feed, so a request against it can only come from a
        // stale page or a hand-made call.
        if (!promotion.publishedAt) throw notFound('Promotion not found');

        let lead;
        try {
            lead = await db.promotionLead.create({
                data: {
                    promotionId: promotion.id,
                    inquirerTenantId: ctx.tenantId,
                    inquirerUserId: ctx.userId,
                    requestMessage: sanitizedMessage,
                    contextParcelId: input.contextParcelId ?? null,
                    consentedAt,
                },
            });
        } catch (err) {
            // @@unique([promotionId, inquirerTenantId]) — one lead per tenant per
            // promotion. Turn the raw unique violation into a friendly conflict.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw conflict('You have already requested an offer for this promotion');
            }
            throw err;
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'PromotionLead',
            entityId: lead.id,
            details: `Offer request on promotion ${promotion.id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'PromotionLead',
                operation: 'created',
                after: { promotionId: promotion.id },
                summary: `Offer request for ${promotion.company.name}: ${promotion.title}`,
            },
        });

        return { lead, promotion };
    });

    // Best-effort, fail-open — the lead is already committed.
    await notifyRequesterOfLead(ctx, promotion.company.name);

    return lead;
}

/**
 * Receipt notification for the requesting user. Runs in the requester's own
 * tenant context (Notification is RLS-forced) and swallows every error (logs)
 * so it can never roll back the lead.
 *
 * The copy states ONLY what is true today. It previously claimed "the supplier
 * will get back to you" and "you can track requests from the Offers page" —
 * both false: nothing notifies the supplier (the lead-digest job is a later
 * PR), and `PromotionLead` has no reader, so there is no tracking view.
 *
 * It is therefore a plain receipt. When the digest and a "My requests" view
 * land, only the VALUE of `ag.offers.leadNotification.*` changes — this
 * plumbing stays put.
 */
async function notifyRequesterOfLead(ctx: RequestContext, company: string) {
    try {
        await runInTenantContext(ctx, async (db) => {
            // Localise for the RECIPIENT (their persisted `uiLanguage`), not the
            // ambient request locale: the row stores literal text, so the
            // language is frozen at write time and must be the reader's.
            const recipient = await db.user.findUnique({
                where: { id: ctx.userId },
                select: { uiLanguage: true },
            });
            const locale = isLocale(recipient?.uiLanguage)
                ? recipient.uiLanguage
                : DEFAULT_LOCALE;
            const [title, message] = await Promise.all([
                translateFor(locale, 'ag.offers.leadNotification.title', { company }),
                translateFor(locale, 'ag.offers.leadNotification.message', { company }),
            ]);
            await db.notification.create({
                data: {
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                    type: 'GENERAL',
                    title,
                    message,
                    linkUrl: ctx.tenantSlug ? `/t/${ctx.tenantSlug}/offers` : null,
                },
            });
        });
    } catch (err) {
        logger.warn('promotions.lead_notify_failed', {
            component: 'promotions',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
