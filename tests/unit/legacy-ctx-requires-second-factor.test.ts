/**
 * #3198 — `getLegacyCtx` asks for the second factor exactly as `getTenantCtx`
 * does.
 *
 * `getLegacyCtx` backs the slug-less routes (`/api/sso`, `/api/evidence*`,
 * `/api/audit-log`, `/api/notifications*`), and the Edge MFA gate ranges over
 * tenant and person paths only — so this resolver is the ONLY place those
 * routes can refuse a session that presented a password and no TOTP. Before
 * the fix, such a session could `POST /api/sso` and register an identity
 * provider on a farm whose policy is REQUIRED.
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

import { getLegacyCtx } from '@/app-layer/context';

const TENANT = { tenant: { id: 'tnt_primary', slug: 'farm-a' }, role: 'ADMIN', permissions: {}, appPermissions: {} };

function req() {
    return new NextRequest('http://localhost:3000/api/sso', { method: 'POST' });
}

beforeEach(() => {
    getSessionOrThrow.mockReset();
    resolveTenantContext.mockReset();
    resolveTenantContext.mockResolvedValue(TENANT);
});

describe('getLegacyCtx — the second factor (#3198)', () => {
    it('REFUSES with MFA_REQUIRED when the primary farm is pending', async () => {
        getSessionOrThrow.mockResolvedValue({
            userId: 'u1', tenantId: 'tnt_primary', mfaPendingTenantIds: ['tnt_primary'],
        });

        await expect(getLegacyCtx(req())).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    });

    it('REFUSES on a truncated membership list with the session-wide flag set', async () => {
        getSessionOrThrow.mockResolvedValue({
            userId: 'u1', tenantId: 'tnt_primary', membershipsTruncated: true, mfaPending: true,
        });

        await expect(getLegacyCtx(req())).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    });

    it('control: a farm that owes nothing resolves normally', async () => {
        // Without this, a resolver that refused everybody would pass both cases above.
        getSessionOrThrow.mockResolvedValue({
            userId: 'u1', tenantId: 'tnt_primary', mfaPendingTenantIds: ['tnt_other'],
        });

        await expect(getLegacyCtx(req())).resolves.toMatchObject({ tenantId: 'tnt_primary' });
    });
});

describe('getLegacyCtx — the machine-operator lockdown (#3207)', () => {
    const OPERATOR = { tenant: { id: 'tnt_primary', slug: 'farm-a' }, role: 'MECHANISATOR', permissions: {}, appPermissions: {} };

    beforeEach(() => {
        getSessionOrThrow.mockResolvedValue({ userId: 'u1', tenantId: 'tnt_primary', mfaPendingTenantIds: [] });
    });

    it('REFUSES a MECHANISATOR on a slug-less route (evidence, audit log, SSO)', async () => {
        resolveTenantContext.mockResolvedValue(OPERATOR);
        await expect(getLegacyCtx(req())).rejects.toMatchObject({ code: 'OPERATOR_SCOPE' });
    });

    it('admits the operator on their own surfaces (the bell, the streams)', async () => {
        resolveTenantContext.mockResolvedValue(OPERATOR);
        await expect(getLegacyCtx(req(), { allowOperator: true })).resolves.toMatchObject({ role: 'MECHANISATOR' });
    });

    it('control: other roles are unaffected', async () => {
        resolveTenantContext.mockResolvedValue({ ...OPERATOR, role: 'READER' });
        await expect(getLegacyCtx(req())).resolves.toMatchObject({ role: 'READER' });
    });
});
