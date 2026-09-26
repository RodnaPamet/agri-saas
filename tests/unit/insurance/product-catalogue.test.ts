/**
 * The product catalogue endpoint — for clients that cannot import the engine.
 *
 * The web app does not need this: it imports `INSURANCE_PRODUCTS` directly, so
 * there is nothing to drift. It exists because a SEPARATE codebase (the native
 * iOS client) would otherwise compile in `1000` bp, and that duplication is
 * worse than most: the server's recompute is what gets stored and emailed, so a
 * stale local tariff shows the farmer one figure and the operator another with
 * nothing anywhere saying so.
 *
 * So the property under test is not "the endpoint returns products". It is that
 * the response cannot disagree with the engine — every assertion below derives
 * its expectation from `src/lib/insurance` rather than restating it, because a
 * hardcoded 1000 here would reintroduce the very duplication the endpoint
 * removes, one layer up.
 */
const mockDb = { tenant: { findUnique: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/env', () => ({ env: {} }));

import {
    INSURANCE_ENGINE_VERSION,
    INSURANCE_PRODUCTS,
    getProduct,
} from '@/lib/insurance';
import { listInsuranceProducts } from '@/app-layer/usecases/insurance';
import { makeRequestContext } from '../../helpers/make-context';
import en from '../../../messages/en.json';
import bg from '../../../messages/bg.json';

const CTX = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tenant.findUnique.mockResolvedValue({ currencySymbol: '€' });
});

describe('the catalogue cannot disagree with the engine', () => {
    it('returns every product the engine knows, and no others', async () => {
        const { products } = await listInsuranceProducts(CTX, 'en');
        expect(products.map((p) => p.key).sort()).toEqual(
            INSURANCE_PRODUCTS.map((p) => p.key).sort(),
        );
    });

    it('carries each product\'s OWN tariff, read from the engine', async () => {
        const { products } = await listInsuranceProducts(CTX, 'en');
        for (const p of products) {
            // Derived, not restated: if a product's tariff changes, this test
            // follows it instead of blocking the change.
            expect(p.tariffBp).toBe(getProduct(p.key)!.tariffBp);
        }
        // …and a tariff is basis points, which is the unit the preview must use.
        expect(products.every((p) => Number.isInteger(p.tariffBp) && p.tariffBp > 0)).toBe(true);
    });

    it('states the engine version the tariffs belong to', async () => {
        const { engineVersion } = await listInsuranceProducts(CTX, 'en');
        // How a client notices its local arithmetic has gone stale.
        expect(engineVersion).toBe(INSURANCE_ENGINE_VERSION);
    });

    it('marks crops and perils apart, since only crops map from a cropType', async () => {
        const { products } = await listInsuranceProducts(CTX, 'en');
        for (const p of products) {
            expect(p.kind).toBe(getProduct(p.key)!.kind);
            // A peril insures against weather, so it has no commodity to match.
            if (p.kind === 'peril') expect(p.commodity).toBeUndefined();
        }
        expect(products.filter((p) => p.kind === 'crop').length).toBeGreaterThan(1);
        expect(products.filter((p) => p.kind === 'peril').length).toBeGreaterThan(1);
    });
});

describe('copy is resolved server-side, so it cannot drift either', () => {
    it('answers in English when asked', async () => {
        const { products } = await listInsuranceProducts(CTX, 'en');
        const wheat = products.find((p) => p.key === 'wheat')!;
        expect(wheat.name).toBe(en.insurance.products.wheat.name);
        expect(wheat.blurb).toBe(en.insurance.products.wheat.blurb);
    });

    it('answers in Bulgarian when asked, which is what most farmers see', async () => {
        const { products } = await listInsuranceProducts(CTX, 'bg');
        const wheat = products.find((p) => p.key === 'wheat')!;
        expect(wheat.name).toBe(bg.insurance.products.wheat.name);
        expect(wheat.blurb).toBe(bg.insurance.products.wheat.blurb);
        // Not the English string, and not the key path — a missing translation
        // resolves to its own key, which would look plausible in a diff.
        expect(wheat.name).not.toBe(en.insurance.products.wheat.name);
        expect(wheat.name).not.toContain('insurance.products');
    });

    it('resolves copy for EVERY product in both locales', async () => {
        // The catalogue is only useful if no entry comes back as its key path.
        for (const locale of ['en', 'bg'] as const) {
            const { products } = await listInsuranceProducts(CTX, locale);
            for (const p of products) {
                expect(p.name).not.toContain('insurance.products');
                expect(p.blurb).not.toContain('insurance.products');
                expect(p.name.length).toBeGreaterThan(1);
                expect(p.blurb.length).toBeGreaterThan(1);
            }
        }
    });
});

describe('the tenant context travels with it', () => {
    it('returns the tenant\'s own currency symbol, saving a round trip', async () => {
        mockDb.tenant.findUnique.mockResolvedValue({ currencySymbol: 'лв.' });
        const { currencySymbol } = await listInsuranceProducts(CTX, 'bg');
        expect(currencySymbol).toBe('лв.');
    });

    it('falls back to € rather than returning nothing formattable', async () => {
        mockDb.tenant.findUnique.mockResolvedValue(null);
        expect((await listInsuranceProducts(CTX, 'en')).currencySymbol).toBe('€');
    });
});
