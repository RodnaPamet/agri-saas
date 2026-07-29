/**
 * Unit tests — Exchange public projection + browse filter builder.
 *
 * `toPublicListing` is the wire boundary for the cross-tenant feed: it must
 * drop the raw owning-tenant id (→ opaque `isOwn`), never leak `sellerUserId`,
 * and stringify decimals/dates. `buildExchangeFilters` injects runtime
 * commodity options without disturbing the static filters.
 */
import {
    toPublicListing,
    toPublicInquiry,
    type ExchangeListingRow,
    type ExchangeInquiryRow,
} from '@/lib/exchange/public-listing';
import { buildExchangeFilters } from '@/app/t/[tenantSlug]/(app)/exchange/filter-defs';

function row(overrides: Partial<ExchangeListingRow> = {}): ExchangeListingRow {
    return {
        id: 'lst-1',
        sellerTenantId: 'tenant-1',
        side: 'SELL',
        kind: 'CULTURE',
        commodity: 'Wheat',
        quantityTonnes: { toString: () => '10.500' },
        pricePerTonne: { toString: () => '250.00' },
        priceCurrency: 'BGN',
        regionCode: 'BG-16',
        regionName: 'Plovdiv',
        lat: 42.2,
        lon: 24.8,
        description: 'Clean milling wheat',
        sellerDisplayName: 'Acme Farm',
        status: 'ACTIVE',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: null,
        ...overrides,
    };
}

describe('toPublicListing', () => {
    it('marks isOwn true only for the viewing tenant and never leaks the tenant id', () => {
        const own = toPublicListing(row(), 'tenant-1');
        expect(own.isOwn).toBe(true);
        const foreign = toPublicListing(row(), 'tenant-2');
        expect(foreign.isOwn).toBe(false);
        // Neither the owning-tenant id nor a user id survives the projection.
        expect(JSON.stringify(foreign)).not.toContain('tenant-1');
        expect(Object.keys(foreign)).not.toContain('sellerTenantId');
        expect(Object.keys(foreign)).not.toContain('sellerUserId');
    });

    it('stringifies decimals + dates and preserves a null price', () => {
        const dto = toPublicListing(row({ pricePerTonne: null }), 'tenant-9');
        expect(dto.quantityTonnes).toBe('10.500');
        expect(dto.pricePerTonne).toBeNull();
        expect(dto.createdAt).toBe('2026-07-01T00:00:00.000Z');
        expect(dto.expiresAt).toBeNull();
    });

    it('privacy invariant — exposes ONLY coarse public fields (no geometry / terms / owner ids)', () => {
        const dto = toPublicListing(row(), 'tenant-9');
        // The complete, exact public surface. lat/lon are the REGION centroid
        // (a coarse map pin), never exact parcel geometry.
        expect(Object.keys(dto).sort()).toEqual([
            'commodity', 'createdAt', 'description', 'expiresAt', 'id', 'isOwn',
            'kind', 'lat', 'lon', 'priceCurrency', 'pricePerTonne', 'quantityTonnes',
            'regionCode', 'regionName', 'sellerDisplayName', 'side', 'status',
        ]);
        // None of the private / geometry / contract-term fields ever leak.
        for (const banned of [
            'geometry', 'coordinates', 'boundary', 'parcelId', 'terms',
            'contractTerms', 'pricingNotes', 'treatmentNotes', 'sellerTenantId',
            'sellerUserId', 'emailEncrypted',
        ]) {
            expect(Object.keys(dto)).not.toContain(banned);
        }
    });
});

/**
 * The reveal gate. `toPublicInquiry` is the ONLY place in the codebase that
 * decides whether a contact leaves the server, so these are not "projection
 * shape" tests — they are the authorization tests for the whole feature.
 *
 * Three axes, and all three must hold simultaneously:
 *   WHEN   — only once `contactSharedAt` is stamped (i.e. only on ACCEPT).
 *   WHO    — only the two parties to the inquiry.
 *   WHICH  — each party gets the OTHER's contact, never their own echoed
 *            back and never both.
 */
const SELLER = 'tenant-seller';
const BUYER = 'tenant-buyer';
const THIRD_PARTY = 'tenant-nosy';
const SELLER_CONTACT = '+359 88 111 1111';
const BUYER_CONTACT = 'buyer@farm.test';

function inquiryRow(overrides: Partial<ExchangeInquiryRow> = {}): ExchangeInquiryRow {
    return {
        id: 'inq-1',
        message: 'Interested in 50t',
        quantityTonnes: { toString: () => '50.000' },
        status: 'ACCEPTED',
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
        contactSharedAt: new Date('2026-07-21T09:30:00.000Z'),
        inquirerContact: BUYER_CONTACT,
        inquirerTenantId: BUYER,
        listing: row({ sellerTenantId: SELLER, sellerContact: SELLER_CONTACT }),
        ...overrides,
    };
}

describe('toPublicInquiry — the contact reveal gate', () => {
    it('ACCEPTED: hands each party the OTHER side’s contact, never their own', () => {
        const asBuyer = toPublicInquiry(inquiryRow(), BUYER);
        expect(asBuyer.counterpartyContact).toBe(SELLER_CONTACT);
        // The buyer never gets their own value echoed back — that would make a
        // "both contacts" payload one refactor away.
        expect(JSON.stringify(asBuyer)).not.toContain(BUYER_CONTACT);

        const asSeller = toPublicInquiry(inquiryRow(), SELLER, false);
        expect(asSeller.counterpartyContact).toBe(BUYER_CONTACT);
        expect(JSON.stringify(asSeller)).not.toContain(SELLER_CONTACT);
    });

    it('ACCEPTED: a THIRD party gets nothing, from either side', () => {
        const dto = toPublicInquiry(inquiryRow(), THIRD_PARTY);
        expect(dto.counterpartyContact).toBeNull();
        expect(JSON.stringify(dto)).not.toContain(SELLER_CONTACT);
        expect(JSON.stringify(dto)).not.toContain(BUYER_CONTACT);
    });

    it.each(['PENDING', 'DECLINED'])(
        '%s (no consent stamp): nobody sees anything — not the buyer, the seller, or a stranger',
        (status) => {
            const row = inquiryRow({ status, contactSharedAt: null });
            for (const viewer of [BUYER, SELLER, THIRD_PARTY]) {
                const dto = toPublicInquiry(row, viewer);
                expect(dto.counterpartyContact).toBeNull();
                expect(dto.contactSharedAt).toBeNull();
                expect(JSON.stringify(dto)).not.toContain(SELLER_CONTACT);
                expect(JSON.stringify(dto)).not.toContain(BUYER_CONTACT);
            }
        },
    );

    it('the STAMP is the gate, not the status string — an unstamped "ACCEPTED" reveals nothing', () => {
        // The DB CHECK constraint makes the inverse pair (stamped + not
        // accepted) unrepresentable; this pins the direction the projection is
        // responsible for, so a future caller cannot get a reveal by writing a
        // status alone.
        const dto = toPublicInquiry(inquiryRow({ contactSharedAt: null }), BUYER);
        expect(dto.status).toBe('ACCEPTED');
        expect(dto.counterpartyContact).toBeNull();
    });

    it('a missing contact on the revealing side yields null, not undefined', () => {
        const noSellerContact = toPublicInquiry(
            inquiryRow({ listing: row({ sellerTenantId: SELLER, sellerContact: null }) }),
            BUYER,
        );
        expect(noSellerContact.counterpartyContact).toBeNull();
        const noBuyerContact = toPublicInquiry(inquiryRow({ inquirerContact: null }), SELLER, false);
        expect(noBuyerContact.counterpartyContact).toBeNull();
    });

    it('the nested LISTING projection never carries sellerContact — on any path', () => {
        const dto = toPublicInquiry(inquiryRow(), BUYER);
        expect(dto.listing).toBeDefined();
        expect(Object.keys(dto.listing!)).not.toContain('sellerContact');
        // …and the inquirer's tenant/user ids never reach the wire either.
        expect(Object.keys(dto)).not.toContain('inquirerTenantId');
        expect(Object.keys(dto)).not.toContain('inquirerUserId');
        expect(Object.keys(dto)).not.toContain('inquirerContact');
    });

    it('includeListing=false omits the listing entirely (the seller’s nested inbox shape)', () => {
        const dto = toPublicInquiry(inquiryRow(), SELLER, false);
        expect(dto.listing).toBeUndefined();
        expect(dto.contactSharedAt).toBe('2026-07-21T09:30:00.000Z');
    });
});

describe('buildExchangeFilters', () => {
    it('injects distinct, sorted commodity options and leaves other filters intact', () => {
        const defs = buildExchangeFilters((k) => k, ['Sunflower', 'Wheat', 'Wheat', 'Barley']);
        const commodity = defs.find((f) => f.key === 'commodity');
        expect(commodity?.options?.map((o) => o.value)).toEqual(['Barley', 'Sunflower', 'Wheat']);

        // Region options are static (28 oblasti) and untouched.
        const region = defs.find((f) => f.key === 'region');
        expect(region?.options?.length).toBe(28);
        // Side stays a 2-option static filter.
        const side = defs.find((f) => f.key === 'side');
        expect(side?.options?.map((o) => o.value)).toEqual(['SELL', 'BUY']);
    });
});
