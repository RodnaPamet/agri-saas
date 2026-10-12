/**
 * #1600 — the notice flood cap, PROVEN BY EXCEEDING IT.
 *
 * ## Why the obvious test is worthless
 *
 * `expect(PUBLIC_NOTICE_LIMIT.maxAttempts).toBe(10)` asserts that a constant
 * holds the value it holds. It passes if the preset is never applied, if the
 * route forgot to pass it, if the limiter is disabled, and if
 * `resolveRateLimitScope` returns null for this method — which is exactly the
 * failure #1643 shipped on a GET, where a rate limit was configured on a
 * method that can never reach the limiter.
 *
 * So this drives the REAL wrapper with the route's own options until a request
 * is refused, and asserts the number of requests that took. #1634 is the model.
 *
 * ## What it must also prove: that the cap is the NOTICE cap
 *
 * A route that silently fell back to the default tier would still refuse —
 * at 60, not 10. Asserting "it refuses eventually" would pass that. So the
 * count is asserted exactly, and the two presets are asserted DIFFERENT, so
 * the test cannot pass by the two having been quietly unified.
 */
beforeEach(() => {
    jest.resetModules();
    process.env.RATE_LIMIT_ENABLED = '1';
    delete process.env.NEXT_TEST_MODE;
});

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    clearAllRateLimits,
    PUBLIC_NOTICE_LIMIT,
    API_MUTATION_LIMIT,
} from '@/lib/security/rate-limit';

/** Well above both presets, so a limiter that never refuses reports a number. */
const SAFETY_BOUND = API_MUTATION_LIMIT.maxAttempts * 3;

const ok = async () => new Response('{"id":"cr_1","status":"RECEIVED"}', { status: 201 });

function post(ip: string): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/public/notices', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    });
}

/**
 * The route's own wrapper options, spelled the way the route spells them.
 * If `src/app/api/public/notices/route.ts` stops passing this config, this
 * test keeps passing — which is why `§2` reads the route file as well.
 */
function handler() {
    return withApiErrorHandling(ok, {
        rateLimit: { config: PUBLIC_NOTICE_LIMIT, scope: 'public-notices' },
    });
}

/** How many requests it takes to be refused. `null` = never refused. */
async function requestsUntilRefused(ip: string): Promise<number | null> {
    const h = handler();
    for (let n = 1; n <= SAFETY_BOUND; n += 1) {
        const res = await h(post(ip), { params: Promise.resolve({}) });
        if (res.status === 429) return n;
    }
    return null;
}

beforeEach(() => {
    clearAllRateLimits();
    getToken.mockReset().mockResolvedValue(null);
});

describe('§1 the cap binds, and it is the NOTICE cap', () => {
    it('refuses the 11th notice from one IP', async () => {
        const n = await requestsUntilRefused('198.51.100.7');

        // EXACT, not "eventually": a route that fell back to the default tier
        // would refuse at 61 and an `isNumber` assertion would call that a pass.
        expect(n).toBe(PUBLIC_NOTICE_LIMIT.maxAttempts + 1);
        expect(n).toBe(11);
    });

    it('the notice cap is TIGHTER than the default mutation tier', async () => {
        // The reason the preset exists. If someone unified the two, §1 above
        // would still pass while the flood protection was gone.
        expect(PUBLIC_NOTICE_LIMIT.maxAttempts)
            .toBeLessThan(API_MUTATION_LIMIT.maxAttempts);
    });

    it('a 429 carries Retry-After, so a client knows to back off', async () => {
        const h = handler();
        let last: Response | null = null;
        for (let i = 0; i < PUBLIC_NOTICE_LIMIT.maxAttempts + 1; i += 1) {
            last = await h(post('198.51.100.8'), { params: Promise.resolve({}) });
        }

        expect(last!.status).toBe(429);
        expect(last!.headers.get('Retry-After')).toBeTruthy();
    });

    it('the 429 body names no IP — the flood is capped without logging who', async () => {
        const h = handler();
        let last: Response | null = null;
        const ip = '198.51.100.9';
        for (let i = 0; i < PUBLIC_NOTICE_LIMIT.maxAttempts + 1; i += 1) {
            last = await h(post(ip), { params: Promise.resolve({}) });
        }

        const body = await last!.text();
        // Epic A.2's rule: a 429 body never carries IP/userId/tenantSlug. On an
        // UNAUTHENTICATED route the IP is the only identifier there is, and a
        // notifier filing an Art 16 complaint is exactly who should not have it
        // echoed back at them.
        expect(body).not.toContain(ip);
    });
});

describe('§2 one IP’s flood does not silence another notifier', () => {
    it('a second IP still gets its full budget', async () => {
        // THE ASSERTION THAT MATTERS for a legal duty. If the cap were global
        // rather than per-IP, ten notices from one abuser would stop everyone
        // else filing — turning an anti-flood control into the flood's weapon.
        await requestsUntilRefused('198.51.100.10');

        const second = await requestsUntilRefused('203.0.113.55');

        expect(second).toBe(PUBLIC_NOTICE_LIMIT.maxAttempts + 1);
    });
});

describe('§3 the route still passes the preset', () => {
    it('reads the route file, because §1 proves the PRESET and not the WIRING', () => {
        // §1 constructs the wrapper itself, so it would keep passing if the
        // route dropped its `rateLimit` option and fell back to 60/min. This is
        // the structural half. `wired-is-not-delivered`.
        const src = readFileSync(
            join(__dirname, '..', '..', 'src/app/api/public/notices/route.ts'),
            'utf8',
        );

        expect(src).toContain('PUBLIC_NOTICE_LIMIT');
        expect(src).toMatch(/rateLimit:\s*\{[^}]*config:\s*PUBLIC_NOTICE_LIMIT/);
    });
});
