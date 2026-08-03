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
    type ExchangeListingRow,
} from '@/lib/exchange/public-listing';
import { buildExchangeFilters } from '@/app/t/[tenantSlug]/(app)/exchange/filter-defs';

function row(overrides: Partial<ExchangeListingRow> = {}): ExchangeListingRow {
    return {
        id: 'lst-1',
        sellerTenantId: 'tenant-1',
        side: 'SELL',
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
            'commodity', 'commodityKey', 'createdAt', 'description', 'expiresAt', 'id', 'isOwn',
            'lat', 'lon', 'priceCurrency', 'pricePerTonne', 'quantityTonnes',
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

describe('buildExchangeFilters', () => {
    it('injects distinct, sorted commodity options and leaves other filters intact', () => {
        const defs = buildExchangeFilters(['Sunflower', 'Wheat', 'Wheat', 'Barley']);
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
