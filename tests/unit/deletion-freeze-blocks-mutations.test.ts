/**
 * #1655 — "no new content" while a deletion is pending, at the choke point.
 *
 * ## The claim this exists to make true
 *
 * `privacy.deleteRequest` says, in both locales, that asking to be deleted
 * stops the account straight away. Before this, requesting deletion wrote
 * `deletionRequestedAt`, bumped `sessionVersion` and revoked sessions — and
 * nothing read that column outside the erasure path, so signing back in
 * restored full write access for the whole 30 days.
 *
 * ## The two assertions that carry the weight are the NEGATIVE ones
 *
 * A test that only checked "a frozen account is refused" would pass a
 * catastrophic version of this feature: one that also refuses
 * `DELETE /api/account/deletion`, trapping the person inside the freeze with
 * no way out. That is `slow-mode-escape-is-not-throttled`'s failure, and the
 * reason the exemption is a PREFIX rule rather than nine per-route flags —
 * nine remembered flags is nine chances to trap somebody.
 */
beforeEach(() => {
    jest.resetModules();
    process.env.RATE_LIMIT_ENABLED = '0';
});

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

const isDeletionPending = jest.fn();
jest.mock('@/lib/auth/deletion-pending', () => ({
    isDeletionPending: (...a: unknown[]) => isDeletionPending(...a),
    invalidateDeletionPendingCache: jest.fn(),
    DELETION_PENDING_CACHE_TTL: 30,
}));

jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';

const ok = async () => new Response('{"ok":true}', { status: 200 });

function req(path: string, method = 'POST'): NextRequest {
    return new NextRequest(`https://app.agrent.bg${path}`, {
        method,
        headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' },
    });
}

async function call(path: string, method = 'POST') {
    const handler = withApiErrorHandling(ok);
    return handler(req(path, method), { params: Promise.resolve({}) });
}

beforeEach(() => {
    getToken.mockReset();
    getToken.mockResolvedValue({ sub: 'u-frozen', userId: 'u-frozen' });
    isDeletionPending.mockReset();
    isDeletionPending.mockResolvedValue(true);
});

describe('a frozen account cannot create content', () => {
    it('refuses a farm mutation with ACCOUNT_DELETION_PENDING', async () => {
        const res = await call('/api/t/acme/journal');

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        // A DISTINCT code. Telling somebody who asked to leave that their
        // account is SUSPENDED would name a moderator action that never
        // happened, and point them at an appeal rather than at the cancel.
        expect(body.error?.code).toBe('ACCOUNT_DELETION_PENDING');
    });

    it('refuses every mutation verb, not just POST', async () => {
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const res = await call('/api/t/acme/farm-tasks/x', m);
            expect(res.status).toBe(403);
        }
    });

    it('does NOT refuse a READ', async () => {
        // The ruling is "no new content", not "no access". A person deciding
        // whether to recover their account can still look at their farm, and
        // Art 15 does not lapse because Art 17 was invoked.
        const res = await call('/api/t/acme/journal', 'GET');

        expect(res.status).toBe(200);
        expect(isDeletionPending).not.toHaveBeenCalled();
    });
});

describe('the way OUT is never frozen', () => {
    it('allows DELETE /api/account/deletion — the cancel', async () => {
        // THE ASSERTION THAT MATTERS MOST. If this ever fails, a person who
        // asked to be deleted can no longer change their mind.
        const res = await call('/api/account/deletion', 'DELETE');

        expect(res.status).toBe(200);
    });

    it('allows POST /api/account/deletion — asking again is idempotent', async () => {
        const res = await call('/api/account/deletion');

        expect(res.status).toBe(200);
    });

    it('allows the auth lifecycle: logout, token, refresh, native sign-in', async () => {
        // Nine wrapped mutation routes would otherwise each need to remember an
        // opt-out. A forgotten one does not fail a test — it strands a person,
        // which is why the exemption is a prefix and these are asserted as a
        // group.
        for (const p of [
            '/api/auth/logout',
            '/api/auth/token',
            '/api/auth/token/refresh',
            '/api/auth/native/exchange',
            '/api/auth/native/apple',
            '/api/auth/native/mfa',
            '/api/auth/native/revoke',
            '/api/auth/change-password',
            '/api/auth/accept-terms',
        ]) {
            const res = await call(p);
            expect({ path: p, status: res.status }).toEqual({ path: p, status: 200 });
        }
    });

    it('allows the account surface: profile, language, avatar', async () => {
        for (const p of [
            '/api/account/profile',
            '/api/account/language',
            '/api/account/bottom-tabs',
            '/api/account/avatar',
        ]) {
            const res = await call(p, 'PUT');
            expect({ path: p, status: res.status }).toEqual({ path: p, status: 200 });
        }
    });

    it('does not exempt a path that merely STARTS LIKE an exempt prefix', async () => {
        // The trailing slash in the prefix list. `/api/accountsomething` is a
        // different surface and must not inherit the exemption — the
        // `PUBLIC_PATH_PREFIXES` convention, for the same reason.
        const res = await call('/api/accountsomething/create');

        expect(res.status).toBe(403);
    });
});

describe('it is a statement about an ACCOUNT', () => {
    it('does not refuse an anonymous caller', async () => {
        // No account, so no freeze. Applying it to an unreadable caller would
        // refuse by IP, which is a statement about a village behind one NAT.
        getToken.mockResolvedValue(null);

        const res = await call('/api/t/acme/journal');

        expect(res.status).toBe(200);
    });

    it('lets a healthy account through, and still ASKS', async () => {
        isDeletionPending.mockResolvedValue(false);

        const res = await call('/api/t/acme/journal');

        expect(res.status).toBe(200);
        // Asked, not skipped — a check that is never reached is the defect one
        // level up from a check that answers wrongly.
        expect(isDeletionPending).toHaveBeenCalledWith('u-frozen');
    });
});
