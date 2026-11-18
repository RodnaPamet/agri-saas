/**
 * #3186 — the MFA challenge is verified against the farm named in the URL.
 *
 * It read `session.user.tenantId` (the primary farm), so a person whose
 * non-primary farm REQUIRES a factor could never clear it.
 */
import { NextRequest } from 'next/server';

jest.mock('@/auth', () => ({
    auth: jest.fn(async () => ({ user: { id: 'u1', tenantId: 't-primary' } })),
}));
const findFirst = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = { tenantMembership: { findFirst: (...a: unknown[]) => findFirst(...a) } };
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/security/rate-limit-middleware', () => ({
    ...jest.requireActual('@/lib/security/rate-limit-middleware'),
    checkRateLimitDistributed: jest.fn(async () => ({ allowed: true, remaining: 4, retryAfterMs: 0 })),
    resetRateLimitDistributed: jest.fn(async () => undefined),
}));
const verifyMfaChallenge = jest.fn();
jest.mock('@/app-layer/usecases/mfa-challenge', () => ({
    // The REAL farm resolution (it reads the mocked prisma above); only the
    // TOTP check is a double.
    resolveChallengeTenantId: jest.requireActual('@/app-layer/usecases/mfa-challenge').resolveChallengeTenantId,
    verifyMfaChallenge: (...a: unknown[]) => verifyMfaChallenge(...a),
}));

import { POST } from '@/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route';

function call(slug: string) {
    return POST(
        new NextRequest(`http://localhost/api/t/${slug}/security/mfa/challenge/verify`, {
            method: 'POST',
            body: JSON.stringify({ code: '123456' }),
            headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ tenantSlug: slug }) },
    );
}

describe('MFA challenge verify (#3186)', () => {
    beforeEach(() => {
        findFirst.mockReset();
        verifyMfaChallenge.mockReset();
        verifyMfaChallenge.mockResolvedValue({ success: true, message: 'ok' });
    });

    it('verifies against the farm in the URL, not the primary one', async () => {
        findFirst.mockResolvedValue({ tenantId: 't-second' });

        const res = await call('second-farm');

        expect(res.status).toBe(200);
        expect(verifyMfaChallenge).toHaveBeenCalledWith('u1', 't-second', '123456', 4);
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ userId: 'u1', status: 'ACTIVE', tenant: expect.objectContaining({ slug: 'second-farm' }) }),
        }));
    });

    it('refuses a farm the caller is not an ACTIVE member of, without verifying anything', async () => {
        findFirst.mockResolvedValue(null);

        const res = await call('somebody-elses-farm');

        expect(res.status).toBe(400);
        expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });
});
