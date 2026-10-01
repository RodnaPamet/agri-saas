/**
 * `/api/auth/me` really emits `featureFlags` — asserted on the RESPONSE.
 *
 * The OpenAPI snapshot already covers the contract, and that is not the same
 * thing: a spec can be correct while the handler omits the field, and the
 * snapshot would stay green because it describes `account.paths.ts` rather than
 * what the route returns. The only existing test touching this endpoint
 * (`membership-identity`) reads the route's SOURCE TEXT, which cannot catch a
 * field dropped by a later refactor either.
 *
 * The iOS client consumes this field. A contract nothing executes is a promise,
 * so this executes it.
 */
const mockUser = {
    id: 'u-me',
    email: 'me@example.test',
    name: 'Me',
    bottomTabOrder: null as string[] | null,
    tenantMemberships: [] as Array<{ role: string; tenant: { id: string; name: string; slug: string } }>,
};
const mockFlagRows: Array<{ key: string; enabled: boolean; cohorts: string[] }> = [];
const mockCohortRows: Array<{ cohortKey: string }> = [];

jest.mock('@/auth', () => ({
    auth: jest.fn(async () => ({ user: { id: 'u-me' } })),
}));

jest.mock('@/lib/prisma', () => {
    const client = {
        user: { findUnique: jest.fn(async () => mockUser) },
        featureFlag: { findMany: jest.fn(async () => mockFlagRows) },
        featureFlagCohortMember: { findMany: jest.fn(async () => mockCohortRows) },
    };
    return { __esModule: true, default: client, prisma: client };
});

// No Redis: the resolver must read the database and still answer correctly.
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/me/route';

const ROUTE_CTX = { params: Promise.resolve({}) } as never;
const call = async () => {
    // NextRequest, not Request: withApiErrorHandling reads `req.nextUrl.pathname`.
    const res = await GET(new NextRequest('http://localhost/api/auth/me') as never, ROUTE_CTX);
    return (await (res as Response).json()) as Record<string, unknown>;
};

describe('/api/auth/me emits featureFlags', () => {
    beforeEach(() => {
        mockFlagRows.length = 0;
        mockCohortRows.length = 0;
        delete process.env.FEATURE_FLAGS_FORCE_OFF;
    });

    it('carries the key even when no flag exists — as an EMPTY OBJECT, not undefined', async () => {
        const body = await call();
        // The distinction the client depends on: iOS treats an absent
        // `featureFlags` and `{}` the same (both off), but a missing key would
        // also hide a server-side regression, so the field must be present.
        expect(Object.hasOwn(body, 'featureFlags')).toBe(true);
        expect(body.featureFlags).toEqual({});
    });

    it('resolves a flag through to the response', async () => {
        mockFlagRows.push({ key: 'social.profiles', enabled: true, cohorts: [] });
        expect((await call()).featureFlags).toEqual({ 'social.profiles': true });
    });

    it('narrows a cohort-gated flag for a caller who is not in the cohort', async () => {
        // The property that keeps a limited rollout limited, asserted end to end
        // rather than only in the resolver's own unit test.
        mockFlagRows.push({ key: 'social.dm', enabled: true, cohorts: ['beta'] });
        expect((await call()).featureFlags).toEqual({ 'social.dm': false });

        mockCohortRows.push({ cohortKey: 'beta' });
        expect((await call()).featureFlags).toEqual({ 'social.dm': true });
    });

    it('the kill switch empties the map in the RESPONSE', async () => {
        mockFlagRows.push({ key: 'social.profiles', enabled: true, cohorts: [] });
        process.env.FEATURE_FLAGS_FORCE_OFF = '1';
        expect((await call()).featureFlags).toEqual({});
        delete process.env.FEATURE_FLAGS_FORCE_OFF;
    });

    it('still carries the fields it carried before — featureFlags is additive', async () => {
        // A regression guard on the rest of the payload: adding a key must not
        // have displaced `user` or `tenant`, which every client reads at launch.
        const body = await call();
        expect(body.user).toMatchObject({ id: 'u-me', email: 'me@example.test' });
        expect(Object.hasOwn(body, 'tenant')).toBe(true);
    });
});
