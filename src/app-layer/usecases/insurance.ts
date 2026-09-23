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
import { runInTenantContext } from '@/lib/db-context';
import { conflict } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
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
    locationId?: string | null;
    message: string;
    risk?: { overall?: string; ndvi?: number | null; ndmi?: number | null } | null;
}

/**
 * Capture an insurance quote request for a parcel. Commits the lead first; a
 * P2002 on the @@unique([parcelId, inquirerTenantId]) becomes a friendly
 * conflict (one open request per parcel per tenant). After commit, a
 * best-effort confirmation notification is written for the requester.
 */
export async function createInsuranceLead(ctx: RequestContext, input: CreateInsuranceLeadInput) {
    assertCanWrite(ctx);
    const sanitizedMessage = sanitizePlainText(input.message);

    const lead = await runInTenantContext(ctx, async (db) => {
        let row;
        try {
            row = await db.insuranceLead.create({
                data: {
                    inquirerTenantId: ctx.tenantId,
                    inquirerUserId: ctx.userId,
                    parcelId: input.parcelId,
                    locationId: input.locationId ?? null,
                    message: sanitizedMessage,
                    riskJson: (input.risk ?? undefined) as Prisma.InputJsonValue | undefined,
                },
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                throw conflict('You have already requested a quote for this parcel');
            }
            throw err;
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'InsuranceLead',
            entityId: row.id,
            details: `Insurance quote request for parcel ${input.parcelId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'InsuranceLead',
                operation: 'created',
                after: { parcelId: input.parcelId },
                summary: 'Insurance quote request',
            },
        });
        return row;
    });

    // Best-effort, fail-open — the lead is already committed.
    await notifyRequester(ctx);
    await notifyOperator(ctx, input, sanitizedMessage);
    return lead;
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
                entityId: input.parcelId,
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
