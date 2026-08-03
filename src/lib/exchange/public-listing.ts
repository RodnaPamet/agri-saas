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
    commodity: string;
    commodityKey: string | null;
    quantityTonnes: { toString(): string };
    pricePerTonne: { toString(): string } | null;
    priceCurrency: string;
    regionCode: string;
    regionName: string;
    lat: number;
    lon: number;
    description: string | null;
    sellerDisplayName: string | null;
    status: string;
    createdAt: Date | string;
    expiresAt: Date | string | null;
}

export interface ExchangePublicListing {
    id: string;
    side: 'SELL' | 'BUY';
    /** Free-text commodity (display fallback for the OTHER long tail). */
    commodity: string;
    /** Canonical taxonomy key — unify/group/localize by this. Null on legacy rows. */
    commodityKey: string | null;
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
    listing?: ExchangeListingRow;
}

export interface ExchangePublicInquiry {
    id: string;
    message: string;
    quantityTonnes: string | null;
    status: string;
    createdAt: string;
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
    return {
        id: row.id,
        message: row.message,
        quantityTonnes: row.quantityTonnes != null ? row.quantityTonnes.toString() : null,
        status: row.status,
        createdAt: iso(row.createdAt),
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
        commodity: row.commodity,
        commodityKey: row.commodityKey ?? null,
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
