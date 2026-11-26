/**
 * A platform-admin GET's rate limit actually runs — #3155.
 *
 * The five routes in that issue declared `rateLimit: { config: LOGIN_LIMIT }`
 * through `withApiErrorHandling`, which `resolveRateLimitScope` discards for
 * any non-mutation method. So the control was declared, never executed, and —
 * worse — `publicReadRateLimit` excluded `/api/admin/*` from the Edge read
 * tier CITING it, which left those GETs throttled at no layer.
 *
 * The fix is the inline call, and a docblock claiming a control runs with
 * nothing executing it is the very defect. So this drives one route as a
 * handler and pins three things the source cannot show:
 *
 *   1. the limiter is CALLED,
 *   2. its refusal is RETURNED rather than discarded,
 *   3. the key check happens FIRST, so an unauthenticated caller cannot spend
 *      a budget keyed on the platform scope.
 *
 * One route rather than five: the mechanism is identical across them and is
 * the thing under test, while the structural half — that no GET declares a
 * limit the wrapper would drop — is derived over all 496 route files by
 * `tests/guards/declared-rate-limits-can-execute.test.ts`.
 */
import type { NextRequest } from 'next/server';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'm'.repeat(48); // pragma: allowlist secret -- test fixture, never a real credential

const statsSpy = jest.fn();
const enforceSpy = jest.fn();

function makeReq(init: { key?: string } = {}): NextRequest {
    const headers = new Headers();
    if (init.key !== undefined) headers.set(HEADER, init.key);
    const url = new URL('http://localhost:3000/api/admin/moderation/metrics');
    return {
        method: 'GET',
        url: url.toString(),
        nextUrl: url,
        headers,
    } as unknown as NextRequest;
}

function loadRoute(): { GET: (req: NextRequest) => Promise<Response> } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: REAL_KEY, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/app-layer/usecases/moderation', () => ({
        moderationHandlingStats: (...a: unknown[]) => statsSpy(...a),
    }));
    jest.doMock('@/lib/security/rate-limit-middleware', () => ({
        enforceRateLimit: (...a: unknown[]) => enforceSpy(...a),
    }));
    return require('@/app/api/admin/moderation/metrics/route');
}

beforeEach(() => {
    statsSpy.mockReset().mockResolvedValue({ decided: 0, answered: 0 });
    enforceSpy.mockReset().mockResolvedValue({ response: null });
});

describe('GET /api/admin/moderation/metrics', () => {
    it('ENFORCES its rate limit — the declared control is not inert', async () => {
        const { GET } = loadRoute();
        const res = await GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(200);
        expect(enforceSpy).toHaveBeenCalledTimes(1);
        expect(enforceSpy.mock.calls[0]![1]).toMatchObject({
            scope: 'platform-moderation-metrics',
        });
    });

    it('RETURNS the limiter refusal rather than ignoring it', async () => {
        // Calling the limiter and discarding its answer satisfies the
        // assertion above while enforcing nothing — the same shape as a
        // declared-but-unexecuted control, one step along.
        enforceSpy.mockResolvedValue({ response: new Response('slow down', { status: 429 }) });
        const { GET } = loadRoute();
        const res = await GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(429);
        expect(statsSpy).not.toHaveBeenCalled();
    });

    it('checks the KEY first, so a stranger cannot spend the budget', async () => {
        const { GET } = loadRoute();
        const res = await GET(makeReq());
        expect(res.status).toBe(401);
        expect(enforceSpy).not.toHaveBeenCalled();
        expect(statsSpy).not.toHaveBeenCalled();
    });
});
