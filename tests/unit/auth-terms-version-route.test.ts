/**
 * `GET /api/auth/terms` serves the SAME constant accept-terms compares against,
 * and sits where a held session can reach it.
 *
 * ## Why these two assertions and not a snapshot
 *
 * The value is a constant, so asserting it equals `'2026-10-07-draft'` would
 * pin the literal and fail on every legitimate terms bump — a test that has to
 * be edited whenever the thing it guards changes correctly is a test people
 * learn to update without reading. What must hold across a bump is that the
 * route and the acceptance gate read ONE constant, so this asserts the
 * identity rather than the value.
 *
 * The reachability half is the one that would actually break in production.
 * This route is useless unless a `termsPending` session can call it, and that
 * session is refused everywhere else by design — so the gate predicates are
 * asserted directly rather than trusted to a path convention.
 */
import { TERMS_VERSION } from '@/lib/legal/terms';
import { isTermsAllowedPath, isPublicPath } from '@/lib/auth/guard';
import { NextRequest } from 'next/server';

const PATH = '/api/auth/terms';

describe('GET /api/auth/terms', () => {
    it('serves the same constant the acceptance gate compares against', async () => {
        const { GET } = await import('@/app/api/auth/terms/route');
        // A NextRequest, not a plain Request: `withApiErrorHandling` reads
        // `req.nextUrl.pathname` to label its metrics, so a bare Request
        // throws inside the wrapper before the handler is reached.
        const res = await GET(new NextRequest('http://localhost' + PATH) as never, {} as never);
        const body = (await res.json()) as { version: string; url: string };

        // The identity, not the literal: a terms bump must not need this edited.
        expect(body.version).toBe(TERMS_VERSION);
        expect(body.url).toBe('/terms');
    });

    it('is reachable by a termsPending session — the one that must reach it', () => {
        // Without this the endpoint is unreachable by its only real caller, and
        // the failure is a 403 on the call that would release the session.
        expect(isTermsAllowedPath(PATH)).toBe(true);
    });

    it('is reachable anonymously, because the document is public', () => {
        expect(isPublicPath(PATH)).toBe(true);
    });

    it('control: the gate predicates can say NO', () => {
        // Otherwise the two assertions above pass against predicates that
        // return true for everything, which is the shape where a reachability
        // test proves nothing.
        expect(isTermsAllowedPath('/api/t/acme/tasks')).toBe(false);
        expect(isPublicPath('/api/t/acme/tasks')).toBe(false);
    });
});
