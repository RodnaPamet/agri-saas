/**
 * Insurance quote leads ("Ask for offer" on the per-parcel Risk page, #13).
 *
 * Mirrors the #12 promotions-lead flow: the lead commits first, then a
 * best-effort confirmation notification fires (fail-open). Lead-gen only — no
 * insurer API. `InsuranceLead` is not tenant-scoped (`inquirerTenantId` is a
 * plain FK), like `PromotionLead` / `ExchangeInquiry`.
 *
 * @module app-layer/usecases/insurance
 */
import type { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { enqueueEmail } from '../notifications/enqueue';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import { env } from '@/env';
import { logEvent } from '../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { isUniqueViolation } from '@/lib/errors/prisma';
import { codedBadRequest } from '@/lib/errors/types';
import { getProduct, quotePremium } from '@/lib/insurance';
import { logger } from '@/lib/observability/logger';
import { Prisma } from '@prisma/client';

/**
 * Parcel ids this tenant has already requested a quote for.
 *
 * The read half that never existed. `InsuranceLead` had NO reader anywhere in
 * `src/app-layer` — the only queries against it were the retention job's
 * cross-tenant sweep — so the UI had no way to know a request had been sent
 * and fell back to component-local `useState`, which dies on unmount.
 *
 * Returns ids rather than rows: the caller only needs to know WHETHER, the
 * `message` column is free text a farmer wrote, and shipping it to render a
 * disabled button would be handing out more than the question asked for.
 *
 * `@@unique([parcelId, inquirerTenantId])` is the index this rides, so the
 * lookup is covered. Bounded by `take` — a tenant with thousands of open
 * quote requests is not a case worth paging for here; the UI only asks about
 * parcels currently on screen.
 */
export async function listInquiredParcelIds(
    ctx: RequestContext,
    opts: { parcelIds?: readonly string[] } = {},
): Promise<string[]> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.insuranceLead.findMany({
            where: {
                inquirerTenantId: ctx.tenantId,
                ...(opts.parcelIds && opts.parcelIds.length > 0
                    ? { parcelId: { in: [...opts.parcelIds] } }
                    : {}),
            },
            select: { parcelId: true },
            take: 500,
        });
        return rows.map((r) => r.parcelId);
    });
}

export interface CreateInsuranceLeadInput {
    parcelId: string;
    /** Optional only when `quote` is present — the schema's refine enforces it. */
    message?: string;
    locationId?: string | null;
    risk?: { overall?: string; ndvi?: number | null; ndmi?: number | null } | null;
    /**
     * What the farmer chose. Deliberately carries NO price: the server
     * recomputes it, so a client cannot name its own premium.
     */
    quote?: {
        productKey: string;
        areaDca: number;
        sumInsuredCents: number;
        instalments: number;
    };
}

/**
 * Capture an insurance quote request for a parcel.
 *
 * SEVERAL asks per parcel are allowed. The unique on
 * (parcelId, inquirerTenantId) was dropped on 2026-09-24 because the form now
 * collects the farmer's own land size — a figure they may get wrong the first
 * time, and previously could not correct: there is no withdraw and no edit, so
 * a second POST simply 409'd.
 *
 * The operator pays for that in duplicates they must reconcile. It was the
 * owner's call, taken over editing a lead in place, on the grounds that
 * revising a record already actioned is worse than filing a second one.
 *
 * Commits the lead first, then writes two best-effort notifications: a
 * confirmation to the requester and a copy to the platform operator.
 */
/**
 * The stored quote, exactly as the server computed it.
 *
 * A SNAPSHOT: nothing recomputes it on read. A later tariff change must never
 * rewrite what the farmer was shown, which is why `engineVersion` travels with
 * the figures.
 */
export interface InsuranceQuoteSnapshot {
    engineVersion: number;
    productKey: string;
    productKind: 'crop' | 'peril';
    tariffBp: number;
    areaDca: number;
    sumInsuredCents: number;
    premiumCents: number;
    instalmentsCents: number[];
    premiumPerDcaCents: number;
    sumInsuredPerDcaCents: number;
    currencySymbol: string;
    computedAt: string;
}

async function currencySymbolFor(db: PrismaTx, tenantId: string): Promise<string> {
    const row = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { currencySymbol: true },
    });
    return row?.currencySymbol ?? '\u20ac';
}

/**
 * Recompute the premium from the four inputs the client sent.
 *
 * The client's own premium, if it sent one, never reaches here: the schema
 * `.strip()`s it. A refusal is a 400 naming the reason, never a 500 — bad
 * input is the caller's, not ours.
 */
function buildQuoteSnapshot(
    quote: CreateInsuranceLeadInput['quote'],
    currencySymbol: string,
): InsuranceQuoteSnapshot | null {
    if (!quote) return null;
    const product = getProduct(quote.productKey);
    // Coded, not prose: the native clients render the raw error envelope, so
    // an English sentence here reaches a Bulgarian farmer untranslated. The
    // code is what a client can map to its own copy.
    if (!product) {
        throw codedBadRequest('INSURANCE_PRODUCT_UNKNOWN', 'Unknown insurance product.', {
            productKey: quote.productKey,
        });
    }

    const q = quotePremium({
        areaDca: quote.areaDca,
        sumInsuredCents: quote.sumInsuredCents,
        tariffBp: product.tariffBp,
        instalments: quote.instalments,
    });
    if (!q.ok) {
        throw codedBadRequest('INSURANCE_QUOTE_INVALID', 'That quote cannot be calculated.', {
            reason: q.reason,
        });
    }

    return {
        engineVersion: q.engineVersion,
        productKey: product.key,
        productKind: product.kind,
        tariffBp: q.tariffBp,
        areaDca: q.areaDca,
        sumInsuredCents: q.sumInsuredCents,
        premiumCents: q.premiumCents,
        instalmentsCents: q.instalmentsCents,
        premiumPerDcaCents: q.premiumPerDcaCents,
        sumInsuredPerDcaCents: q.sumInsuredPerDcaCents,
        currencySymbol,
        computedAt: new Date().toISOString(),
    };
}

export async function createInsuranceLead(
    ctx: RequestContext,
    input: CreateInsuranceLeadInput,
    idempotencyKey?: string | null,
) {
    try {
        return await createInsuranceLeadImpl(ctx, input, idempotencyKey);
    } catch (err) {
        // Race backstop: two retries of the same ask both clear the replay
        // check, then one loses the unique index. The loser re-reads the
        // winner rather than surfacing a 500 for a lead that WAS recorded.
        if (idempotencyKey && isUniqueViolation(err)) {
            const prior = await runInTenantContext(ctx, (db) =>
                db.insuranceLead.findFirst({
                    where: { inquirerTenantId: ctx.tenantId, clientMutationId: idempotencyKey },
                }),
            );
            if (prior) return prior;
        }
        throw err;
    }
}

async function createInsuranceLeadImpl(
    ctx: RequestContext,
    input: CreateInsuranceLeadInput,
    idempotencyKey?: string | null,
) {
    assertCanWrite(ctx);
    // Stored as '' when the body carries only a quote: the column is NOT NULL
    // and has always held farmer-written text, so a generated summary would put
    // prose the farmer never wrote in front of the operator.
    const sanitizedMessage = sanitizePlainText(input.message ?? '');
    const key = idempotencyKey ?? null;

    const lead = await runInTenantContext(ctx, async (db) => {
        // Replay check. `inquirerTenantId` is the ONLY thing scoping this
        // lookup — InsuranceLead is not tenant-scoped and carries no RLS — so
        // one farm's key can never return another farm's lead.
        if (key) {
            const existing = await db.insuranceLead.findFirst({
                where: { inquirerTenantId: ctx.tenantId, clientMutationId: key },
            });
            // Return it AS IT IS: no second row, no second audit entry, no
            // second notification, and above all no second operator email.
            // The `replayed` flag has to travel OUT of the transaction,
            // because the notification calls sit outside it — returning the
            // row alone would commit nothing and still send a second email.
            if (existing) return { row: existing, replayed: true };
        }

        const quote = buildQuoteSnapshot(input.quote, await currencySymbolFor(db, ctx.tenantId));

        // The P2002 catch is back, for a DIFFERENT reason than the one removed
        // on 2026-09-24. That unique was (parcelId, inquirerTenantId) and
        // capped a farmer to one ask per parcel. This one is
        // (inquirerTenantId, clientMutationId) and exists to make a retry
        // idempotent — so a violation here means two requests raced past the
        // pre-check above, and the right answer is the original row.
        // The unique violation is deliberately NOT caught here. A failed write
        // ABORTS this transaction, so a re-read inside it cannot run — the
        // backstop lives at the top level, in a fresh transaction, exactly as
        // sendExchangeMessage does it.
        const row = await db.insuranceLead.create({
            data: {
                inquirerTenantId: ctx.tenantId,
                inquirerUserId: ctx.userId,
                parcelId: input.parcelId,
                locationId: input.locationId ?? null,
                message: sanitizedMessage,
                riskJson: (input.risk ?? undefined) as Prisma.InputJsonValue | undefined,
                quoteJson: (quote ?? undefined) as Prisma.InputJsonValue | undefined,
                clientMutationId: key,
            },
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'InsuranceLead',
            entityId: row.id,
            details: `Insurance quote request for parcel ${input.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'InsuranceLead',
                operation: 'created',
                after: {
                    parcelId: input.parcelId,
                    // No free text: the product key and the engine version are
                    // what make a stored quote traceable to its rounding rules.
                    ...(quote
                        ? { productKey: quote.productKey, engineVersion: quote.engineVersion }
                        : {}),
                },
                summary: 'Insurance quote request',
            },
        });
        return { row, replayed: false };
    });

    // A replay is finished here: the original lead is returned unchanged and
    // NOTHING else happens — no second notification, no second operator email.
    if (lead.replayed) return lead.row;

    // Best-effort, fail-open — the lead is already committed.
    await notifyRequester(ctx);
    await notifyOperator(
        ctx,
        input,
        sanitizedMessage,
        lead.row.id,
        lead.row.quoteJson as InsuranceQuoteSnapshot | null,
    );
    return lead.row;
}


/**
 * Mail the platform operator that a farmer wants a quote.
 *
 * Fail-open like `notifyRequester`, and for the same reason: the lead row is
 * already committed and cannot be un-asked, so a mail failure must not turn a
 * successful request into an error the farmer sees. It is logged instead.
 *
 * ── Why this is enqueued as `audience: 'platform'` ──
 *
 * The tenant is the SUBJECT of this mail, not its reader. Routing it through
 * the tenant's own notification switch would let a farm silence the operator's
 * copy of their own enquiry — silently, which is the worst property a
 * notification can have.
 *
 * ── Why the locale is written out ──
 *
 * The recipient is an address from configuration with no `User` row behind it,
 * so there is no `uiLanguage` to resolve. The convention is that a producer
 * holding only an email states the locale EXPLICITLY, so the choice appears in
 * the diff rather than hiding in a default.
 *
 * ── Why an unset address is not an error ──
 *
 * `INSURANCE_LEAD_NOTIFY_EMAIL` is optional. With it unset the lead is still
 * recorded and the farmer still gets their confirmation; only the operator's
 * copy is skipped, and the skip is logged. A missing piece of configuration
 * must not cost a farmer their quote request.
 */
async function notifyOperator(
    ctx: RequestContext,
    input: CreateInsuranceLeadInput,
    message: string,
    /**
     * The LEAD id, and not the parcel id, is what this mail is deduped on.
     *
     * `buildDedupeKey` composes `tenant:type:email:entityId:DAY`, so keying on
     * the parcel meant a second ask for the same parcel on the same day
     * produced a row in `InsuranceLead` and NO email — silently, because
     * `enqueueEmail` skips a duplicate dedupeKey without erroring. That was
     * harmless while an ask was once-only per parcel. The moment repeat asks
     * were allowed it became the defect that eats exactly the message the
     * operator needs: the corrected land size, sent the same afternoon as the
     * first one.
     */
    leadId: string,
    /** The STORED snapshot. Never recomputed here — see the payload comment. */
    quoteSnapshot: InsuranceQuoteSnapshot | null,
): Promise<void> {
    const toEmail = env.INSURANCE_LEAD_NOTIFY_EMAIL;
    if (!toEmail) {
        logger.info('insurance.lead_operator_email_unset', {
            component: 'insurance',
            detail: 'INSURANCE_LEAD_NOTIFY_EMAIL is not configured; lead recorded without an operator copy',
        });
        return;
    }

    try {
        await runInTenantContext(ctx, async (db) => {
            const [tenant, parcel] = await Promise.all([
                db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true, slug: true } }),
                db.parcel.findFirst({
                    where: { id: input.parcelId, tenantId: ctx.tenantId },
                    select: { name: true, cropType: true, areaHa: true, location: { select: { name: true } } },
                }),
            ]);

            await enqueueEmail(db, {
                tenantId: ctx.tenantId,
                type: 'INSURANCE_LEAD',
                toEmail,
                audience: 'platform',
                locale: RECIPIENT_FALLBACK_LOCALE,
                entityId: leadId,
                requestId: ctx.requestId,
                payload: {
                    tenantName: tenant?.name ?? ctx.tenantSlug ?? ctx.tenantId,
                    tenantSlug: tenant?.slug ?? ctx.tenantSlug ?? '',
                    parcelName: parcel?.name ?? input.parcelId,
                    locationName: parcel?.location?.name ?? null,
                    cropType: parcel?.cropType ?? null,
                    areaHa: parcel?.areaHa != null ? Number(parcel.areaHa) : null,
                    message,
                    riskOverall: input.risk?.overall ?? null,
                    ndvi: input.risk?.ndvi ?? null,
                    ndmi: input.risk?.ndmi ?? null,
                    // Read from the STORED snapshot, never recomputed here.
                    // The operator has to see what the farmer was shown.
                    quote: quoteSnapshot,
                },
            });
        });
    } catch (err) {
        logger.warn('insurance.lead_operator_notify_failed', {
            component: 'insurance',
            detail: err instanceof Error ? err.message : String(err),
        });
    }
}

async function notifyRequester(ctx: RequestContext) {
    try {
        await runInTenantContext(ctx, async (db) => {
            await db.notification.create({
                data: {
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                    type: 'GENERAL',
                    title: 'Insurance quote request sent',
                    message: 'An insurer will get back to you about this parcel.',
                    linkUrl: ctx.tenantSlug ? `/t/${ctx.tenantSlug}/farm-risk` : null,
                },
            });
        });
    } catch (err) {
        logger.warn('insurance.lead_notify_failed', {
            component: 'insurance',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
