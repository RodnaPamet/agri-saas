/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts; standard pattern for this surface. */

/**
 * An out-of-date native client must get a response it can ACT on.
 *
 * The point is not that old clients are refused — it is that the refusal is
 * DISTINGUISHABLE. An app receiving a generic 400 shows the operator a bug and
 * generates a support ticket; an app receiving `client_version_unsupported`
 * shows "please update" and links the store. So these tests assert the code and
 * the shape, not merely the status.
 *
 * Driven through the real `src/middleware.ts` — the harness `cors.test.ts`
 * established — because a unit test of `checkClientVersion` alone would prove
 * the predicate and not the enforcement.
 */
import { NextRequest } from 'next/server';
import {
    CLIENT_VERSION_HEADER,
    CLIENT_TOO_OLD_CODE,
    MINIMUM_SUPPORTED_CLIENT_VERSION,
} from '@/lib/api/contract-version';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ allowed: true, ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: (p: string) => (p.match(/^\/api\/t\/([^/]+)/)?.[1] ?? null),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

// The middleware's job is to ACT on the verdict, so the verdict is controlled
// here and the predicate is tested separately below with an injected floor.
// With the shipped floor at 1 and versions starting at 1, no real client can be
// too old yet — mocking is what lets the ENFORCEMENT be proven today rather
// than at the first deprecation, when it would be too late to discover it never
// worked.
const clientVerdict = jest.fn();
jest.mock('@/lib/api/contract-version', () => {
    const actual = jest.requireActual('@/lib/api/contract-version');
    return { ...actual, checkClientVersion: (...a: any[]) => clientVerdict(...a) };
});

import middleware from '../../src/middleware';

function apiReq(version?: string) {
    const headers: Record<string, string> = {};
    if (version !== undefined) headers[CLIENT_VERSION_HEADER] = version;
    return new NextRequest('http://localhost:3000/api/t/acme-corp/tasks', {
        method: 'GET',
        headers,
    });
}

beforeEach(() => {
    getToken.mockReset();
    clientVerdict.mockReset();
    clientVerdict.mockReturnValue({ ok: true, clientVersion: null });
    getToken.mockResolvedValue({
        userId: 'u1', sub: 'u1', tenantSlug: 'acme-corp', role: 'ADMIN',
        memberships: [{ slug: 'acme-corp' }],
    });
});

describe('an under-minimum client gets the DISTINCT response', () => {
    it('returns 426 with the machine-readable code, not a generic error', async () => {
        clientVerdict.mockReturnValue({ ok: false, clientVersion: 1 });
        const res = await middleware(apiReq('1'), {} as any);
        expect(res.status).toBe(426);

        const body = await res.json();
        // The code is the contract. An app branches on THIS, not on prose.
        expect(body.error).toBe(CLIENT_TOO_OLD_CODE);
        expect(body.minimumSupportedVersion).toBe(MINIMUM_SUPPORTED_CLIENT_VERSION);
        expect(typeof body.message).toBe('string');
    });

    it('is NOT a 400 — an app must be able to tell "update me" from "you have a bug"', async () => {
        clientVerdict.mockReturnValue({ ok: false, clientVersion: 1 });
        const res = await middleware(apiReq('1'), {} as any);
        expect(res.status).not.toBe(400);
        expect(res.status).not.toBe(500);
    });
});

describe('the gate does not refuse traffic it should not', () => {
    it('a CURRENT client passes', async () => {
        const res = await middleware(apiReq(String(MINIMUM_SUPPORTED_CLIENT_VERSION)), {} as any);
        expect(res.status).not.toBe(426);
    });

    it('a NEWER client passes — the server never refuses the future', async () => {
        const res = await middleware(apiReq(String(MINIMUM_SUPPORTED_CLIENT_VERSION + 5)), {} as any);
        expect(res.status).not.toBe(426);
    });

    it('NO header passes — the web client ships with the server and cannot be stale', async () => {
        const res = await middleware(apiReq(undefined), {} as any);
        expect(res.status).not.toBe(426);
    });

    it('a GARBLED header passes, rather than turning a proxy quirk into an outage', async () => {
        for (const junk of ['abc', '', '-3', 'v2']) {
            const res = await middleware(apiReq(junk), {} as any);
            expect(res.status).not.toBe(426);
        }
    });
});

describe('checkClientVersion — the predicate itself', () => {
    it('treats absent and unparseable identically', () => {
        const actual = jest.requireActual('@/lib/api/contract-version');
        expect(actual.checkClientVersion(null)).toEqual({ ok: true, clientVersion: null });
        expect(actual.checkClientVersion('nonsense')).toEqual({ ok: true, clientVersion: null });
    });

    it('compares against the floor, inclusively', () => {
        // Injected floor, because the shipped one is 1 and versions start at 1
        // — so nothing is deprecated yet and "too old" is not otherwise
        // representable. Testing the comparison now means the first real
        // deprecation is not also the first time this code runs.
        const actual = jest.requireActual('@/lib/api/contract-version');
        expect(actual.checkClientVersion('3', 3).ok).toBe(true);
        expect(actual.checkClientVersion('4', 3).ok).toBe(true);
        expect(actual.checkClientVersion('2', 3).ok).toBe(false);
        expect(actual.checkClientVersion('2', 3).clientVersion).toBe(2);
    });
});
