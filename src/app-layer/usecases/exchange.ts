import { RequestContext } from '../types';
import { ExchangeRepository, ListingFilters } from '../repositories/exchange';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext, withTenantDb, PrismaTx } from '@/lib/db-context';
import { forbidden, notFound, badRequest, conflict } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { regionByCode } from '@/lib/geo/bulgaria-regions';
import { logger } from '@/lib/observability/logger';
import { sendInquiryEmail } from '@/lib/email/inquiry-email';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { commodityKeyFor, isCommodityKey } from '@/lib/exchange/commodities';
import {
    Prisma,
    ExchangeSide,
    ExchangeListingStatus,
    ExchangeInquiryStatus,
} from '@prisma/client';

/**
 * Cross-tenant Exchange usecases.
 *
 * The Exchange tables are GLOBAL (no RLS — see prisma/schema/exchange.prisma
 * + repositories/exchange.ts). That makes THIS layer the ONLY thing standing
 * between a tenant and another tenant's rows:
 *   - every browse/read is intentionally global (returns rows across tenants);
 *   - every WRITE re-loads the target listing and asserts
 *     `ctx.tenantId === listing.sellerTenantId` before mutating.
 * Removing that assertion would let any tenant withdraw/fulfil anyone's
 * listing, so treat it as a security invariant, not a nicety.
 */

/** Preserve the undefined/null/string three-state for optional free-text
 *  columns so an untouched value is never overwritten with '' (mirrors the
 *  per-usecase helper used across the codebase). */
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

export interface CreateListingInput {
    side: ExchangeSide;
    commodity: string;
    /** Canonical taxonomy key hint; re-derived server-side when not a known key. */
    commodityKey?: string;
    quantityTonnes: number | string;
    pricePerTonne?: number | string | null;
    priceCurrency?: string;
    /** ISO 3166-2:BG oblast code — regionName/lat/lon are derived from it. */
    regionCode: string;
    description?: string | null;
    sellerDisplayName?: string | null;
    expiresAt?: Date | null;
}

export interface CreateInquiryInput {
    listingId: string;
    message: string;
    quantityTonnes?: number | string | null;
}

// ─── Reads (GLOBAL — cross-tenant by design) ─────────────────────────

/** Browse ACTIVE listings across ALL tenants. */
export async function listActiveListings(ctx: RequestContext, filters: ListingFilters = {}) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => ExchangeRepository.listActiveListings(db, filters));
}

/** Read one listing by id (any tenant's). */
export async function getListing(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listing = await ExchangeRepository.getListing(db, id);
        if (!listing) throw notFound('Listing not found');
        return listing;
    });
}

/** The seller's inbox — inquiries received on this tenant's listings. */
export async function listInquiriesForSeller(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ExchangeRepository.listInquiriesForSeller(db, ctx.tenantId),
    );
}

/** The buyer's outbox — inquiries this tenant has sent. */
export async function listInquiriesByInquirer(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ExchangeRepository.listInquiriesByInquirer(db, ctx.tenantId),
    );
}

// ─── Writes ──────────────────────────────────────────────────────────

/** Publish a new listing owned by the caller's tenant. */
export async function createListing(ctx: RequestContext, input: CreateListingInput) {
    assertCanWrite(ctx);

    // Per-tenant ACTIVE-listing quota — the real spam control, since the
    // EXCHANGE module is available on the FREE plan. Self-hosted mode resolves
    // to ENTERPRISE (unlimited) and short-circuits without a DB count.
    await assertWithinLimit(ctx, 'exchange_listing');

    const region = regionByCode(input.regionCode);
    if (!region) throw badRequest('invalid_region', `Unknown region code: ${input.regionCode}`);

    const commodity = sanitizePlainText(input.commodity);
    // Trust a known canonical key from the client; otherwise derive it from the
    // (localized) free text so "wheat"/"Wheat"/"пшеница" all unify to one key.
    const commodityKey = isCommodityKey(input.commodityKey)
        ? input.commodityKey
        : commodityKeyFor(commodity);

    return runInTenantContext(ctx, async (db) => {
        const listing = await ExchangeRepository.createListing(db, {
            // Ownership is fixed to the caller — a tenant can only ever create
            // its OWN listing.
            sellerTenantId: ctx.tenantId,
            sellerUserId: ctx.userId,
            side: input.side,
            // commodity + description + sellerDisplayName are PUBLIC free text
            // (every tenant reads them) → sanitize before persisting.
            commodity,
            commodityKey,
            quantityTonnes: input.quantityTonnes,
            pricePerTonne: input.pricePerTonne ?? null,
            priceCurrency: input.priceCurrency ?? 'BGN',
            regionCode: region.code,
            regionName: region.nameEn,
            lat: region.lat,
            lon: region.lon,
            description: sanitizeOptional(input.description) ?? null,
            sellerDisplayName: sanitizeOptional(input.sellerDisplayName) ?? null,
            expiresAt: input.expiresAt ?? null,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ExchangeListing',
            entityId: listing.id,
            details: `Created ${listing.side} listing: ${listing.commodity}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeListing',
                operation: 'created',
                after: { side: listing.side, commodity: listing.commodity, regionCode: listing.regionCode },
                summary: `Created ${listing.side} listing: ${listing.commodity}`,
            },
        });

        return listing;
    });
}

/**
 * Load a listing and assert the caller's tenant OWNS it. The cross-tenant
 * write guard — throws notFound if it doesn't exist, forbidden if it belongs
 * to another tenant.
 */
async function loadOwnedListing(db: PrismaTx, ctx: RequestContext, id: string) {
    const listing = await ExchangeRepository.getListing(db, id);
    if (!listing) throw notFound('Listing not found');
    if (listing.sellerTenantId !== ctx.tenantId) {
        throw forbidden('You can only modify your own listings');
    }
    return listing;
}

/** Withdraw one of the caller-tenant's own listings. */
export async function withdrawListing(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listing = await loadOwnedListing(db, ctx, id);
        const updated = await ExchangeRepository.updateListingStatus(
            db, id, ExchangeListingStatus.WITHDRAWN,
        );
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ExchangeListing',
            entityId: id,
            details: `Withdrew listing: ${listing.commodity}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'ExchangeListing',
                fromStatus: listing.status,
                toStatus: ExchangeListingStatus.WITHDRAWN,
                summary: `Withdrew listing: ${listing.commodity}`,
            },
        });
        return updated;
    });
}

/** Mark one of the caller-tenant's own listings as fulfilled. */
export async function fulfillListing(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listing = await loadOwnedListing(db, ctx, id);
        const updated = await ExchangeRepository.updateListingStatus(
            db, id, ExchangeListingStatus.FULFILLED,
        );
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ExchangeListing',
            entityId: id,
            details: `Fulfilled listing: ${listing.commodity}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'ExchangeListing',
                fromStatus: listing.status,
                toStatus: ExchangeListingStatus.FULFILLED,
                summary: `Fulfilled listing: ${listing.commodity}`,
            },
        });
        return updated;
    });
}

/**
 * Send an inquiry against another tenant's ACTIVE listing, then notify +
 * email the seller's admins.
 *
 * The inquiry commits FIRST (inside the inquirer's tenant context). The
 * seller fanout runs AFTER, fail-open: the Notification is written in the
 * SELLER's tenant context (`withTenantDb(sellerTenantId, …)` — Notification
 * is RLS-forced, so it can't be written from the inquirer's context) and the
 * email is best-effort. Email is the ONE channel allowed to cross the tenant
 * boundary. A notification/email failure must NEVER roll back the inquiry.
 */
export async function createInquiry(ctx: RequestContext, input: CreateInquiryInput) {
    assertCanWrite(ctx);
    const sanitizedMessage = sanitizePlainText(input.message);

    const { inquiry, listing } = await runInTenantContext(ctx, async (db) => {
        const listing = await ExchangeRepository.getListing(db, input.listingId);
        if (!listing) throw notFound('Listing not found');
        if (listing.status !== ExchangeListingStatus.ACTIVE) {
            throw badRequest('listing_not_active', 'This listing is no longer active');
        }
        // You cannot inquire on your OWN listing.
        if (listing.sellerTenantId === ctx.tenantId) {
            throw forbidden('You cannot inquire on your own listing');
        }

        let inquiry;
        try {
            inquiry = await ExchangeRepository.createInquiry(db, {
                listingId: listing.id,
                inquirerTenantId: ctx.tenantId,
                inquirerUserId: ctx.userId,
                message: sanitizedMessage,
                quantityTonnes: input.quantityTonnes ?? null,
            });
        } catch (err) {
            // @@unique([listingId, inquirerTenantId]) — a tenant may inquire on
            // a listing at most once. Turn the raw unique violation into a
            // friendly conflict instead of a 500.
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002'
            ) {
                throw conflict('You have already expressed interest in this listing');
            }
            throw err;
        }

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'ExchangeInquiry',
            entityId: inquiry.id,
            details: `Inquiry on listing ${listing.id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeInquiry',
                operation: 'created',
                after: { listingId: listing.id },
                summary: `Inquiry on ${listing.side} listing: ${listing.commodity}`,
            },
        });

        return { inquiry, listing };
    });

    // Best-effort, fail-open — the inquiry is already committed.
    await notifySellerOfInquiry(listing, sanitizedMessage, inquiry.quantityTonnes?.toString() ?? null);

    return inquiry;
}

/**
 * Notify a listing's seller-tenant admins/owners that a new inquiry landed:
 * an in-app Notification (in the SELLER's tenant context) + a best-effort
 * email. Swallows every error (logs) so it can never roll back the inquiry.
 */
async function notifySellerOfInquiry(
    listing: { id: string; sellerTenantId: string; commodity: string; side: string },
    message: string,
    quantityTonnes: string | null,
) {
    try {
        // Everything the seller-side needs — reading the seller's memberships
        // AND writing the Notifications — runs in the SELLER's tenant context
        // (`withTenantDb`). Both `TenantMembership` and `Notification` are
        // RLS-forced, so a context-less read would return zero rows; binding
        // the seller's context is both correct and the only way to write the
        // cross-tenant Notification. Email auto-decrypts via the PII middleware.
        const { admins, inquiriesUrl } = await withTenantDb(
            listing.sellerTenantId,
            async (sellerDb) => {
                const admins = await sellerDb.tenantMembership.findMany({
                    where: {
                        tenantId: listing.sellerTenantId,
                        status: 'ACTIVE',
                        role: { in: ['OWNER', 'ADMIN'] },
                    },
                    select: {
                        userId: true,
                        user: { select: { email: true } },
                        tenant: { select: { slug: true } },
                    },
                    // Bounded fanout — a listing's seller has a handful of
                    // admins/owners, not thousands. 25 is a generous ceiling
                    // that caps both the notification write and the email blast.
                    take: 25,
                });
                if (admins.length === 0) return { admins, inquiriesUrl: '' };

                // Deep link straight to THIS listing's card on the seller's
                // management page (native #anchor scroll) so the seller lands on
                // the row they can Accept/Decline — not the top of the list.
                const inquiriesUrl = `/t/${admins[0].tenant.slug}/exchange/my-listings#listing-${listing.id}`;

                // In-app Notification for each seller admin/owner.
                await sellerDb.notification.createMany({
                    data: admins.map((a) => ({
                        tenantId: listing.sellerTenantId,
                        userId: a.userId,
                        type: 'GENERAL' as const,
                        title: `New interest in your ${listing.commodity} listing`,
                        message,
                        linkUrl: inquiriesUrl,
                    })),
                    skipDuplicates: true,
                });
                return { admins, inquiriesUrl };
            },
        );
        if (admins.length === 0) return;

        // Email each admin — the one cross-tenant channel. Done AFTER the
        // seller-context block so no DB transaction is held open over network.
        // Dedupe by email (a user can hold multiple admin memberships) and send
        // with Promise.allSettled so one slow/failing SMTP call neither
        // serializes nor aborts the rest. Still fail-open.
        const recipients = [
            ...new Set(admins.map((a) => a.user.email).filter((e): e is string => !!e)),
        ];
        await Promise.allSettled(
            recipients.map((to) =>
                sendInquiryEmail({
                    to,
                    commodity: listing.commodity,
                    side: listing.side,
                    message,
                    quantityTonnes,
                    inquiriesUrl,
                }),
            ),
        );
    } catch (err) {
        logger.warn('exchange.inquiry_notify_failed', {
            component: 'exchange',
            listingId: listing.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Seller responds to an inquiry on one of THEIR listings (ACCEPT / DECLINE).
 * Only the listing's seller tenant may respond; the inquiry must be PENDING.
 */
export async function respondToInquiry(
    ctx: RequestContext,
    inquiryId: string,
    action: 'ACCEPTED' | 'DECLINED',
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const inquiry = await ExchangeRepository.getInquiry(db, inquiryId);
        if (!inquiry) throw notFound('Inquiry not found');
        // Only the SELLER (owner of the inquiry's listing) may respond.
        if (inquiry.listing.sellerTenantId !== ctx.tenantId) {
            throw forbidden('You can only respond to inquiries on your own listings');
        }
        if (inquiry.status !== ExchangeInquiryStatus.PENDING) {
            throw badRequest('inquiry_not_pending', 'This inquiry has already been answered');
        }

        const updated = await ExchangeRepository.updateInquiryStatus(
            db, inquiryId, action as ExchangeInquiryStatus,
        );
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ExchangeInquiry',
            entityId: inquiryId,
            details: `Inquiry ${action.toLowerCase()}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'ExchangeInquiry',
                fromStatus: inquiry.status,
                toStatus: action,
                summary: `Inquiry ${action.toLowerCase()} on ${inquiry.listing.commodity}`,
            },
        });
        return updated;
    });
}

/** The caller-tenant's own listings (any status) + their inquiries. */
export async function listMyListings(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ExchangeRepository.listListingsBySeller(db, ctx.tenantId),
    );
}
