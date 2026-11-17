/**
 * `GET /api/admin/moderation/unexplained-decisions` — #2996, driven as a
 * handler.
 *
 * ## Why this suite exists at all
 *
 * One assertion justifies it: **the rate limit actually executes.** Four of
 * this route's neighbours declare `rateLimit: { config: LOGIN_LIMIT }` on a
 * GET and enforce nothing, because `resolveRateLimitScope` returns null for
 * any non-mutation method (measured and filed as #3155). This route therefore
 * passes `rateLimit: false` and calls `enforceRateLimit` itself — and a claim
 * that a control runs, with nothing executing it, is exactly the defect #3155
 * is about. Writing that claim in a docblock and no test would be repeating it
 * one route along.
 *
 * The ORDER is pinned too: the key check first, so an unauthenticated caller
 * cannot consume a budget keyed on the platform scope.
 */
import type { NextRequest } from 'next/server';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'q'.repeat(48); // pragma: allowlist secret -- test fixture, never a real credential

const listSpy = jest.fn();
const enforceSpy = jest.fn();

function makeReq(init: { key?: string; search?: string } = {}): NextRequest {
    const headers = new Headers();
    if (init.key !== undefined) headers.set(HEADER, init.key);
    const url = new URL(
        `http://localhost:3000/api/admin/moderation/unexplained-decisions${init.search ?? ''}`,
    );
    return {
        method: 'GET',
        url: url.toString(),
        nextUrl: url,
        headers,
        json: async () => ({}),
    } as unknown as NextRequest;
}

type Handler = (req: NextRequest) => Promise<Response>;

function loadRoute(key: string | undefined): { GET: Handler } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/app-layer/usecases/moderation', () => ({
        listDecisionsWithoutStatement: (...a: unknown[]) => listSpy(...a),
    }));
    jest.doMock('@/lib/security/rate-limit-middleware', () => ({
        enforceRateLimit: (...a: unknown[]) => enforceSpy(...a),
    }));
    return require('@/app/api/admin/moderation/unexplained-decisions/route');
}

beforeEach(() => {
    listSpy.mockReset().mockResolvedValue([]);
    enforceSpy.mockReset().mockResolvedValue({ response: null });
});

describe('GET /api/admin/moderation/unexplained-decisions', () => {
    it('refuses a request with no platform key', async () => {
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq());
        expect(res.status).toBe(401);
        expect(listSpy).not.toHaveBeenCalled();
    });

    it('refuses a WRONG platform key', async () => {
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq({ key: 'z'.repeat(48) }));
        expect(res.status).toBe(401);
        expect(listSpy).not.toHaveBeenCalled();
    });

    it('returns the decisions under a `decisions` key', async () => {
        listSpy.mockResolvedValue([
            { id: 'a1', actionKind: 'CONTENT_REMOVED', subjectKind: 'LISTING', subjectId: 's', reportId: null, createdAt: new Date(0) },
        ]);
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { decisions: unknown[] };
        expect(body.decisions).toHaveLength(1);
    });

    it('ENFORCES the rate limit — the control is not inert (#3155)', async () => {
        const { GET } = loadRoute(REAL_KEY);
        await GET(makeReq({ key: REAL_KEY }));
        expect(enforceSpy).toHaveBeenCalledTimes(1);
        expect(enforceSpy.mock.calls[0]![1]).toMatchObject({
            scope: 'platform-moderation-unexplained',
        });
    });

    it('RETURNS the limiter refusal rather than ignoring it', async () => {
        // Calling the limiter and discarding its answer would satisfy the
        // assertion above while enforcing nothing — the same shape as a
        // declared-but-unexecuted control, one step along.
        enforceSpy.mockResolvedValue({ response: new Response('slow down', { status: 429 }) });
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq({ key: REAL_KEY }));
        expect(res.status).toBe(429);
        expect(listSpy).not.toHaveBeenCalled();
    });

    it('checks the key BEFORE the limiter, so a stranger cannot spend the budget', async () => {
        const { GET } = loadRoute(REAL_KEY);
        await GET(makeReq());
        expect(enforceSpy).not.toHaveBeenCalled();
    });

    it('passes a parsed limit through', async () => {
        const { GET } = loadRoute(REAL_KEY);
        await GET(makeReq({ key: REAL_KEY, search: '?limit=5' }));
        expect(listSpy).toHaveBeenCalledWith(5);
    });
});
