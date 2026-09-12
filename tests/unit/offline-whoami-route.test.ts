/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror runtime
 * contracts; the codebase's standard file-level disable for test doubles. */
/**
 * GET /api/offline/whoami — executed, not grepped.
 *
 * The client half (`tests/unit/offline/whoami-probe.test.ts`) proves the three
 * outcomes are distinguished. This proves the endpoint actually produces the
 * two it controls, and that its answer can never be cached — which is the
 * property the whole design rests on.
 *
 * A cached answer re-creates precisely the defect the probe exists to escape:
 * `getCurrentUserId()` is untrustworthy because it belongs to a DOCUMENT the
 * service worker replays, and a probe served from any cache would inherit the
 * same flaw one layer down.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/offline/whoami/route';

// A NextRequest, not a bare Request: `withApiErrorHandling` reads
// `nextUrl.pathname` for its request-id logging, so a plain Request throws
// before the handler runs — a failure about the harness, not the route.
function req() {
    return new NextRequest('https://app.agrent.bg/api/offline/whoami', { method: 'GET' });
}

describe('GET /api/offline/whoami', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the verified user id', async () => {
        auth.mockResolvedValue({ user: { id: 'user-1' } });
        const res = await (GET as any)(req(), { params: Promise.resolve({}) });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ userId: 'user-1' });
    });

    it('is never cacheable', async () => {
        auth.mockResolvedValue({ user: { id: 'user-1' } });
        const res = await (GET as any)(req(), { params: Promise.resolve({}) });
        // The load-bearing header. Without it an intermediary may serve a
        // stale identity, which is the bug one layer down.
        expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('answers 401 DEFINITELY rather than 200 with a null id', async () => {
        auth.mockResolvedValue(null);
        const res = await (GET as any)(req(), { params: Promise.resolve({}) });
        // 200-with-null would read to a client as "verified as nobody", which
        // is a third meaning for a status that already has one.
        expect(res.status).toBe(401);
    });

    it('the 401 is also uncacheable', async () => {
        auth.mockResolvedValue(null);
        const res = await (GET as any)(req(), { params: Promise.resolve({}) });
        expect(res.headers.get('cache-control')).toContain('no-store');
    });

    // CONTROL — a session object without an id is not a verified identity.
    it('CONTROL: a session with no user id is refused, not accepted', async () => {
        auth.mockResolvedValue({ user: {} });
        const res = await (GET as any)(req(), { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
    });
});
