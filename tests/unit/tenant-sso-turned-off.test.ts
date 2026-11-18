/**
 * Tenant SAML / OIDC SSO and SCIM are TURNED OFF (owner ruling 2026-11-18):
 * dormant, not removed. Every entry point answers 404 while its flag is off.
 *
 * The flag store is the only double for the gate itself — the real
 * `tenant-sso-availability` module runs, so a route that stopped calling it,
 * or a helper that read the wrong key, fails here. Each case also asserts the
 * work behind the gate did NOT start, because a 404 that arrived after the
 * IdP exchange or the token lookup would be the switch failing late.
 */
const mockFlagOn = jest.fn(async (_key: string, _userId: string | null) => false);
jest.mock('@/lib/feature-flags', () => ({
    ...jest.requireActual('@/lib/feature-flags'),
    isFeatureEnabled: (key: string, userId: string | null) => mockFlagOn(key, userId),
}));

const mockFindProvider = jest.fn();
const mockFindToken = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantIdentityProvider: { findFirst: mockFindProvider, findUnique: mockFindProvider },
        tenantScimToken: { findUnique: mockFindToken },
        tenant: { findUnique: jest.fn() },
    },
    prisma: {
        tenantIdentityProvider: { findFirst: mockFindProvider, findUnique: mockFindProvider },
        tenantScimToken: { findUnique: mockFindToken },
        tenant: { findUnique: jest.fn() },
    },
}));

import { NextRequest } from 'next/server';

import { FLAG_KEY_PATTERN } from '@/lib/feature-flags';
import { SCIM_FLAG, TENANT_SSO_FLAG } from '@/lib/auth/tenant-sso-availability';

const BASE = 'http://localhost:3006';

beforeEach(() => {
    mockFlagOn.mockReset().mockResolvedValue(false);
    mockFindProvider.mockReset();
    mockFindToken.mockReset();
});

describe('tenant SSO is off: the SAML / OIDC flow answers 404 before any work', () => {
    it('OIDC start', async () => {
        const { GET } = await import('@/app/api/auth/sso/oidc/start/route');
        const res = await GET(new NextRequest(`${BASE}/api/auth/sso/oidc/start?tenant=acme&provider=p1`), {} as never);
        expect(res.status).toBe(404);
        expect(mockFindProvider).not.toHaveBeenCalled();
    });

    it('SAML start', async () => {
        const { GET } = await import('@/app/api/auth/sso/saml/start/route');
        const res = await GET(new NextRequest(`${BASE}/api/auth/sso/saml/start?tenant=acme&provider=p1`), {} as never);
        expect(res.status).toBe(404);
        expect(mockFindProvider).not.toHaveBeenCalled();
    });

    it('OIDC callback, even carrying a code and state', async () => {
        const { GET } = await import('@/app/api/auth/sso/oidc/callback/route');
        const res = await GET(new NextRequest(`${BASE}/api/auth/sso/oidc/callback?code=c&state=s`));
        expect(res.status).toBe(404);
        expect(mockFindProvider).not.toHaveBeenCalled();
    });

    it('SAML callback', async () => {
        const { POST } = await import('@/app/api/auth/sso/saml/callback/route');
        const res = await POST(
            new NextRequest(`${BASE}/api/auth/sso/saml/callback`, {
                method: 'POST',
                body: new URLSearchParams({ SAMLResponse: 'x', RelayState: 'y' }),
            }),
        );
        expect(res.status).toBe(404);
        expect(mockFindProvider).not.toHaveBeenCalled();
    });

    it('asks for exactly the tenant-SSO key, with no user', async () => {
        const { GET } = await import('@/app/api/auth/sso/oidc/callback/route');
        await GET(new NextRequest(`${BASE}/api/auth/sso/oidc/callback?code=c&state=s`));
        expect(mockFlagOn).toHaveBeenCalledWith('auth.tenant-sso', null);
    });
});

describe('SCIM is off: the provisioning surface answers 404', () => {
    it('ServiceProviderConfig does not advertise capabilities', async () => {
        const { GET } = await import('@/app/api/scim/v2/ServiceProviderConfig/route');
        const res = await GET(new NextRequest(`${BASE}/api/scim/v2/ServiceProviderConfig`));
        expect(res.status).toBe(404);
        expect(mockFlagOn).toHaveBeenCalledWith('auth.scim', null);
    });

    it('Users refuses a bearer without looking the token up', async () => {
        const { GET } = await import('@/app/api/scim/v2/Users/route');
        const res = await GET(
            new NextRequest(`${BASE}/api/scim/v2/Users`, { headers: { authorization: 'Bearer anything' } }),
        );
        expect(res.status).toBe(404);
        expect(mockFindToken).not.toHaveBeenCalled();
    });
});

describe('control: the same entry point is reachable once its flag is on', () => {
    it('ServiceProviderConfig answers 200 with auth.scim on', async () => {
        mockFlagOn.mockImplementation(async (key) => key === 'auth.scim');
        const { GET } = await import('@/app/api/scim/v2/ServiceProviderConfig/route');
        const res = await GET(new NextRequest(`${BASE}/api/scim/v2/ServiceProviderConfig`));
        expect(res.status).toBe(200);
    });

    it('tenant SSO staying off does not turn SCIM off, and vice versa — two separate keys', () => {
        expect(TENANT_SSO_FLAG).not.toBe(SCIM_FLAG);
    });
});

describe('both keys can be opened from the flag console', () => {
    // The console validates writes against FLAG_KEY_PATTERN; a gate on a key
    // the console refuses is a surface with no way back on.
    it.each([TENANT_SSO_FLAG, SCIM_FLAG])('%s matches FLAG_KEY_PATTERN', (key) => {
        expect(key).toMatch(FLAG_KEY_PATTERN);
    });
});
