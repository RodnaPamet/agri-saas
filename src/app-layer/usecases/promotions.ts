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
import { codedConflict, codedNotFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { translateFor } from '@/lib/i18n/server-messages';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { dayKeyInTz, FARM_TIME_ZONE } from '@/lib/calendar-day-key';
import { Prisma } from '@prisma/client';

export interface PromotionDto {
    id: string;
    company: string;
    title: string;
    body: string | null;
    mediaUrl: string | null;
    category: string;
    ctaUrl: string | null;
    /**
     * The campaign window as CALENDAR DAYS, `YYYY-MM-DD`, with `validTo`
     * INCLUSIVE — not instants (#2725, agrent-ios' ask).
     *
     * A campaign's window is a pair of days in the operator's head, and the
     * columns are `DateTime` only because that is what the picker writes. An
     * instant on the wire makes every client decide which day it means, and
     * they will not all agree.
     *
     * ## It is `dayKeyInTz`, and `toISOString().slice(0, 10)` is WRONG here
     *
     * The console's `DatePicker` writes LOCAL midnight, so «2 Nov» stored from
     * Sofia is `2026-11-01T22:00:00Z` — and the naive UTC slice yields
     * `2026-11-01`, a day earlier than the web itself displays. Measured.
     *
     * The web is correct today because `formatDate` renders through
     * `DISPLAY_TIME_ZONE` (= `FARM_TIME_ZONE`), so the day-key has to be taken
     * in that same zone to agree with it. That is also why the five
     * `toISOString().slice(0, 10)` sites elsewhere in this repo are not a
     * precedent to copy: they build digest keys and idempotency keys, where UTC
     * is the intended frame and nobody reads the value as a date.
     */
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
            validFrom: p.validFrom ? dayKeyInTz(p.validFrom, FARM_TIME_ZONE) : null,
            validTo: p.validTo ? dayKeyInTz(p.validTo, FARM_TIME_ZONE) : null,
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
/**
 * One current promotion as the ASSISTANT sees it — no disclosure strings.
 *
 * NO `price`, and that is a schema fact rather than an omission (#2665).
 * `Promotion` has no price column: its fields are `title`, `body`,
 * `category`, `pppRegistrationNo`, `ctaUrl` and the two dates. #2664's field
 * request named "company, product, price, end date", and a price would have to
 * be a new column populated at review time — the figure currently lives inside
 * the free-text `body` that the owner reviewed.
 *
 * So `details` carries that reviewed free text and is NOT labelled a price.
 * Returning a `price` read out of prose would be a number the client renders
 * as fact and nobody verified, which is the same defect class as a
 * paraphrased safety phrase: it would look authoritative.
 */
export interface AssistantPromotion {
    id: string;
    company: string;
    product: string;
    /** The reviewed free text. May mention a price; is not a price FIELD. */
    details: string | null;
    validTo: string | null;
}

/**
 * Current promotions for the assistant's `list_promotions` tool — #2665.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  THE `where` CLAUSE IS THE ENTIRE CONTROL HERE. There is no RLS behind it.
 * ════════════════════════════════════════════════════════════════════════
 *
 * `Promotion` is a PLATFORM-wide catalogue with no `tenantId`, so unlike every
 * other read the assistant performs there is no tenant-isolation policy acting
 * as a backstop — `runTool`'s `assertCanRead` answers "may this person read at
 * all", and `assertModuleEnabled` has no per-tenant module to match. A dropped
 * condition here is not caught one layer down. It is the inverted arrangement
 * `/api/account/export` carries a comment about, for the same reason.
 *
 * THREE conditions, and the third is the one a reader will not expect:
 *
 * 1. `publishedAt IS NOT NULL` — via the shared `visibleWhere`. The owner's
 *    review of an AI read of a supplier leaflet is the whole safeguard in
 *    #2664, and a tool that quoted an unreviewed row would silently undo it.
 * 2. `validTo` in the future or unset — also `visibleWhere`. "Expired ones are
 *    never used" is the owner's wording. Unset is not expired.
 * 3. **A ПРЗ is withheld while its safety wording is unconfigured.** Reg. (EC)
 *    1107/2009 Art 66 puts prescribed wording on plant protection advertising,
 *    and `promotionDisclosures` refuses to return a row it cannot disclose. If
 *    this tool returned such a promotion anyway, the model would have a product
 *    to talk about and the client would have nothing to render beside it — an
 *    advert with no disclosure, reached by omission. Fail CLOSED: a missing
 *    value costs a feature, not a breach.
 *
 * Condition 3 is why this is NOT `listActivePromotions`. The public promotions
 * PAGE shows ПРЗ rows and renders their own disclosure; the assistant cannot,
 * because its disclosure travels on a separate frame. Two surfaces, one
 * visibility predicate shared, one extra condition where the surfaces differ —
 * stated here so the next reader does not "unify" them.
 */
export async function listPromotionsForAssistant(
    ctx: RequestContext,
    opts: { product?: string; limit?: number; now?: Date } = {},
): Promise<{ rows: AssistantPromotion[]; hasMore: boolean }> {
    assertCanRead(ctx);
    // FIVE by default (owner framing: "mention a current promotion", singular;
    // a block listing more than about three stops reading as a disclosure and
    // starts reading as an advert). Over-read by one to answer `hasMore`
    // without a second COUNT.
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const now = opts.now ?? new Date();
    const { isPppDisclosureConfigured } = await import('./promotion-disclosure');
    const pppAllowed = isPppDisclosureConfigured();
    const product = opts.product?.trim();

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.promotion.findMany({
            where: {
                AND: [
                    visibleWhere(now),
                    // Condition 3. An env-configured single string, so this
                    // collapses to "exclude every ПРЗ" rather than a per-row
                    // join — and it is expressed as a `where` rather than a
                    // post-filter so the `take` below cannot silently return
                    // fewer rows than it claims.
                    ...(pppAllowed ? [] : [{ pppRegistrationNo: null }]),
                    // A LEXICAL narrowing, offered because the model may know
                    // the product name. Deliberately not the relevance
                    // decision: the model is better at that than a `contains`,
                    // so an empty narrowed result means "ask again without a
                    // product", which the tool description says.
                    ...(product
                        ? [
                              {
                                  OR: [
                                      { title: { contains: product, mode: 'insensitive' as const } },
                                      { body: { contains: product, mode: 'insensitive' as const } },
                                      { category: { contains: product, mode: 'insensitive' as const } },
                                  ],
                              },
                          ]
                        : []),
                ],
            },
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            include: { company: { select: { name: true } } },
        });

        const page = rows.slice(0, limit);
        return {
            rows: page.map((p) => ({
                id: p.id,
                company: p.company.name,
                product: p.title,
                details: p.body ?? null,
                validTo: p.validTo ? p.validTo.toISOString() : null,
            })),
            hasMore: rows.length > limit,
        };
    });
}

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
        if (!promotion) {
            throw codedNotFound(
                'PROMOTION_NOT_FOUND',
                'No promotion exists under that id.',
                { reference: 'promotionId' },
            );
        }

        // THE SAME PREDICATE THE FEED USES, and the comment that stood here
        // claimed a property the code did not have (#2725). It read "a draft or
        // EXPIRED promotion must not accept leads" and then tested
        // `publishedAt` alone — while `visibleWhere` tests three things:
        // published, started, and not finished. So an expired campaign was off
        // the feed and still accepting leads, and a farmer could be told their
        // request had gone to a supplier about an offer that ended last month.
        //
        // Applied by the DATABASE rather than restated as a row predicate, so
        // there is exactly one definition of "visible". `visibleWhere` already
        // carries that reasoning for `hasVisiblePromotions` — "two copies of
        // visible is how a nav link outlives the content it points at" — and a
        // hand-written `p.validTo && p.validTo < now` here would be the second
        // copy. Costs one indexed lookup by primary key.
        //
        // Evaluated at `consentedAt`, not at a fresh `new Date()`: that is the
        // instant the person agreed to send this, which is the right frame for
        // "was the offer live when they consented" and removes a race between
        // the two reads.
        const stillVisible = await db.promotion.findFirst({
            where: { AND: [{ id: promotion.id }, visibleWhere(consentedAt)] },
            select: { id: true },
        });
        if (!stillVisible) {
            // A DISTINCT code from the genuine not-found, deliberately. The
            // old collapse had a written reason — "the card is gone from the
            // feed, so a request against it can only come from a stale page" —
            // which is about WHO is calling, not about concealing existence.
            // And it could not be about concealment: `Promotion` is one GLOBAL
            // catalogue, so every tenant sees the same published set and there
            // is nothing tenant-private to enumerate. So telling a farmer
            // "this offer has ended" rather than "no such offer" leaks nothing
            // and is the only one of the two that is true.
            //
            // It matters more after #2725 than before: `/offers` is now on
            // `PERSISTABLE_PATHS`, so a phone holds the feed across launches
            // and a stale card is the expected case rather than an odd one.
            throw codedNotFound(
                'PROMOTION_NOT_AVAILABLE',
                // NOT "no longer running": that asserts it WAS running, which is
                // false for a campaign whose `validFrom` has not arrived — one of
                // the three states this single code covers. agrent-ios ruled on
                // the wording rather than taking a fourth code, 2026-11-05.
                'That offer is not currently running.',
                { reference: 'promotionId' },
            );
        }

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
                // Coded for the same reason as the exchange inquiry — see
                // `createInquiry` in exchange.ts (#1391).
                throw codedConflict(
                    'PROMOTION_LEAD_ALREADY_SENT',
                    'You have already requested an offer for this promotion.',
                );
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
