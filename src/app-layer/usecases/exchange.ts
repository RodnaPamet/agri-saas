import { RequestContext } from '../types';
import {
    ExchangeRepository,
    type ListingFilters,
    type ListingPageParams,
} from '../repositories/exchange';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext, withTenantDb, PrismaTx } from '@/lib/db-context';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { EXCHANGE_CURRENCY } from '@/lib/exchange/currency';
import { codedBadRequest, codedConflict, codedForbidden, codedNotFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { regionByCode } from '@/lib/geo/bulgaria-regions';
import { logger } from '@/lib/observability/logger';
import { publishListingChange } from '@/lib/realtime/listing-broadcast';
import { sendInquiryEmail } from '@/lib/email/inquiry-email';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { assertNotPastDueRestricted } from '@/lib/billing/entitlements';
import { isLocale } from '@/lib/i18n/locales';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import type { UpdateListingBody } from '@/app-layer/schemas/exchange.schemas';
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
    // No `priceCurrency`: the marketplace is euro-denominated and a new
    // listing has no say in the matter (see @/lib/exchange/currency). The
    // create schema already refuses anything but EUR; leaving a parameter
    // here would imply a choice the product does not offer.
    /** ISO 3166-2:BG oblast code — regionName/lat/lon are derived from it. */
    regionCode: string;
    description?: string | null;
    sellerDisplayName?: string | null;
    /** Attribute this listing to the seller's published farm (P6.7, #1816). */
    publishAsFarm?: boolean;
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

/**
 * Seller tenants whose listings must NOT appear in the marketplace: the ones
 * that switched the EXCHANGE module OFF.
 *
 * The browse query had no seller-side module check at all, so disabling the
 * module hid the marketplace from the tenant while leaving that tenant's own
 * offers public and — because the withdraw endpoint gated on the caller's
 * module — un-withdrawable. Every listing they had ever posted stayed on the
 * map, fielding inquiries they could no longer answer.
 *
 * Read RLS-FREE (`runWithoutRls`, reason `module-availability`), because `TenantModuleSettings` is
 * tenant-scoped: under the viewer's own context this would see at most the
 * viewer's row and the exclusion would silently do nothing. It selects
 * tenant IDS only.
 *
 * The PLAN half of module availability is deliberately not consulted:
 * EXCHANGE is `FREE`-tier for every plan (it is a network-effect product), so
 * the per-tenant toggle is the only thing that can turn it off.
 */
async function sellerTenantsWithExchangeOff(): Promise<string[]> {
    return runWithoutRls({ reason: 'module-availability' }, (db) =>
        ExchangeRepository.listTenantIdsWithModuleDisabled(db, 'EXCHANGE'),
    );
}

/**
 * Which of these seller tenants are PUBLISHED farms — P6.7 (#1816).
 *
 * Read RLS-FREE (`runWithoutRls`, reason `exchange-farm-attribution`) for the
 * same reason `sellerTenantsWithExchangeOff` above is: `FarmBrand` is
 * tenant-scoped, so under the viewer's own context this would see at most the
 * viewer's own brand and every OTHER farm's listing would silently fall back
 * to anonymous — a feature that works only for whoever is testing it.
 *
 * Resolved LIVE on every read rather than copied onto the listing when the
 * seller ticked the box. That is the owner's ruling and it is the safer shape:
 * a farm that renames its handle or withdraws its page changes every listing
 * it had attributed in the same moment, where a snapshot would leave listings
 * naming an address that stopped answering.
 */
async function farmAttributionFor(
    sellerTenantIds: readonly string[],
): Promise<Map<string, { handle: string; displayName: string }>> {
    const ids = [...new Set(sellerTenantIds)];
    if (ids.length === 0) return new Map();
    const rows = await runWithoutRls({ reason: 'exchange-farm-attribution' }, (db) =>
        ExchangeRepository.listPublishedFarmBrands(db, ids),
    );
    return new Map(rows.map((r) => [r.tenantId, { handle: r.handle, displayName: r.displayName }]));
}

/**
 * Attach each listing's farm attribution, or `null` when there is none.
 *
 * `null` rather than `undefined`, and the distinction is load-bearing:
 * `toPublicListing` treats an ABSENT `farm` as "nobody resolved this" and a
 * null one as "resolved, and this seller is not a published farm". Both fall
 * back to the typed name, but only one of them is a bug — see that function.
 */
async function withFarmAttribution<T extends { sellerTenantId: string }>(
    rows: T[],
): Promise<Array<T & { farm: { handle: string; displayName: string } | null }>> {
    const byTenant = await farmAttributionFor(rows.map((r) => r.sellerTenantId));
    return rows.map((r) => ({ ...r, farm: byTenant.get(r.sellerTenantId) ?? null }));
}

/**
 * Browse ACTIVE listings across ALL tenants — server-side facets + one
 * cursor page. Returns `{ rows, nextCursor }`.
 */
export async function listActiveListings(
    ctx: RequestContext,
    filters: ListingFilters = {},
    page: ListingPageParams = {},
) {
    assertCanRead(ctx);
    // Their own view of the market closes. Note what this does NOT do: every
    // other farm keeps seeing this tenant's ACTIVE listings and can still
    // contact them, and inbound threads keep working — the owner chose that
    // scope so a payment problem never breaks a live negotiation with a
    // PAYING buyer, and so nothing has to be restored when they pay.
    await assertNotPastDueRestricted(ctx, 'exchange');
    const excludeSellerTenantIds = await sellerTenantsWithExchangeOff();
    const { rows, nextCursor } = await runInTenantContext(ctx, (db) =>
        ExchangeRepository.listActiveListings(
            db,
            { ...filters, excludeSellerTenantIds },
            page,
        ),
    );
    // Attribution is resolved for THIS page's sellers only — one extra query
    // per page, bounded by the page size, and never an unfiltered read.
    return { rows: await withFarmAttribution(rows), nextCursor };
}

/** Read one listing by id (any tenant's). */
export async function getListing(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const listing = await runInTenantContext(ctx, async (db) => {
        const row = await ExchangeRepository.getListing(db, id);
        if (!row) throw codedNotFound('LISTING_NOT_FOUND', 'Listing not found');
        return row;
    });
    // The deep-link path has to honour the same seller-module exclusion the
    // feed does, or a shared link would resurrect a listing the marketplace
    // has hidden. The OWNER is exempt: they must still be able to open and
    // withdraw their own row, which is the whole point of the exemption on
    // the withdraw path.
    if (listing.sellerTenantId !== ctx.tenantId) {
        // #1655 — and this is the same argument the paragraph above makes, one
        // cause later: the browse feed now withholds a listing whose seller
        // asked to delete their account, so a deep link must withhold it too
        // or the hiding is defeated by sharing a URL. The OWNER exemption is
        // the enclosing `if`, unchanged and for the same reason — they can
        // still sign in to cancel, and must be able to see what they are
        // recovering.
        //
        // `notFound`, deliberately the SAME refusal a genuinely missing
        // listing gets. A distinct code would tell a stranger that this
        // person's account is being deleted, which is their business and
        // nobody else's — P5.2b's silence, applied to a different cause.
        // ONE throw for both causes, and the suppression is checked first so a
        // hidden listing short-circuits the module-exclusion query. Merged
        // rather than added beside it because `no-server-authored-user-copy`
        // holds English prose in thrown errors on a downward ratchet — a second
        // `codedNotFound('LISTING_NOT_FOUND', 'Listing not found')` raises the count for a sentence that
        // already exists one line below.
        const hidden = listing.suppressedForDeletionAt
            ? true
            : (await sellerTenantsWithExchangeOff()).includes(listing.sellerTenantId);
        if (hidden) throw codedNotFound('LISTING_NOT_FOUND', 'Listing not found');
    }
    // A deep link shows the same seller identity the feed does. Resolved here
    // rather than in the route, so every surface that can display a listing
    // gets attribution from ONE place and none of them can disagree.
    return (await withFarmAttribution([listing]))[0];
}

/** The buyer's outbox — inquiries this tenant has sent. */
export async function listInquiriesByInquirer(ctx: RequestContext) {
    assertCanRead(ctx);
    const rows = await runInTenantContext(ctx, (db) =>
        ExchangeRepository.listInquiriesByInquirer(db, ctx.tenantId),
    );
    // These rows carry the NESTED listing a buyer enquired about, and that
    // listing belongs to another tenant — so this is a cross-tenant surface
    // like the feed, not an own-tenant one like `listMyListings`.
    const byTenant = await farmAttributionFor(rows.map((r) => r.listing.sellerTenantId));
    return rows.map((r) => ({
        ...r,
        listing: { ...r.listing, farm: byTenant.get(r.listing.sellerTenantId) ?? null },
    }));
}

// ─── Writes ──────────────────────────────────────────────────────────

/** Publish a new listing owned by the caller's tenant. */
async function createListingRow(ctx: RequestContext, input: CreateListingInput) {
    assertCanWrite(ctx);

    const region = regionByCode(input.regionCode);
    if (!region) {
        // Was `badRequest('invalid_region', …)`, which put the code in the
        // MESSAGE field (#2541) — and used a different spelling from the
        // edit path's refusal for the same cause. One refusal, one code.
        throw codedBadRequest(
            'LISTING_REGION_UNKNOWN',
            `Unknown region code: ${input.regionCode}`,
        );
    }

    return runInTenantContext(ctx, async (db) => {
        // Per-tenant ACTIVE-listing quota — the real spam control, since the
        // EXCHANGE module is available on the FREE plan. Self-hosted mode
        // resolves to ENTERPRISE (unlimited) and short-circuits without a DB
        // count.
        //
        // Run INSIDE the create's own transaction (`db`), not before it. As a
        // standalone call it committed and released before the insert began,
        // so two concurrent creates on a tenant at limit-1 both counted
        // limit-1, both passed, and both wrote — the cap was advisory under
        // precisely the burst it exists to stop.
        // In good standing first, then within plan. Two different
        // problems with two different fixes — a payment failure must not
        // send somebody to a plan picker (#1325).
        await assertNotPastDueRestricted(ctx, 'exchange', db);
        await assertWithinLimit(ctx, 'exchange_listing', db);

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
            priceCurrency: EXCHANGE_CURRENCY,
            regionCode: region.code,
            // The ENGLISH name is persisted as the stable, locale-independent
            // record of which oblast this is; every surface renders the name
            // through `regionCode` in the reader's own language
            // (`localizedRegionName`), so a Bulgarian farmer never sees
            // "Stara Zagora". Keeping the column means legacy rows and any
            // non-UI consumer still have a human-readable region.
            regionName: region.nameEn,
            lat: region.lat,
            lon: region.lon,
            description: sanitizeOptional(input.description) ?? null,
            sellerDisplayName: sanitizeOptional(input.sellerDisplayName) ?? null,
            // NOT sanitised, because it is a boolean and there is nothing to
            // sanitise. Stored as the DECISION only: the farm name and handle
            // it resolves to are read live from `FarmBrand` on every read, so
            // a rename or a withdrawal reaches this listing without touching
            // the row.
            publishAsFarm: input.publishAsFarm ?? false,
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
 * Create a listing, and return it with its farm attribution resolved.
 *
 * The wrapper exists because the 201 response goes through the same
 * `toPublicListing` as every read, and that projection reads `row.farm`. The
 * row the transaction returns has no `farm` on it, so without this a listing
 * created WITH `publishAsFarm: true` would come back reporting
 * `farmHandle: null` — the attribution appearing only after a refresh, which
 * reads as the flag not having been saved.
 */
export async function createListing(ctx: RequestContext, input: CreateListingInput) {
    const listing = await createListingRow(ctx, input);
    // The market moved — #2123. Coalesced at the publisher, so a burst of
    // listings produces one tick; synchronous and it never throws, because a
    // notification failure must not cost the write that caused it.
    publishListingChange();
    return (await withFarmAttribution([listing]))[0];
}

/**
 * Load a listing and assert the caller's tenant OWNS it. The cross-tenant
 * write guard — throws notFound if it doesn't exist, forbidden if it belongs
 * to another tenant.
 */
async function loadOwnedListing(db: PrismaTx, ctx: RequestContext, id: string) {
    const listing = await ExchangeRepository.getListing(db, id);
    if (!listing) throw codedNotFound('LISTING_NOT_FOUND', 'Listing not found');
    if (listing.sellerTenantId !== ctx.tenantId) {
        // Coded for the same reason, and because a bare `forbidden()` reports
        // `code: 'FORBIDDEN'` — indistinguishable from every other refusal on
        // the route. The line directly above has been coded since it was
        // written, which is how one function came to answer two ways.
        throw codedForbidden('LISTING_NOT_OWNED', 'You can only modify your own listings');
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
        // #2541: `badRequest` is `(message, details)`, so passing a code as
        // the first argument put `listing_terminal` in the field a client
        // RENDERS and left `code` as the generic `BAD_REQUEST` — identical for
        // both refusals below, so a client could not tell them apart, and a
        // farmer was shown the literal string. `errors.<CODE>` in both
        // catalogues is what the client reads now.
        throw codedBadRequest(
            'LISTING_TERMINAL',
            `"${commodity}" is already ${from.toLowerCase()} and cannot be changed`,
        );
    }
    if (to === ExchangeListingStatus.FULFILLED && from !== ExchangeListingStatus.ACTIVE) {
        throw codedBadRequest(
            'LISTING_NOT_ACTIVE',
            `"${commodity}" has expired — withdraw it instead of marking it fulfilled`,
        );
    }
}

export async function withdrawListing(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
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
    // AFTER the transaction, like every other side effect here: a withdrawn
    // listing has left the market, which is a change every browsing client
    // should see. Coalesced, so three withdrawals in a burst are one tick.
    publishListingChange();
    return result;
}

/**
 * Replace every editable field on one of the caller-tenant's own listings —
 * #2543. Owner ruling 2026-10-31: every field is editable, and a later
 * `expiresAt` reactivates an EXPIRED listing.
 *
 * ## Why a full replacement
 *
 * Five of these fields are nullable, and under a partial patch "leave the
 * description alone" and "clear the description" are the same JSON unless a
 * sentinel is invented. The seller's own read carries `edit`, which is this
 * body verbatim, so "send it back unchanged" is a complete instruction.
 *
 * ## Module-gated, unlike withdraw
 *
 * `withdrawListing` is deliberately exempt: the EXCHANGE toggle governs
 * PARTICIPATION in the marketplace, not CUSTODY of rows you already posted,
 * and gating withdraw once left a tenant with public listings and no endpoint
 * to remove them. Editing changes what is being OFFERED, to buyers, in a
 * market — so it gates like `fulfillListing` rather than being exempt like
 * withdraw. The gate is applied at the route, where the other two are.
 *
 * ## The plan limit is checked ONLY when this reactivates
 *
 * `assertWithinLimit('exchange_listing')` counts ACTIVE listings. An ordinary
 * edit does not change that count and must not be refused by a quota it
 * cannot affect. But EXPIRED → ACTIVE does increase it, so a tenant at its cap
 * could otherwise walk past the cap by reactivating lapsed rows one at a time.
 * Checked inside the transaction, like the create path, because as a
 * standalone call it commits and releases before the write begins — two
 * concurrent reactivations at cap-1 would both count cap-1 and both pass.
 */
export async function updateListingFields(
    ctx: RequestContext,
    id: string,
    input: UpdateListingBody,
) {
    assertCanWrite(ctx);

    const region = regionByCode(input.regionCode);
    if (!region) {
        throw codedBadRequest(
            'LISTING_REGION_UNKNOWN',
            `Unknown region code: ${input.regionCode}`,
        );
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const listing = await loadOwnedListing(db, ctx, id);
        const from = listing.status as ExchangeListingStatus;

        if (TERMINAL_LISTING_STATUSES.includes(from)) {
            throw codedBadRequest(
                'LISTING_TERMINAL',
                `"${listing.commodity}" is already ${from.toLowerCase()} and cannot be edited`,
            );
        }

        /*
         * The edit PRECONDITION. Full replacement is what makes it worth
         * having: a lost update here discards every field the other editor
         * changed, not one, and «Моите обяви» is on the web and the phone at
         * the same time.
         *
         * Compared as an INSTANT, not as a string: `updatedAt` round-trips
         * through `toISOString()` and back, and two spellings of one moment
         * must not read as a conflict. An unparseable value is a conflict
         * rather than a pass — a client that cannot echo the precondition has
         * not satisfied it.
         */
        const seen = new Date(input.updatedAt).getTime();
        if (!Number.isFinite(seen) || seen !== listing.updatedAt.getTime()) {
            throw codedConflict(
                'LISTING_MODIFIED',
                'This listing changed since you opened it. Reload it and make the change again.',
            );
        }

        // Owner ruling: a later expiry brings a lapsed listing back, keeping
        // its conversations. Only a reactivation touches the ACTIVE count.
        const reactivating = from === ExchangeListingStatus.EXPIRED;
        if (reactivating) {
            await assertNotPastDueRestricted(ctx, 'exchange', db);
            await assertWithinLimit(ctx, 'exchange_listing', db);
        }
        const status = reactivating ? ExchangeListingStatus.ACTIVE : from;

        const updated = await ExchangeRepository.updateListingFields(db, id, {
            side: input.side,
            kind: input.kind,
            // commodity + description + sellerDisplayName are PUBLIC free text
            // (every tenant reads them) → sanitize before persisting, exactly
            // as the create path does. An edit that skipped this would be a
            // second way in for the same content.
            commodity: sanitizePlainText(input.commodity),
            quantityTonnes: input.quantityTonnes,
            pricePerTonne: input.pricePerTonne ?? null,
            // FORCED, not taken from the body — the create path does the same.
            // The field is in the request shape so the seller's `edit` object
            // round-trips, not so a client can choose a currency.
            priceCurrency: EXCHANGE_CURRENCY,
            regionCode: region.code,
            regionName: region.nameEn,
            lat: region.lat,
            lon: region.lon,
            description: sanitizeOptional(input.description) ?? null,
            sellerDisplayName: sanitizeOptional(input.sellerDisplayName) ?? null,
            publishAsFarm: input.publishAsFarm ?? false,
            sellerContact: sanitizeOptional(input.sellerContact) ?? null,
            expiresAt: input.expiresAt ?? null,
            status,
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ExchangeListing',
            entityId: id,
            details: `Edited listing: ${updated.commodity}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ExchangeListing',
                operation: 'updated',
                // The STATUS transition is recorded because it is the one
                // change a reader would not expect from an edit.
                ...(reactivating ? { fromStatus: from, toStatus: status } : {}),
                after: {
                    side: updated.side,
                    kind: updated.kind,
                    commodity: updated.commodity,
                    regionCode: updated.regionCode,
                },
                summary: `Edited listing: ${updated.commodity}`,
            },
        });
        return updated;
    });

    // The market moved: an edited listing shows different terms to every
    // browsing client. Coalesced, and after the transaction like every other
    // side effect here.
    publishListingChange();
    return (await withFarmAttribution([result]))[0];
}

/** Mark one of the caller-tenant's own listings as fulfilled. */
export async function fulfillListing(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
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
    // AFTER the transaction. A fulfilled listing leaves the market too, and
    // the same tick serves both — a browsing client refetches the list
    // either way and does not need to know which transition happened.
    publishListingChange();
    return result;
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
        // #1655 rides the EXISTING not-found rather than adding a second one,
        // which is also exactly the behaviour wanted: a suppressed listing is
        // indistinguishable from an absent one. A withdrawn listing still gets
        // `listing_not_active` below — honest, because the seller withdrew it —
        // whereas naming the suppressed state would disclose that its seller
        // asked to delete their account.
        if (!listing || listing.suppressedForDeletionAt) throw codedNotFound('LISTING_NOT_FOUND', 'Listing not found');
        if (listing.status !== ExchangeListingStatus.ACTIVE) {
            throw codedBadRequest('LISTING_NOT_ACTIVE', 'This listing is no longer active');
        }
        // The SAME predicate the browse feed filters on
        // (`ExchangeRepository.listActiveListings`). Status alone was not
        // enough: an ACTIVE row past its expiry vanishes from the feed
        // immediately but stays ACTIVE in the table until the nightly sweep
        // flips it, so for up to a day a listing nobody could see could still
        // take inquiries through a deep link — and the seller got notified
        // about an offer they had already let lapse.
        if (listing.expiresAt != null && listing.expiresAt <= new Date()) {
            throw codedBadRequest('LISTING_EXPIRED', 'This listing has expired');
        }
        // You cannot inquire on your OWN listing.
        if (listing.sellerTenantId === ctx.tenantId) {
            // Correct usage of `forbidden` — prose first, not a code in the
            // message. Coded anyway, because `code: 'FORBIDDEN'` is
            // indistinguishable from every other refusal on this route and the
            // client renders from the code. Unlike the five #2541 sites, nothing
            // was WRONG with this line; it was simply unnameable.
            throw codedForbidden(
                'LISTING_IS_YOUR_OWN',
                'You cannot inquire on your own listing',
            );
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
                // `codedConflict`, not `conflict`: the plain helper defaults
                // `code` to the generic 'CONFLICT', and THREE unrelated
                // refusals shared it — this one, the promotion lead, and a
                // taken company name. A client switching on `code`, which is
                // what the spec's ErrorResponse tells clients to do, could not
                // tell them apart (#1391). Same defect `farm-creation.ts`
                // documents for `badRequest`, one status along.
                throw codedConflict(
                    'LISTING_INTEREST_ALREADY_SENT',
                    'You have already expressed interest in this listing.',
                );
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
                        // `uiLanguage` so the email is written in the
                        // RECIPIENT's language rather than the inquirer's —
                        // this is the one Exchange channel that crosses a
                        // tenant boundary, so the two are different people.
                        user: { select: { email: true, uiLanguage: true } },
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

                // In-app Notification for each seller admin/owner, each in
                // THEIR language. `uiLanguage` is already selected above for
                // the email, so this costs no extra query — the title was
                // simply never using it (#2511).
                //
                // `message` stays a passthrough: it is `sanitizedMessage`, the
                // BUYER's own words. Translating it would rewrite what one
                // farmer said to another.
                const rows = [];
                for (const a of admins) {
                    rows.push({
                        tenantId: listing.sellerTenantId,
                        userId: a.userId,
                        type: 'GENERAL' as const,
                        title: await translateFor(
                            resolveRecipientLocale(a.user?.uiLanguage),
                            'notifications.exchangeInterest.title',
                            { commodity: listing.commodity },
                        ),
                        message,
                        linkUrl: inquiriesUrl,
                    });
                }
                await sellerDb.notification.createMany({
                    data: rows,
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
        // Dedupe by email, keeping the first locale seen for that address —
        // a user holding several admin memberships is one person with one
        // language preference.
        const byEmail = new Map<string, string | null>();
        for (const a of admins) {
            const email = a.user.email;
            if (email && !byEmail.has(email)) byEmail.set(email, a.user.uiLanguage);
        }
        await Promise.allSettled(
            [...byEmail].map(([to, uiLanguage]) =>
                sendInquiryEmail({
                    to,
                    locale: isLocale(uiLanguage) ? uiLanguage : undefined,
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
        // ONE oracle for "not yours" and "not there".
        //
        // ExchangeInquiry ids are global and guessable-by-enumeration in the
        // way any id is, and the pair (404 = no such inquiry, 403 = exists but
        // belongs to someone else) let an outsider confirm the existence of
        // another tenant's private buyer↔seller conversations one id at a
        // time. The GUARD is unchanged and still absolute — only the seller
        // may respond; what changed is that a non-seller learns nothing from
        // the answer.
        if (!inquiry || inquiry.listing.sellerTenantId !== ctx.tenantId) {
            throw codedNotFound('INQUIRY_NOT_FOUND', 'That inquiry was not found.');
        }
        if (inquiry.status !== ExchangeInquiryStatus.PENDING) {
            throw codedBadRequest(
                'INQUIRY_NOT_PENDING',
                'This inquiry has already been answered',
            );
        }
        // A listing that has left ACTIVE can no longer be transacted, so
        // accepting on it would reveal contacts for a deal that cannot happen.
        // Declining stays allowed: a seller who fulfils elsewhere should still
        // be able to close out the inquiries they left hanging.
        if (
            action === 'ACCEPTED' &&
            inquiry.listing.status !== ExchangeListingStatus.ACTIVE
        ) {
            throw codedBadRequest(
                'LISTING_NOT_ACTIVE',
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
    const rows = await runInTenantContext(ctx, (db) =>
        ExchangeRepository.listListingsBySeller(db, ctx.tenantId),
    );
    // The seller's own view is attributed too. They know who they are, but
    // this is the screen where they check what a BUYER sees — a listing shown
    // as anonymous here while appearing named in the feed would be the more
    // confusing of the two possible inconsistencies.
    return withFarmAttribution(rows);
}
