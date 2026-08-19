/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, Prisma); the file-level disable is this
 * codebase's standard pattern for these surfaces. */

/**
 * API-key authentication is off — proved by running it, not by reading it.
 *
 * `tests/guards/api-key-auth-disabled.test.ts` asserts the switch is wired
 * into the right places by scanning source text. It cannot show that a request
 * carrying an API key is actually refused, or that the context an operator
 * ends up with is their own. This file does.
 *
 * ## The case worth running
 *
 * `tryApiKeyAuth` returns a context that REPLACES the session's. `tenantId`
 * and `tenantSlug` come from the KEY, and `role` is re-derived from the key's
 * SCOPES (`scopes.includes('*')` → ADMIN). It runs BEFORE `getSessionOrThrow`.
 *
 * That path is unreachable from a machine client — the Edge refuses an
 * `iflk_` bearer before any handler — but it is reachable from a BROWSER that
 * carries both a session cookie (which satisfies the Edge on its own) and an
 * API-key header. In that case a request to tenant A's URL would execute
 * against the key's tenant, and a user demoted to READER who kept an old `*`
 * key would get an ADMIN-permission context. Nothing compared the key's tenant
 * to the URL's.
 *
 * So the assertions here are: the key is ignored, the SESSION context is what
 * comes back, and creation is refused with a body that says why.
 */
import { NextRequest } from 'next/server';

const getSessionOrThrow = jest.fn();
jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    getSessionOrThrow: (...a: any[]) => getSessionOrThrow(...a),
}));

const resolveTenantContext = jest.fn();
jest.mock('@/lib/tenant-context', () => ({
    ...jest.requireActual('@/lib/tenant-context'),
    resolveTenantContext: (...a: any[]) => resolveTenantContext(...a),
}));

const verifyApiKey = jest.fn();
jest.mock('@/lib/auth/api-key-auth', () => ({
    ...jest.requireActual('@/lib/auth/api-key-auth'),
    verifyApiKey: (...a: any[]) => verifyApiKey(...a),
}));

import { API_KEY_AUTH_ENABLED, API_KEY_DISABLED_MESSAGE } from '@/lib/auth/api-key-availability';

describe('the switch itself', () => {
    it('is off', () => {
        // If this ever flips, the rest of this file is describing the wrong
        // product — and tests/guards/api-key-auth-disabled.test.ts will have
        // demanded the Edge work first.
        expect(API_KEY_AUTH_ENABLED).toBe(false);
    });

    it('the refusal message diagnoses rather than just refusing', () => {
        // The failure being fixed is a credential that fails in a way
        // indistinguishable from a wrong one. A blank 410 repeats it.
        expect(API_KEY_DISABLED_MESSAGE).toMatch(/cannot authenticate/i);
        expect(API_KEY_DISABLED_MESSAGE).toMatch(/revoke/i);
    });
});

describe('a request carrying BOTH a session and an API key', () => {
    const SESSION_CTX = {
        tenant: { id: 'tnt_session', slug: 'acme-corp' },
        role: 'READER',
        permissions: {},
        appPermissions: {},
    };

    beforeEach(() => {
        jest.clearAllMocks();
        getSessionOrThrow.mockResolvedValue({ userId: 'usr_session', tenantId: 'tnt_session' });
        resolveTenantContext.mockResolvedValue(SESSION_CTX);
        // If the key path were live it would win, and it would hand back an
        // ADMIN context in a DIFFERENT tenant.
        verifyApiKey.mockResolvedValue({
            valid: true,
            ctx: {
                requestId: 'r',
                userId: 'usr_keycreator',
                tenantId: 'tnt_otherkey',
                tenantSlug: 'other-tenant',
                role: 'ADMIN',
                permissions: {},
                appPermissions: {},
            },
        });
    });

    function reqWithKey() {
        return new NextRequest('http://localhost:3000/api/t/acme-corp/journal', {
            method: 'GET',
            headers: { authorization: 'Bearer iflk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        });
    }

    it('resolves the SESSION context, not the key context', async () => {
        const { getTenantCtx } = await import('@/app-layer/context');
        const ctx = await getTenantCtx({ tenantSlug: 'acme-corp' }, reqWithKey());

        expect(ctx.userId).toBe('usr_session');
        expect(ctx.tenantId).toBe('tnt_session');
        expect(ctx.tenantSlug).toBe('acme-corp');
        // The escalation: a READER holding an old `*` key must not become ADMIN.
        expect(ctx.role).toBe('READER');
    });

    it('never even verifies the key while the switch is off', async () => {
        // Not just "the result is ignored" — the key is not looked up at all,
        // so a stale key cannot influence lastUsedAt, audit rows, or timing.
        const { getTenantCtx } = await import('@/app-layer/context');
        await getTenantCtx({ tenantSlug: 'acme-corp' }, reqWithKey());
        expect(verifyApiKey).not.toHaveBeenCalled();
    });

    it('legacy routes do not attempt key auth at all', async () => {
        // getLegacyCtx has no tenantSlug to compare a key against, so it must
        // not try — there would be nothing to check the key's tenant against.
        const { getLegacyCtx } = await import('@/app-layer/context');
        const ctx = await getLegacyCtx(reqWithKey());
        expect(ctx.tenantId).toBe('tnt_session');
        expect(verifyApiKey).not.toHaveBeenCalled();
    });
});
