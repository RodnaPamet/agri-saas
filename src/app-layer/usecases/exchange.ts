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
import {
    Prisma,
    ExchangeSide,
    ExchangeKind,
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
    kind: ExchangeKind;
    commodity: string;
    quantityTonnes: number | string;
    pricePerTonne?: number | string | null;
    priceCurrency?: string;
    /** ISO 3166-2:BG oblast code — regionName/lat/lon are derived from it. */
    regionCode: string;
    description?: string | null;
    sellerDisplayName?: string | null;
    sellerContact?: string | null;
    expiresAt?: Date | null;
}

export interface CreateInquiryInput {
    listingId: string;
    message: string;
    inquirerContact?: string | null;
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

    return runInTenantContext(ctx, async (db) => {
        const listing = await ExchangeRepository.createListing(db, {
            // Ownership is fixed to the caller — a tenant can only ever create
            // its OWN listing.
            sellerTenantId: ctx.tenantId,
            sellerUserId: ctx.userId,
            side: input.side,
            kind: input.kind,
            // commodity + description + sellerDisplayName are PUBLIC free text
            // (every tenant reads them) → sanitize before persisting.
            commodity: sanitizePlainText(input.commodity),
            quantityTonnes: input.quantityTonnes,
            pricePerTonne: input.pricePerTonne ?? null,
            priceCurrency: input.priceCurrency ?? 'BGN',
            regionCode: region.code,
            regionName: region.nameEn,
            lat: region.lat,
            lon: region.lon,
            description: sanitizeOptional(input.description) ?? null,
            sellerDisplayName: sanitizeOptional(input.sellerDisplayName) ?? null,
            // Sanitised like the public fields even though it is never public:
            // it is rendered to the counterparty after a deal, and a value that
            // only one person ever sees is still a value someone typed.
            sellerContact: sanitizeOptional(input.sellerContact) ?? null,
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
                after: { side: listing.side, kind: listing.kind, commodity: listing.commodity, regionCode: listing.regionCode },
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
/**
 * The listing state machine.
 *
 * ACTIVE and EXPIRED are the only states a seller can still act on. FULFILLED
 * and WITHDRAWN are TERMINAL: a listing that has been sold or taken down does
 * not come back, and without this both were reachable in a loop
 * (FULFILLED → WITHDRAWN → FULFILLED), while an EXPIRED listing could be
 * marked FULFILLED months later.
 *
 * EXPIRED → WITHDRAWN is allowed on purpose: tidying up a lapsed listing is
 * housekeeping, not a claim about a sale. EXPIRED → FULFILLED is not, because
 * it asserts a transaction the marketplace has no evidence for and would
 * silently feed the "sold" statistics.
 *
 * `respondToInquiry` already enforced its own PENDING precondition; these two
 * were the ones with no guard at all.
 */
const TERMINAL_LISTING_STATUSES: readonly ExchangeListingStatus[] = [
    ExchangeListingStatus.FULFILLED,
    ExchangeListingStatus.WITHDRAWN,
];

function assertListingTransition(
    from: ExchangeListingStatus,
    to: ExchangeListingStatus,
    commodity: string,
) {
    if (TERMINAL_LISTING_STATUSES.includes(from)) {
        throw badRequest(
            'listing_terminal',
            `"${commodity}" is already ${from.toLowerCase()} and cannot be changed`,
        );
    }
    if (to === ExchangeListingStatus.FULFILLED && from !== ExchangeListingStatus.ACTIVE) {
        throw badRequest(
            'listing_not_active',
            `"${commodity}" has expired — withdraw it instead of marking it fulfilled`,
        );
    }
}

export async function withdrawListing(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listing = await loadOwnedListing(db, ctx, id);
        assertListingTransition(
            listing.status as ExchangeListingStatus,
            ExchangeListingStatus.WITHDRAWN,
            listing.commodity,
        );
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
        assertListingTransition(
            listing.status as ExchangeListingStatus,
            ExchangeListingStatus.FULFILLED,
            listing.commodity,
        );
        const updated = await ExchangeRepository.updateListingStatus(
            db, id, ExchangeListingStatus.FULFILLED,
        );
        // Close out the inquiries this listing strands.
        //
        // Fulfilling used to leave every PENDING inquiry pending forever — the
        // confirm dialog admitted as much rather than fixing it — so buyers
        // waited on an answer that could no longer come. They are declined
        // here, which is the truthful outcome: the goods went elsewhere.
        //
        // No contact is revealed (`contactSharedAt` stays null, and the CHECK
        // constraint would refuse it anyway), and each buyer is notified, so a
        // decline arrives as information rather than silence.
        const stranded = await ExchangeRepository.declinePendingInquiries(db, id);
        for (const s of stranded) {
            await notifyBuyerOfResponse(listing, s.inquirerTenantId, 'DECLINED', null);
        }
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
                inquirerContact: sanitizePlainText(input.inquirerContact ?? '') || null,
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
        // A listing that has left ACTIVE can no longer be transacted, so
        // accepting on it would reveal contacts for a deal that cannot happen.
        // Declining stays allowed: a seller who fulfils elsewhere should still
        // be able to close out the inquiries they left hanging.
        if (
            action === 'ACCEPTED' &&
            inquiry.listing.status !== ExchangeListingStatus.ACTIVE
        ) {
            throw badRequest(
                'listing_not_active',
                'This listing is no longer active — you can decline, but not accept',
            );
        }

        const updated = await ExchangeRepository.updateInquiryStatus(
            db,
            inquiryId,
            action as ExchangeInquiryStatus,
            // The consent stamp is written in the SAME update as the status, so
            // there is no window where an inquiry is ACCEPTED but not yet
            // shared (or the reverse). The DB CHECK constraint refuses the
            // inconsistent pair outright.
            action === 'ACCEPTED' ? new Date() : null,
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
        return { updated, inquiry };
    }).then(async ({ updated, inquiry }) => {
        // Best-effort, fail-open, OUTSIDE the transaction — the response is
        // already committed, exactly as createInquiry treats the seller's.
        await notifyBuyerOfResponse(
            inquiry.listing,
            inquiry.inquirerTenantId,
            action,
            action === 'ACCEPTED' ? inquiry.listing.sellerContact ?? null : null,
        );
        return updated;
    });
}

/**
 * Tell the BUYER their inquiry was answered — on accept AND on decline.
 *
 * Before this, `respondToInquiry` flipped a status and returned. The buyer's
 * only signal was a badge on a page they had to remember to revisit, which for
 * a decline meant waiting indefinitely for an answer that had already been
 * given. A decline is information: it frees the buyer to go elsewhere.
 *
 * Mirrors `notifySellerOfInquiry` — same bounded fanout, same withTenantDb
 * shape, same swallow-everything contract so a mailer outage can never undo a
 * committed response.
 */
async function notifyBuyerOfResponse(
    listing: { id: string; commodity: string; side: string },
    buyerTenantId: string,
    action: 'ACCEPTED' | 'DECLINED',
    sellerContact: string | null,
) {
    try {
        await withTenantDb(buyerTenantId, async (buyerDb) => {
            const admins = await buyerDb.tenantMembership.findMany({
                where: {
                    tenantId: buyerTenantId,
                    status: 'ACTIVE',
                    role: { in: ['OWNER', 'ADMIN'] },
                },
                select: { userId: true, tenant: { select: { slug: true } } },
                take: 25,
            });
            if (admins.length === 0) return;

            // Deep-link to the buyer's own interests page, anchored on the
            // inquiry — the same "land on the row you can act on" rule the
            // seller-side link follows.
            const interestsUrl = `/t/${admins[0].tenant.slug}/exchange/my-interests#listing-${listing.id}`;

            const accepted = action === 'ACCEPTED';
            await buyerDb.notification.createMany({
                data: admins.map((a) => ({
                    tenantId: buyerTenantId,
                    userId: a.userId,
                    type: 'GENERAL' as const,
                    title: accepted
                        ? `Your interest in ${listing.commodity} was accepted`
                        : `Your interest in ${listing.commodity} was declined`,
                    // The contact goes in the notification body on accept so the
                    // buyer can act without a round trip. It is only ever
                    // reached when `contactSharedAt` was just written, and the
                    // notification lives in the BUYER's tenant — no third party
                    // can read it.
                    message: accepted
                        ? sellerContact
                            ? `The seller accepted. Contact them on ${sellerContact}.`
                            : 'The seller accepted. Open the listing to see their contact.'
                        : 'The seller declined this time. Your other interests are unaffected.',
                    linkUrl: interestsUrl,
                })),
                skipDuplicates: true,
            });
        });
    } catch (err) {
        logger.warn('exchange.response_notify_failed', {
            component: 'exchange',
            action,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** The caller-tenant's own listings (any status) + their inquiries. */
export async function listMyListings(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ExchangeRepository.listListingsBySeller(db, ctx.tenantId),
    );
}
