/**
 * `GET /api/t/[tenantSlug]/search?q=...`
 *
 * Mocks `getTenantCtx` + the `getUnifiedSearch` usecase. Asserts:
 *   - 200 + payload propagation on the happy path
 *   - q + limit query params are parsed and forwarded
 *   - default per-type limit applied when none supplied
 *   - over-the-ceiling limits are clamped to 25
 *   - 403 when policy denies
 *   - empty q handed through (usecase decides — empty response)
 */

import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const getSearchMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/search', () => ({
    __esModule: true,
    getUnifiedSearch: (...a: unknown[]) => getSearchMock(...a),
}));

import { GET } from '@/app/api/t/[tenantSlug]/search/route';
import { forbidden } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

function ctxFor(role: Role | null) {
    return {
        tenantId: 'tenant-1',
        userId: 'user-1',
        requestId: 'req',
        tenantSlug: 'acme',
        role,
        permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        appPermissions: role ? getPermissionsForRole(role) : undefined,
    };
}

function req(qs: string = ''): NextRequest {
    return new NextRequest(`http://localhost/api/t/acme/search${qs}`, { method: 'GET' });
}

const samplePayload = {
    hits: [
        {
            type: 'practice',
            id: 'c1',
            title: 'A.5.1 — Information security policies',
            subtitle: null,
            badge: 'IMPLEMENTED',
            href: '/t/acme/practices/c1',
            score: 104,
            iconKey: 'shield-check',
            category: 'Practices',
        },
    ],
    meta: {
        query: 'policy',
        perTypeCounts: { practice: 1, risk: 0, policy: 0, evidence: 0, framework: 0 },
        truncated: false,
        perTypeLimit: 5,
    },
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getSearchMock.mockReset();
});

describe('GET /api/t/[tenantSlug]/search', () => {
    it('returns 200 + the typed payload on the happy path', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue(samplePayload);

        const res = await GET(req('?q=policy'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(samplePayload);
        expect(getSearchMock).toHaveBeenCalledTimes(1);
        expect(getSearchMock.mock.calls[0][1]).toBe('policy');
    });

    it('uses the default per-type limit when ?limit= is absent', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue(samplePayload);

        await GET(req('?q=phishing'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        const opts = getSearchMock.mock.calls[0][2];
        expect(opts.perTypeLimit).toBe(5);
    });

    it('forwards a valid ?limit= value', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue(samplePayload);

        await GET(req('?q=phish&limit=10'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        const opts = getSearchMock.mock.calls[0][2];
        expect(opts.perTypeLimit).toBe(10);
    });

    it('clamps over-ceiling limits to 25', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue(samplePayload);

        await GET(req('?q=phish&limit=999'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        const opts = getSearchMock.mock.calls[0][2];
        expect(opts.perTypeLimit).toBe(25);
    });

    it('falls back to default when ?limit= is invalid (non-numeric or zero)', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue(samplePayload);

        await GET(req('?q=phish&limit=oops'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        let opts = getSearchMock.mock.calls[0][2];
        expect(opts.perTypeLimit).toBe(5);

        getSearchMock.mockClear();
        await GET(req('?q=phish&limit=0'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        opts = getSearchMock.mock.calls[0][2];
        expect(opts.perTypeLimit).toBe(5);
    });

    it('passes empty q through (usecase decides on min-length response)', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockResolvedValue({ ...samplePayload, hits: [] });

        const res = await GET(req(''), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        expect(res.status).toBe(200);
        expect(getSearchMock.mock.calls[0][1]).toBe('');
    });

    it('returns 403 when the policy denies', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('READER'));
        getSearchMock.mockRejectedValue(forbidden('Authentication required'));

        const res = await GET(req('?q=anything'), { params: Promise.resolve({ tenantSlug: 'acme' }) });
        expect(res.status).toBe(403);
    });
});
