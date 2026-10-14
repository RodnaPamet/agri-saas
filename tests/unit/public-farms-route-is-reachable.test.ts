/**
 * Somebody can search the directory, and anonymously (P6.8, #1817).
 *
 * The companion to the search usecase's integration suite. That one proves the
 * SQL behaves against a real database; it would have been just as green while
 * nothing could call it — the finding #1793 recorded, where a complete, tested
 * usecase had zero callers.
 *
 * ## What is asserted here that the integration suite cannot
 *
 *   - the route is PUBLIC at the Edge, and the correct spelling of it. An
 *     exact entry opens one path; a missing one means the handler is
 *     unreachable and the 401 arrives before any of this runs.
 *   - it is covered by the public-read rate limit, which is P6.10's 61st-request
 *     requirement. An unlimited trigram search over a public endpoint is a
 *     database read per request from anybody.
 *   - the query is forwarded, including the parts a well-typed mistake would
 *     drop: `oblast` and `crop` are both optional strings, so swapping them
 *     compiles.
 */
import { NextRequest } from 'next/server';

import { isPublicPath } from '@/lib/auth/guard';
import { isPublicReadRateLimited } from '@/lib/rate-limit/publicReadRateLimit';

const searchPublicFarms = jest.fn();
jest.mock('@/app-layer/usecases/public-farm-profile', () => ({
    searchPublicFarms: (...args: unknown[]) => searchPublicFarms(...args),
    // The schema module imports this constant, so the mock must supply it or
    // the route's own import chain breaks — the partial-barrel trap.
    FARM_SEARCH_MAX_LIMIT: 50,
}));

const route = require('../../src/app/api/public/farms/route');

function get(qs: string): NextRequest {
    return new NextRequest(`http://x/api/public/farms${qs}`, { method: 'GET' });
}

beforeEach(() => {
    searchPublicFarms.mockReset();
    searchPublicFarms.mockResolvedValue([]);
});

describe('the route is reachable without a session', () => {
    it('is public at the Edge, by its exact path', () => {
        expect(isPublicPath('/api/public/farms')).toBe(true);
    });

    it('a NEIGHBOURING path is not opened by it', () => {
        // The exact-vs-prefix distinction, and only a child or a sibling can
        // show it. An entry spelled as a prefix would have opened both.
        expect(isPublicPath('/api/public/farms/secret')).toBe(false);
        expect(isPublicPath('/api/public/farmsomething')).toBe(false);
    });

    it('is covered by the public-read rate limit — P6.10 asks for exactly this', () => {
        // 60/min per IP at the Edge. Without it a trigram search is a database
        // read per request from anybody.
        expect(isPublicReadRateLimited('GET', '/api/public/farms')).toBe(true);
        // …and the tier is GET-only, which is why a POST is not claimed.
        expect(isPublicReadRateLimited('POST', '/api/public/farms')).toBe(false);
    });
});

describe('the query reaches the usecase', () => {
    it('forwards q', async () => {
        await route.GET(get('?q=Pobeda'), {});
        expect(searchPublicFarms).toHaveBeenCalledTimes(1);
        expect(searchPublicFarms.mock.calls[0][0].q).toBe('Pobeda');
    });

    it('forwards oblast and crop to the RIGHT fields', async () => {
        // Both are optional strings, so `{ oblast: query.crop }` compiles and
        // silently filters by the wrong thing. This is the case that sees it.
        await route.GET(get('?q=x&oblast=%D0%94%D0%BE%D0%B1%D1%80%D0%B8%D1%87&crop=%D0%BF%D1%88%D0%B5%D0%BD%D0%B8%D1%86%D0%B0'), {});
        const arg = searchPublicFarms.mock.calls[0][0];
        expect(arg.oblast).toBe('Добрич');
        expect(arg.crop).toBe('пшеница');
    });

    it('coerces limit from the query string to a number', async () => {
        await route.GET(get('?q=x&limit=5'), {});
        expect(searchPublicFarms.mock.calls[0][0].limit).toBe(5);
    });

    it('an EMPTY query is a legitimate browse, not a 400', async () => {
        const res = await route.GET(get(''), {});
        expect(res.status).toBe(200);
        expect(searchPublicFarms).toHaveBeenCalledTimes(1);
    });

    it('answers a BARE ARRAY, matching the other list surfaces', async () => {
        searchPublicFarms.mockResolvedValue([
            { handle: 'pobeda', displayName: 'Победа', tagline: null, oblast: null, crops: [], score: 0.8 },
        ]);
        const res = await route.GET(get('?q=Победа'), {});
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body[0].handle).toBe('pobeda');
    });

    describe('the query is validated before the usecase runs', () => {
        it('refuses a limit above the cap rather than silently clamping', async () => {
            // Clamping would answer 50 results to a request for 9999 and look
            // successful; a 400 naming the field tells the client what it did.
            const res = await route.GET(get('?limit=9999'), {});
            expect(res.status).toBe(400);
            expect(searchPublicFarms).not.toHaveBeenCalled();
        });

        it('refuses a non-numeric limit', async () => {
            const res = await route.GET(get('?limit=lots'), {});
            expect(res.status).toBe(400);
            expect(searchPublicFarms).not.toHaveBeenCalled();
        });
    });
});
