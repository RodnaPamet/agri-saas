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
    /** Whether the seller asked for this listing to be attributed to the farm. */
    publishAsFarm?: boolean;
    /**
     * The seller's PUBLISHED farm identity, resolved live by the usecase.
     *
     * Three states, and they are not the same:
     *   - `{ handle, displayName }` — this seller is a published farm.
     *   - `null` — resolved, and they are not (never published, or withdrawn).
     *   - ABSENT — nobody resolved it. A bug if `publishAsFarm` is true, and
     *     the only reason the field is optional is that `toPublicInquiry`
     *     projects a nested listing whose shape is built by a repository.
     *
     * Both `null` and absent fall back to the typed name, which is the
     * fail-closed direction: a listing never claims a farm identity it could
     * not confirm.
     */
    farm?: { handle: string; displayName: string } | null;
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
    /**
     * Optional because the feed query selects a narrower row. Present on the
     * seller's own read, where `toListingEdit` uses it as the edit
     * precondition.
     */
    updatedAt?: Date | string;
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
    /**
     * The farm's public address when this listing is attributed to a published
     * farm, else `null` — P6.7 (#1816).
     *
     * A HANDLE, not a tenant id and not a url: the client builds `/f/{handle}`
     * from it, and this projection has never carried a raw owning-tenant id.
     * `null` means "show no link", which covers a listing the seller never
     * attributed AND one whose farm has since withdrawn its page — the client
     * does not need to tell those apart.
     */
    farmHandle: string | null;
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
        // Attribution overrides the typed name, and only when BOTH halves
        // agree: the seller asked for it AND the usecase confirmed they are a
        // published farm. Either half alone falls back to what they typed,
        // which is the fail-closed direction — a listing never claims a farm
        // identity that could not be confirmed on this read.
        //
        // Because the confirmation is live, a farm that withdraws its page
        // stops being named here on the very next read, with nothing to
        // back-fill and no listing left pointing at an address that 404s.
        sellerDisplayName:
            row.publishAsFarm && row.farm ? row.farm.displayName : row.sellerDisplayName,
        farmHandle: row.publishAsFarm && row.farm ? row.farm.handle : null,
        status: row.status,
        createdAt: iso(row.createdAt),
        expiresAt: row.expiresAt != null ? iso(row.expiresAt) : null,
        isOwn: row.sellerTenantId === viewerTenantId,
    };
}

/**
 * The seller's OWN view of their listing's editable values — #2543.
 *
 * ## Why this is a second projection and not more fields on the first
 *
 * `ExchangePublicListing` answers "what does a buyer see". This answers "what
 * would I send back to leave this unchanged". They disagree on one field and
 * the disagreement is not cosmetic: `toPublicListing` resolves
 * `sellerDisplayName` to the FARM's verified name when `publishAsFarm` is set,
 * because a seller's own management screen is where they check what a buyer
 * sees. Echo that resolved value into a full-replacement PUT and the farm's
 * verified name is written back into the seller's typed-alias column as
 * literal text — and then survives them unticking `publishAsFarm`, now
 * unverified and indistinguishable from something they typed.
 *
 * So the display value stays where it is and the STORED value lives here. One
 * field cannot mean both things, which is what the iOS session found when it
 * asked how a client holding only the public element could send the editable
 * set back.
 *
 * ## It is the request body, verbatim
 *
 * Every field here is one the PUT accepts, and the whole object is a valid
 * body. "Send `edit` back unchanged" is therefore a complete instruction, with
 * nothing for a client to assemble from two places and nothing to omit by
 * accident — which matters because the PUT is a full replacement and an
 * omitted nullable field is indistinguishable from a deliberate clearing.
 *
 * `sellerContact` IS here, and that is not a loosening of the rule on
 * `ExchangeListingRow.sellerContact`. That rule is about the PUBLIC
 * projection, which must never carry it however the listing was fetched; this
 * object is only ever built for the tenant that owns the row. The rule was
 * held by a comment until this projection existed to need it, and is now held
 * by `tests/unit/exchange-public-listing.test.ts`.
 */
export interface ExchangeListingEdit {
    side: 'SELL' | 'BUY';
    kind: ExchangeKindValue;
    commodity: string;
    quantityTonnes: string;
    pricePerTonne: string | null;
    priceCurrency: string;
    regionCode: string;
    description: string | null;
    /** The seller's TYPED alias as stored — never the resolved attribution. */
    sellerDisplayName: string | null;
    publishAsFarm: boolean;
    /** The seller's own private contact. Their data, on their own read. */
    sellerContact: string | null;
    expiresAt: string | null;
    /**
     * A PRECONDITION, echoed back, not a value to change.
     *
     * The PUT refuses when this does not match the row's current `updatedAt`.
     * Full replacement is what makes that worth having: a lost update here
     * discards every field the other editor changed, not one, and the web and
     * the phone can both be open on the same listing. Writing euro figures
     * under a lev label is the kind of thing that happens when two clients
     * disagree about which copy is current.
     */
    updatedAt: string;
}

/**
 * Build the seller's editable view. Only ever called for a row the caller's
 * tenant owns — the ownership check is the usecase's, not this projection's.
 */
export function toListingEdit(row: ExchangeListingRow): ExchangeListingEdit {
    return {
        side: row.side as 'SELL' | 'BUY',
        kind: row.kind as ExchangeKindValue,
        commodity: row.commodity,
        quantityTonnes: row.quantityTonnes.toString(),
        pricePerTonne: row.pricePerTonne != null ? row.pricePerTonne.toString() : null,
        priceCurrency: row.priceCurrency,
        regionCode: row.regionCode,
        description: row.description,
        sellerDisplayName: row.sellerDisplayName,
        publishAsFarm: row.publishAsFarm ?? false,
        sellerContact: row.sellerContact ?? null,
        expiresAt: row.expiresAt != null ? iso(row.expiresAt) : null,
        updatedAt: row.updatedAt != null ? iso(row.updatedAt) : '',
    };
}
