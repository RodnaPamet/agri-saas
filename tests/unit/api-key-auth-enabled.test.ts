/**
 * API-key authentication is ON — proved by running it, not by reading it.
 *
 * `tests/guards/api-key-auth-enabled.test.ts` asserts the switch is wired into
 * the right places by scanning source text. It cannot show what context a
 * caller actually ends up with. This file does.
 *
 * ## What changed, and what deliberately did not
 *
 * `tryApiKeyAuth` returns a context that REPLACES the session's: `tenantId`
 * and `tenantSlug` come from the KEY and `role` is re-derived from its SCOPES.
 * While the switch was off that path was dead, and this file asserted the key
 * was ignored entirely.
 *
 * With the switch on the key context is the point — but the two protections
 * written while it was dead are what make it safe, and they are asserted here
 * because they are the ones a revival would quietly drop:
 *
 *   - the key's tenant must equal the tenant in the URL, or a request to
 *     tenant A's URL executes against tenant B's data;
 *   - `getLegacyCtx` must not attempt key auth at all, because it has no slug
 *     to compare the key's tenant against.
 *
 * And the gate added to turn it on: a key may only reach the path family its
 * scopes name. Without it, any `:write` scope made the key an EDITOR and
 * `assertCanWrite` — the gate ~250 of the 273 tenant routes use — let it write
 * everything.
 */
import { NextRequest } from 'next/server';

const getSessionOrThrow = jest.fn();
jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    getSessionOrThrow: (...a: unknown[]) => getSessionOrThrow(...a),
}));

const resolveTenantContext = jest.fn();
jest.mock('@/lib/tenant-context', () => ({
    ...jest.requireActual('@/lib/tenant-context'),
    resolveTenantContext: (...a: unknown[]) => resolveTenantContext(...a),
}));

const verifyApiKey = jest.fn();
jest.mock('@/lib/auth/api-key-auth', () => ({
    ...jest.requireActual('@/lib/auth/api-key-auth'),
    verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
}));

import { API_KEY_AUTH_ENABLED } from '@/lib/auth/api-key-availability';

describe('the switch itself', () => {
    it('is on', () => {
        expect(API_KEY_AUTH_ENABLED).toBe(true);
    });
});

describe('a request carrying an API key', () => {
    const SESSION_CTX = {
        tenant: { id: 'tnt_session', slug: 'acme-corp' },
        role: 'READER',
        permissions: {},
        appPermissions: {},
    };

    function keyCtx(over: Record<string, unknown> = {}) {
        return {
            requestId: 'r',
            userId: 'usr_keycreator',
            tenantId: 'tnt_acme',
            tenantSlug: 'acme-corp',
            role: 'EDITOR',
            permissions: {},
            appPermissions: {},
            apiKeyId: 'key_1',
            apiKeyScopes: ['journal:read'],
            ...over,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        getSessionOrThrow.mockResolvedValue({ userId: 'usr_session', tenantId: 'tnt_session' });
        resolveTenantContext.mockResolvedValue(SESSION_CTX);
        verifyApiKey.mockResolvedValue({ valid: true, ctx: keyCtx() });
    });

    function req(path = '/api/t/acme-corp/journal', method = 'GET') {
        return new NextRequest(`http://localhost:3000${path}`, {
            method,
            headers: { authorization: 'Bearer iflk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        });
    }

    it('resolves the KEY context, and actually verifies the key', async () => {
        const { getTenantCtx } = await import('@/app-layer/context');
        const ctx = await getTenantCtx({ tenantSlug: 'acme-corp' }, req());

        expect(verifyApiKey).toHaveBeenCalled();
        expect(ctx.userId).toBe('usr_keycreator');
        expect(ctx.tenantId).toBe('tnt_acme');
        expect(ctx.apiKeyId).toBe('key_1');
    });

    it('refuses a key whose tenant is not the tenant in the URL', async () => {
        // The escalation the tenant comparison exists to stop: without it the
        // returned context replaces the session's wholesale, so a request to
        // acme-corp's URL would run against the key's tenant.
        verifyApiKey.mockResolvedValue({
            valid: true,
            ctx: keyCtx({ tenantId: 'tnt_other', tenantSlug: 'other-tenant' }),
        });
        const { getTenantCtx } = await import('@/app-layer/context');
        await expect(
            getTenantCtx({ tenantSlug: 'acme-corp' }, req()),
        ).rejects.toThrow(/does not belong to this tenant/i);
    });

    it('refuses a path family the key has no scope for', async () => {
        // A `journal:read` key reaching for field operations. Before the gate,
        // any `:write` scope made the key an EDITOR and `assertCanWrite` let it
        // write every resource in the tenant.
        const { getTenantCtx } = await import('@/app-layer/context');
        await expect(
            getTenantCtx({ tenantSlug: 'acme-corp' }, req('/api/t/acme-corp/field-operations')),
        ).rejects.toThrow(/scope/i);
    });

    it('refuses a WRITE when the key holds only read on that family', async () => {
        // The action half. Same family, same key, different method.
        const { getTenantCtx } = await import('@/app-layer/context');
        await expect(
            getTenantCtx({ tenantSlug: 'acme-corp' }, req('/api/t/acme-corp/journal', 'POST')),
        ).rejects.toThrow(/scope/i);
    });

    it('allows the family and action the scope actually names', async () => {
        // The positive control. Without it every assertion above would pass on
        // a gate that refuses everything.
        const { getTenantCtx } = await import('@/app-layer/context');
        const ctx = await getTenantCtx({ tenantSlug: 'acme-corp' }, req());
        expect(ctx.apiKeyId).toBe('key_1');
    });

    it('legacy routes do not attempt key auth at all', async () => {
        // getLegacyCtx has no tenantSlug to compare a key against, so it must
        // not try — there would be nothing to check the key's tenant against.
        const { getLegacyCtx } = await import('@/app-layer/context');
        const ctx = await getLegacyCtx(req());
        expect(ctx.tenantId).toBe('tnt_session');
        expect(verifyApiKey).not.toHaveBeenCalled();
    });
});
