/**
 * Platform-support curation of the global promotions feed (#12).
 *
 * Every function here is gated by `assertPlatformSupport` at the route, which
 * is the practice that matters — an `admin.*` permission is held by the
 * OWNER/ADMIN of every tenant, so only the platform-tenant check stops one
 * farm's owner editing what every other farm sees.
 *
 * These read and write through the caller's tenant transaction. `Promotion` and
 * `Company` carry no RLS (they are global), so the transaction is not doing
 * isolation work — it is what gives `logEvent` a real `tenantId` and `userId`,
 * so the audit chain answers "who published this ad".
 *
 * @module app-layer/usecases/promotion-admin
 */
import type { RequestContext } from '../types';
import { farmTodayFloor, dayKeyInTz, dayKeyToInstant, FARM_TIME_ZONE } from '@/lib/calendar-day-key';
import { readContentPerTenant, readableOrNull } from '@/lib/db/per-tenant-content';
import prisma from '@/lib/prisma';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { findOrCreateCompany } from './company';

/** Derived lifecycle state — no column, just the two gates read together. */
export type PromotionStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED';

export function derivePromotionStatus(
    p: { publishedAt: Date | null; validFrom: Date | null; validTo: Date | null },
    now: Date = new Date(),
): PromotionStatus {
    // DAY TO DAY, on the SAME floor `visibleWhere` uses (#2752).
    //
    // This is the second definition of "the window is open" in the codebase,
    // and the two must agree: this one labels a row in the console, that one
    // decides whether a farm can see it. They were both wrong in the same
    // direction — `validTo < now` with a local-midnight value reports EXPIRED
    // from 00:00 Sofia on the campaign's own last day — so they agreed by
    // accident. Fixing only `visibleWhere` would have made the console say
    // EXPIRED about a promotion the feed was still serving, which is worse
    // than both being wrong, and would have falsified the `status` field's own
    // description in the spec.
    //
    // They cannot share one expression — four states against a boolean — so
    // they share the FLOOR instead, which is the part that was wrong.
    const today = farmTodayFloor(now);
    if (!p.publishedAt) return 'DRAFT';
    if (p.validFrom && p.validFrom > today) return 'SCHEDULED';
    if (p.validTo && p.validTo < today) return 'EXPIRED';
    return 'LIVE';
}

export interface AdminPromotionDto {
    id: string;
    companyId: string;
    companyName: string;
    title: string;
    body: string | null;
    mediaUrl: string | null;
    category: string;
    ctaUrl: string | null;
    /** ЗЗР рег. № when this advertises a ПРЗ, null when it does not (#2664). */
    pppRegistrationNo: string | null;
    publishedAt: string | null;
    /** The campaign window as calendar DAYS, `YYYY-MM-DD`, `validTo` inclusive (#2752). */
    validFrom: string | null;
    validTo: string | null;
    status: PromotionStatus;
    leadCount: number;
}

/**
 * Every promotion, drafts included — the support view, unlike the tenant-facing
 * `listActivePromotions` which shows only what has cleared both gates.
 *
 * `leadCount` rides along because it is the number support is actually working
 * from: it is what tells them whether a campaign is earning its place before
 * the advertiser asks.
 */
export async function listAllPromotions(ctx: RequestContext): Promise<AdminPromotionDto[]> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.promotion.findMany({
            orderBy: { createdAt: 'desc' },
            take: 500,
            include: {
                company: { select: { name: true } },
                _count: { select: { leads: true } },
            },
        });
        const now = new Date();
        return rows.map((p) => ({
            id: p.id,
            companyId: p.companyId,
            companyName: p.company.name,
            title: p.title,
            body: p.body,
            mediaUrl: p.mediaUrl,
            category: p.category,
            ctaUrl: p.ctaUrl,
            pppRegistrationNo: p.pppRegistrationNo,
            publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
            validFrom: p.validFrom ? dayKeyInTz(p.validFrom, FARM_TIME_ZONE) : null,
            validTo: p.validTo ? dayKeyInTz(p.validTo, FARM_TIME_ZONE) : null,
            status: derivePromotionStatus(p, now),
            leadCount: p._count.leads,
        }));
    });
}

export interface PromotionWriteInput {
    /** Either an existing supplier… */
    companyId?: string;
    /** …or a name to find-or-create. Exactly one of the two. */
    companyName?: string;
    title: string;
    body?: string | null;
    category: string;
    ctaUrl?: string | null;
    /**
     * ЗЗР рег. № — set at REVIEW time, never from the leaflet read. See
     * `CreatePromotionSchema` for the Art 66 reasoning.
     */
    pppRegistrationNo?: string | null;
    /** Calendar DAYS, `YYYY-MM-DD` — converted to their labelling instant here (#2752). */
    validFrom?: string | null;
    validTo?: string | null;
}

/**
 * '' and null must not both mean "not a ПРЗ" (#2664).
 *
 * The predicate this field exists for reads `pppRegistrationNo == null`, and
 * `'' == null` is FALSE — so an empty string would be read as "this IS a plant
 * protection product" and withhold a fertiliser from the assistant, with the
 * console showing a blank box either way. Two spellings of one fact is the
 * collapse that produced #2697's second half, in the other direction.
 *
 * Sanitise BEFORE testing emptiness, not after: `sanitizePlainText` trims
 * (#1825), so a value of three spaces is truthy as given and empty once
 * cleaned. Testing the raw value first stores `''`, which is the case this
 * function exists to prevent.
 */
function normalisePppRegistrationNo(v: string | null | undefined): string | null {
    if (v == null) return null;
    const clean = sanitizePlainText(v);
    return clean === '' ? null : clean;
}

function assertWindowOrdered(from: string | null | undefined, to: string | null | undefined) {
    if (from && to && to < from) {
        throw badRequest('The campaign end date must not precede its start date');
    }
}

/**
 * Create a promotion. Always a DRAFT — `publishedAt` stays null until support
 * explicitly publishes, so a half-finished ad typed from an email cannot reach
 * a farmer's feed by accident.
 */
export async function createPromotion(ctx: RequestContext, input: PromotionWriteInput) {
    assertWindowOrdered(input.validFrom, input.validTo);

    return runInTenantContext(ctx, async (db) => {
        const companyId = input.companyId
            ? input.companyId
            : (await findOrCreateCompany(db, ctx, input.companyName ?? '')).id;

        const promotion = await db.promotion.create({
            data: {
                companyId,
                title: sanitizePlainText(input.title),
                body: input.body ? sanitizePlainText(input.body) : null,
                category: input.category,
                ctaUrl: input.ctaUrl ?? null,
                pppRegistrationNo: normalisePppRegistrationNo(input.pppRegistrationNo),
                validFrom: input.validFrom ? dayKeyToInstant(input.validFrom) : null,
                validTo: input.validTo ? dayKeyToInstant(input.validTo) : null,
                publishedAt: null,
            },
            include: { company: { select: { name: true } } },
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Promotion',
            entityId: promotion.id,
            details: `Created promotion draft: ${promotion.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Promotion',
                operation: 'created',
                after: { company: promotion.company.name, title: promotion.title, status: 'DRAFT' },
                summary: `Created promotion draft for ${promotion.company.name}: ${promotion.title}`,
            },
        });
        return promotion;
    });
}

export async function updatePromotion(
    ctx: RequestContext,
    id: string,
    input: Partial<PromotionWriteInput>,
) {
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.promotion.findUnique({ where: { id } });
        if (!existing) {
            // Coded because `PROMOTION_NOT_FOUND` exists (#2725) and a bare
            // `notFound` here would answer the SAME fact in a different shape
            // from the farmer-facing lead route — which is the condition
            // `a-bare-notfound-has-no-coded-twin` (#1712) holds, and it caught
            // this the moment the code was added.
            throw codedNotFound(
                'PROMOTION_NOT_FOUND',
                'No promotion exists under that id.',
                { reference: 'promotionId' },
            );
        }

        // A partial edit may carry only one end of the window; the other has to
        // come from the stored row or an edit could invert it silently.
        //
        // The stored ends are converted to DAY KEYS first (#2752), because that
        // is the unit the incoming ones are in and the unit the comparison
        // means. Comparing a day key against a stored instant would be the
        // day-versus-moment confusion this change exists to remove, one level
        // up — and `assertWindowOrdered` compares strings, so it would have
        // been a type error rather than a silent one. tsc caught exactly this.
        const storedFrom = existing.validFrom ? dayKeyInTz(existing.validFrom, FARM_TIME_ZONE) : null;
        const storedTo = existing.validTo ? dayKeyInTz(existing.validTo, FARM_TIME_ZONE) : null;
        const from = input.validFrom === undefined ? storedFrom : input.validFrom;
        const to = input.validTo === undefined ? storedTo : input.validTo;
        assertWindowOrdered(from, to);

        const companyId =
            input.companyId ??
            (input.companyName
                ? (await findOrCreateCompany(db, ctx, input.companyName)).id
                : undefined);

        const data: Record<string, unknown> = {};
        if (companyId !== undefined) data.companyId = companyId;
        if (input.title !== undefined) data.title = sanitizePlainText(input.title);
        if (input.body !== undefined) {
            data.body = input.body ? sanitizePlainText(input.body) : null;
        }
        if (input.category !== undefined) data.category = input.category;
        if (input.ctaUrl !== undefined) data.ctaUrl = input.ctaUrl;
        if (input.pppRegistrationNo !== undefined) {
            data.pppRegistrationNo = normalisePppRegistrationNo(input.pppRegistrationNo);
        }
        if (input.validFrom !== undefined) {
            data.validFrom = input.validFrom ? dayKeyToInstant(input.validFrom) : null;
        }
        if (input.validTo !== undefined) {
            data.validTo = input.validTo ? dayKeyToInstant(input.validTo) : null;
        }

        const promotion = await db.promotion.update({
            where: { id },
            data,
            include: { company: { select: { name: true } } },
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Promotion',
            entityId: promotion.id,
            details: `Updated promotion: ${promotion.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Promotion',
                operation: 'updated',
                fields: Object.keys(data),
                summary: `Updated promotion for ${promotion.company.name}: ${promotion.title}`,
            },
        });
        return promotion;
    });
}

/**
 * Publish or unpublish. Separate from `updatePromotion` on purpose: this is the
 * moment content becomes visible to every tenant, so it gets its own audited
 * action rather than hiding inside a field diff.
 */
export async function setPromotionPublished(ctx: RequestContext, id: string, published: boolean) {
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.promotion.findUnique({
            where: { id },
            include: { company: { select: { name: true } } },
        });
        if (!existing) {
            // Coded because `PROMOTION_NOT_FOUND` exists (#2725) and a bare
            // `notFound` here would answer the SAME fact in a different shape
            // from the farmer-facing lead route — which is the condition
            // `a-bare-notfound-has-no-coded-twin` (#1712) holds, and it caught
            // this the moment the code was added.
            throw codedNotFound(
                'PROMOTION_NOT_FOUND',
                'No promotion exists under that id.',
                { reference: 'promotionId' },
            );
        }

        if (published && !existing.title.trim()) {
            throw badRequest('A promotion needs a title before it can be published');
        }

        const promotion = await db.promotion.update({
            where: { id },
            data: { publishedAt: published ? (existing.publishedAt ?? new Date()) : null },
            include: { company: { select: { name: true } } },
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Promotion',
            entityId: promotion.id,
            details: `${published ? 'Published' : 'Unpublished'} promotion: ${promotion.title}`,
            detailsJson: {
                // A real transition, which named its destination `operation`
                // instead of `toStatus` (#2109). `operation` belongs to
                // `entity_lifecycle`; the state this moved TO is a status.
                category: 'status_change',
                entityName: 'Promotion',
                toStatus: published ? 'PUBLISHED' : 'UNPUBLISHED',
                after: { publishedAt: promotion.publishedAt?.toISOString() ?? null },
                summary: `${published ? 'Published' : 'Unpublished'} ${promotion.company.name}: ${promotion.title}`,
            },
        });
        return promotion;
    });
}

export async function deletePromotion(ctx: RequestContext, id: string) {
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.promotion.findUnique({
            where: { id },
            include: { company: { select: { name: true } }, _count: { select: { leads: true } } },
        });
        if (!existing) {
            // Coded because `PROMOTION_NOT_FOUND` exists (#2725) and a bare
            // `notFound` here would answer the SAME fact in a different shape
            // from the farmer-facing lead route — which is the condition
            // `a-bare-notfound-has-no-coded-twin` (#1712) holds, and it caught
            // this the moment the code was added.
            throw codedNotFound(
                'PROMOTION_NOT_FOUND',
                'No promotion exists under that id.',
                { reference: 'promotionId' },
            );
        }

        // Leads cascade with the promotion (onDelete: Cascade). Deleting a
        // campaign that captured enquiries would destroy the advertiser's
        // deliverable, so refuse and let support unpublish instead.
        if (existing._count.leads > 0) {
            throw badRequest(
                `This promotion has ${existing._count.leads} captured lead(s). Unpublish it instead of deleting, so the enquiries are preserved.`,
            );
        }

        await db.promotion.delete({ where: { id } });

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'Promotion',
            entityId: id,
            details: `Deleted promotion: ${existing.title}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Promotion',
                operation: 'deleted',
                before: { company: existing.company.name, title: existing.title },
                summary: `Deleted promotion for ${existing.company.name}: ${existing.title}`,
            },
        });
    });
}

export interface AdminCompanyDto {
    id: string;
    name: string;
    eik: string | null;
    websiteUrl: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
    promotionCount: number;
}

/**
 * The supplier list for support. Unlike the tenant-facing feed this DOES expose
 * the decrypted contact fields — that is the point of the console, and the
 * platform-tenant gate is what keeps it internal.
 */

/** One farm's enquiry about a promotion, for «кой е питал» (#2727). */
export interface PromotionLeadDto {
    id: string;
    /** The inquiring FARM's name — a business, not a person. */
    farm: string;
    /** The person who sent it. Personal data; see the usecase docblock. */
    person: string | null;
    /**
     * What the farmer wrote, or NULL when the envelope reached the boundary.
     *
     * Never a `v2:` string: `readableOrNull` refuses to hand an envelope to a
     * reader, because an operator shown ciphertext would copy it to a supplier.
     */
    message: string | null;
    consentedAt: string;
    createdAt: string;
    status: string;
}

/**
 * The farms that asked about one promotion (#2727).
 *
 * ## The metadata read is PRIVILEGED, and the `where` clause IS the control
 *
 * `PromotionLead`'s RLS is symmetric own-tenant on `inquirerTenantId`, so a
 * read under the PLATFORM tenant's context returns zero rows of any other
 * farm's leads — which is every row this surface exists to show. The same
 * inversion `personal-data-export` documents: RLS is normally the backstop,
 * and here a dropped `where` clause would read every promotion's enquiries
 * instead of one's. `promotionId` is that control and there is nothing behind
 * it.
 *
 * ## The MESSAGE cannot be read the same way
 *
 * `PromotionLead.requestMessage` is encrypted under the INQUIRING farm's DEK,
 * not the global KEK — the column's own schema note says a reader outside that
 * tenant must resolve each lead's tenant context. A platform read is by
 * definition outside it, so a naive privileged read returns `v2:` envelopes
 * with no error and no log. That is #2724, where the Art 15 export did exactly
 * this, and this view would have been the third instance of #2723's class.
 *
 * So the message goes through `readContentPerTenant`, which groups by farm and
 * reads each group inside that farm's context. TWO halves are needed and the
 * grouping alone is not the fix: it makes the DEK RESOLVABLE, not resolved, so
 * a farm whose key lookup genuinely fails still yields an envelope.
 * `readableOrNull` is the second half and turns that into a null plus one log
 * line naming the SURFACE — `promotionLeads.list`, not the function — because
 * what the log is for is knowing which screen showed an operator a hole.
 *
 * ## Indexed by id, never by position
 *
 * `readContentPerTenant` returns a FLAT array in FARM order — order of first
 * appearance among the rows handed to it — which is not in general the order of
 * those rows. So the messages are collected into a Map and the original rows
 * mapped through it.
 *
 * HERE that is DEFENSIVE rather than load-bearing, and saying so is the honest
 * version: `@@unique([promotionId, inquirerTenantId])` allows one lead per farm
 * per promotion, so farm order and row order always coincide for this query and
 * a positional join would give the same answer. A mutation to positional
 * reddened nothing, which is how I found that out rather than by reasoning.
 * Kept indexed because the uniqueness is what makes it safe, not the code — and
 * `promotion-leads-decrypt-per-farm` pins that constraint so the day it changes,
 * this stops being a matter of taste.
 *
 * ## What is disclosed, and to whom
 *
 * Platform support only — the same two gates as the rest of the console. The
 * message is shown IN FULL because its entire purpose is to be forwarded to
 * the supplier, and a truncated one would send an operator to the database to
 * do their job. The person's name is personal data and is here because "who
 * asked" is the question; the farm name is a business.
 */
export async function listPromotionLeads(
    ctx: RequestContext,
    promotionId: string,
): Promise<PromotionLeadDto[]> {
    const leads = await prisma.promotionLead.findMany({
        where: { promotionId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
            id: true,
            inquirerTenantId: true,
            consentedAt: true,
            createdAt: true,
            status: true,
            inquirerUserId: true,
        },
    });
    if (leads.length === 0) return [];

    const [tenants, users, messages] = await Promise.all([
        prisma.tenant.findMany({
            where: { id: { in: [...new Set(leads.map((l) => l.inquirerTenantId))] } },
            select: { id: true, name: true },
        }),
        prisma.user.findMany({
            where: { id: { in: [...new Set(leads.map((l) => l.inquirerUserId))] } },
            select: { id: true, name: true },
        }),
        readContentPerTenant(
            leads.map((l) => ({ id: l.id, tenantId: l.inquirerTenantId })),
            (db, ids) =>
                db.promotionLead.findMany({
                    where: { id: { in: ids } },
                    select: { id: true, requestMessage: true },
                }),
        ),
    ]);

    const farmById = new Map(tenants.map((t) => [t.id, t.name]));
    const personById = new Map(users.map((u) => [u.id, u.name]));
    const messageById = new Map(
        messages.map((m) => [m.id, readableOrNull(m.requestMessage, 'promotionLeads.list', m.id)]),
    );

    return leads.map((l) => ({
        id: l.id,
        farm: farmById.get(l.inquirerTenantId) ?? '',
        person: personById.get(l.inquirerUserId) ?? null,
        message: messageById.get(l.id) ?? null,
        consentedAt: l.consentedAt.toISOString(),
        createdAt: l.createdAt.toISOString(),
        status: l.status,
    }));
}

export async function listCompanies(ctx: RequestContext): Promise<AdminCompanyDto[]> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.company.findMany({
            orderBy: { name: 'asc' },
            take: 500,
            include: { _count: { select: { promotions: true } } },
        });
        return rows.map((c) => ({
            id: c.id,
            name: c.name,
            eik: c.eik,
            websiteUrl: c.websiteUrl,
            contactName: c.contactName,
            contactEmail: c.contactEmail,
            contactPhone: c.contactPhone,
            notes: c.notes,
            promotionCount: c._count.promotions,
        }));
    });
}
