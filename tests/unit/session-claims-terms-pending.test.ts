/* eslint-disable @typescript-eslint/no-explicit-any -- the middleware harness
 * mirrors runtime contracts (NextRequest, getToken); the file-level disable is
 * this codebase's standard pattern for these harnesses. */

/**
 * Every HAND-MINTED session carries `termsPending`, so the consent gate can
 * hold it (P4.2, fixing a gap P3.1 left).
 *
 * ── the defect this pins ──
 *
 * The consent gate reads `token.termsPending === true`, and an ABSENT claim
 * reads as not-pending. That default is deliberate and right: sessions minted
 * before #1376 shipped carry no such claim, and treating absence as pending
 * would have locked every live session out mid-session.
 *
 * It is wrong for a token minted NOW. `buildSessionClaims` — the single
 * producer every hand-minted session goes through — never set the claim, so
 * FIVE paths produced a credential the gate could not hold:
 *
 *   * `establishSsoSession` (SAML and OIDC)
 *   * `POST /api/auth/native/exchange`
 *   * `GET  /api/auth/native/adopt`
 *   * `POST /api/auth/token/refresh`
 *   * `POST /api/auth/native/apple` (P4.2, which is how this was found)
 *
 * The refresh one is the worst, because it defeats the gate for a session the
 * gate DID hold: the browser's `jwt` callback sets the claim at sign-in, the
 * client exchanges for a token pair, and fifteen minutes later the refresh
 * rebuilds claims here and the hold is gone. The user was held, then quietly
 * released, with nothing in any log.
 *
 * ── why this runs against the real database ──
 *
 * The claim is `acceptedTermsAt == null` read from the User row. A mocked
 * Prisma would assert that a field is copied, which is not the thing that was
 * wrong — nothing read the column at all. So these create real rows.
 *
 * ── and why it then drives the REAL middleware ──
 *
 * A claim being present is not the property; the property is that the gate
 * refuses. Asserting only the field would pass for a claim the gate reads
 * under a different name, and "a complete mechanism severed at the Edge seam"
 * is a thing this codebase has shipped six times.
 */
import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({
    ...jest.requireActual('next-auth/jwt'),
    getToken: (...a: any[]) => getToken(...a),
}));

import { buildSessionClaims } from '@/auth';
import { hashForLookup } from '@/lib/security/encryption';
import prisma from '@/lib/prisma';
import middleware from '../../src/middleware';

const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
};
process.env.RATE_LIMIT_MODE = 'memory';
process.env.AUTH_TEST_MODE = '0';

const made: string[] = [];

async function makeUser(acceptedTermsAt: Date | null): Promise<string> {
    const email = `terms-claim-${randomUUID()}@example.test`;
    const user = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email), acceptedTermsAt },
        select: { id: true },
    });
    made.push(user.id);
    return user.id;
}

afterAll(async () => {
    if (made.length) {
        await prisma.user.deleteMany({ where: { id: { in: made } } });
    }
    for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('§1 the claim is produced from the column', () => {
    it('an unconsented user gets termsPending TRUE', async () => {
        const userId = await makeUser(null);
        const claims = await buildSessionClaims({
            userId,
            tenantId: null,
            userSessionId: 'sess-1',
        });
        expect(claims?.termsPending).toBe(true);
    });

    it('a consented user gets termsPending FALSE — the control', async () => {
        // Without this, a producer that hardcoded `true` would satisfy the
        // test above and hold every session in the product for ever.
        const userId = await makeUser(new Date('2026-01-01T00:00:00Z'));
        const claims = await buildSessionClaims({
            userId,
            tenantId: null,
            userSessionId: 'sess-2',
        });
        expect(claims?.termsPending).toBe(false);
    });

    it('is never ABSENT, which is the shape the gate cannot see', async () => {
        // The assertion that actually pins the defect. `=== true` means an
        // undefined claim passes the gate, so "false" and "missing" behave
        // identically TODAY and diverge the moment anybody tightens the gate
        // to treat absence as pending. Both must be booleans.
        for (const accepted of [null, new Date()]) {
            const userId = await makeUser(accepted);
            const claims = await buildSessionClaims({
                userId,
                tenantId: null,
                userSessionId: 'sess-3',
            });
            expect(typeof claims?.termsPending).toBe('boolean');
        }
    });
});

describe('§2 and the gate actually holds the resulting session', () => {
    function req(pathname: string): NextRequest {
        return new NextRequest(`http://localhost:3000${pathname}`, {
            headers: { 'x-forwarded-for': '203.0.113.77' },
        });
    }

    it('a session minted for an unconsented user is REFUSED', async () => {
        const userId = await makeUser(null);
        const claims = await buildSessionClaims({
            userId,
            tenantId: null,
            userSessionId: 'sess-4',
        });
        // The real claim object, not a hand-written one — the point is that
        // what the producer emits is what the gate reads.
        getToken.mockResolvedValue(claims);

        const res = await middleware(req('/api/me/profile') as any);
        expect(res.status).toBe(403);
    });

    it('a consented one is not — the control', async () => {
        const userId = await makeUser(new Date());
        const claims = await buildSessionClaims({
            userId,
            tenantId: null,
            userSessionId: 'sess-5',
        });
        getToken.mockResolvedValue(claims);

        const res = await middleware(req('/api/me/profile') as any);
        expect([302, 307, 403]).not.toContain(res.status);
    });

    it('the sign-in route stays reachable while pending', async () => {
        // A hold that also blocks the route that mints the session would make
        // Apple sign-in impossible for anybody who has not yet consented —
        // i.e. for every first-time user.
        const userId = await makeUser(null);
        const claims = await buildSessionClaims({
            userId,
            tenantId: null,
            userSessionId: 'sess-6',
        });
        getToken.mockResolvedValue(claims);

        const res = await middleware(req('/api/auth/native/apple') as any);
        expect(res.status).not.toBe(403);
    });
});
