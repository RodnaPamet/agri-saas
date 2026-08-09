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
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { findOrCreateCompany } from './company';

/** Derived lifecycle state — no column, just the two gates read together. */
export type PromotionStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED';

export function derivePromotionStatus(
    p: { publishedAt: Date | null; validFrom: Date | null; validTo: Date | null },
    now: Date = new Date(),
): PromotionStatus {
    if (!p.publishedAt) return 'DRAFT';
    if (p.validFrom && p.validFrom > now) return 'SCHEDULED';
    if (p.validTo && p.validTo < now) return 'EXPIRED';
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
    publishedAt: string | null;
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
            publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
            validFrom: p.validFrom ? p.validFrom.toISOString() : null,
            validTo: p.validTo ? p.validTo.toISOString() : null,
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
    validFrom?: Date | null;
    validTo?: Date | null;
}

function assertWindowOrdered(from: Date | null | undefined, to: Date | null | undefined) {
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
                validFrom: input.validFrom ?? null,
                validTo: input.validTo ?? null,
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
        if (!existing) throw notFound('Promotion not found');

        // A partial edit may carry only one end of the window; the other has to
        // come from the stored row or an edit could invert it silently.
        const from = input.validFrom === undefined ? existing.validFrom : input.validFrom;
        const to = input.validTo === undefined ? existing.validTo : input.validTo;
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
        if (input.validFrom !== undefined) data.validFrom = input.validFrom;
        if (input.validTo !== undefined) data.validTo = input.validTo;

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
        if (!existing) throw notFound('Promotion not found');

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
                category: 'status_change',
                entityName: 'Promotion',
                operation: published ? 'published' : 'unpublished',
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
        if (!existing) throw notFound('Promotion not found');

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
