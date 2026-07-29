/**
 * Public projection of an ExchangeListing — the ONLY shape sent to the
 * browser for the cross-tenant marketplace.
 *
 * The Exchange is cross-tenant (every tenant sees every tenant's offers), so
 * the wire shape must be deliberately public: NO internal ids
 * (`sellerUserId`), NO raw owning-tenant id (replaced by an opaque `isOwn`
 * boolean computed against the viewer), and only fields a tenant is happy to
 * broadcast. Decimals are stringified (JSON has no decimal type).
 */

/** Structural row shape (matches the Prisma ExchangeListing without importing it). */
export interface ExchangeListingRow {
    id: string;
    sellerTenantId: string;
    side: string;
    kind: string;
    commodity: string;
    quantityTonnes: { toString(): string };
    pricePerTonne: { toString(): string } | null;
    priceCurrency: string;
    regionCode: string;
    regionName: string;
    lat: number;
    lon: number;
    description: string | null;
    sellerDisplayName: string | null;
    /**
     * Seller's private contact. Read by `toPublicInquiry`'s reveal gate and
     * DELIBERATELY absent from `ExchangePublicListing` — a listing projection
     * must never carry it, however the listing was fetched. Optional so the
     * feed query can keep selecting a narrower row.
     */
    sellerContact?: string | null;
    status: string;
    createdAt: Date | string;
    expiresAt: Date | string | null;
}

export type ExchangeKindValue = 'CULTURE' | 'FERTILIZER' | 'SEEDS' | 'PRODUCT';

export interface ExchangePublicListing {
    id: string;
    side: 'SELL' | 'BUY';
    kind: ExchangeKindValue;
    commodity: string;
    /** Tonnes, as a decimal string. */
    quantityTonnes: string;
    /** Price per tonne, decimal string, or null when the seller omitted it. */
    pricePerTonne: string | null;
    priceCurrency: string;
    regionCode: string;
    regionName: string;
    lat: number;
    lon: number;
    description: string | null;
    sellerDisplayName: string | null;
    status: string;
    createdAt: string;
    expiresAt: string | null;
    /** True when the VIEWING tenant owns this listing (badge "your offer"). */
    isOwn: boolean;
}

function iso(d: Date | string): string {
    return typeof d === 'string' ? d : d.toISOString();
}

/** Inquiry projection — coarse, no inquirer ids leaked to the wire. */
export interface ExchangeInquiryRow {
    id: string;
    message: string;
    quantityTonnes: { toString(): string } | null;
    status: string;
    createdAt: Date | string;
    /** Non-null only once the seller has ACCEPTED — the reveal gate. */
    contactSharedAt?: Date | string | null;
    /** Buyer's contact. Revealed to the SELLER only, and only after accept. */
    inquirerContact?: string | null;
    /** Who wrote it — needed to decide which side of the reveal the viewer is on. */
    inquirerTenantId?: string;
    listing?: ExchangeListingRow;
}

export interface ExchangePublicInquiry {
    id: string;
    message: string;
    quantityTonnes: string | null;
    status: string;
    createdAt: string;
    /**
     * The COUNTERPARTY's contact — the buyer sees the seller's, the seller sees
     * the buyer's. Null until the seller accepts, and null forever on decline.
     */
    counterpartyContact: string | null;
    /** When the two-sided consent completed; null until then. */
    contactSharedAt: string | null;
    /** Present in the buyer's outbox; omitted in the seller's per-listing nest. */
    listing?: ExchangePublicListing;
}

/**
 * Inquiry projection. In the buyer's OUTBOX we attach the listing's public
 * projection; the seller's inbox nests inquiries under their own listing, so
 * pass `includeListing: false` there. Never exposes inquirerTenantId/userId.
 */
export function toPublicInquiry(
    row: ExchangeInquiryRow,
    viewerTenantId: string,
    includeListing = true,
): ExchangePublicInquiry {
    // ── The reveal gate ──────────────────────────────────────────────────
    // Two conditions, both required, and this is the ONLY place they are
    // evaluated. `contactSharedAt` is set exclusively when the seller accepts,
    // so a PENDING or DECLINED inquiry yields null for everyone — a decline
    // must never leak either party's details.
    //
    // The viewer then gets the OTHER side's contact, never their own echoed
    // back and never both: the buyer sees the seller's, the seller sees the
    // buyer's. Deciding it here rather than at each call site means a new
    // endpoint cannot forget the check.
    const shared = row.contactSharedAt != null;
    const viewerIsInquirer =
        row.inquirerTenantId != null && row.inquirerTenantId === viewerTenantId;
    const viewerIsSeller =
        row.listing != null && row.listing.sellerTenantId === viewerTenantId;

    let counterpartyContact: string | null = null;
    if (shared) {
        if (viewerIsInquirer) counterpartyContact = row.listing?.sellerContact ?? null;
        else if (viewerIsSeller) counterpartyContact = row.inquirerContact ?? null;
    }

    return {
        id: row.id,
        message: row.message,
        quantityTonnes: row.quantityTonnes != null ? row.quantityTonnes.toString() : null,
        status: row.status,
        createdAt: iso(row.createdAt),
        counterpartyContact,
        contactSharedAt: row.contactSharedAt != null ? iso(row.contactSharedAt) : null,
        ...(includeListing && row.listing
            ? { listing: toPublicListing(row.listing, viewerTenantId) }
            : {}),
    };
}

/** Map a listing row to its public projection for `viewerTenantId`. */
export function toPublicListing(
    row: ExchangeListingRow,
    viewerTenantId: string,
): ExchangePublicListing {
    return {
        id: row.id,
        side: row.side as 'SELL' | 'BUY',
        kind: row.kind as ExchangeKindValue,
        commodity: row.commodity,
        quantityTonnes: row.quantityTonnes.toString(),
        pricePerTonne: row.pricePerTonne != null ? row.pricePerTonne.toString() : null,
        priceCurrency: row.priceCurrency,
        regionCode: row.regionCode,
        regionName: row.regionName,
        lat: row.lat,
        lon: row.lon,
        description: row.description,
        sellerDisplayName: row.sellerDisplayName,
        status: row.status,
        createdAt: iso(row.createdAt),
        expiresAt: row.expiresAt != null ? iso(row.expiresAt) : null,
        isOwn: row.sellerTenantId === viewerTenantId,
    };
}
