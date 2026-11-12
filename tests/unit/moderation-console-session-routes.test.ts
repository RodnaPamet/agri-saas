/**
 * The session-authenticated moderation routes — #2735.
 *
 * P5.4a shipped the queue and the decision behind `verifyPlatformApiKey`, so
 * the only attribution available was a shared KEY GENERATION: *"a regulator
 * asking 'who decided this' gets 'somebody holding the key'"*. This route is
 * the second door whose caller IS a person.
 *
 * Five properties, and the first two are the ones that would be silent:
 *
 *   1. the `ModerationActor` handed to `actOnNotice` is `{ kind: 'user' }`
 *      carrying `ctx.userId`. Nothing in a response shows this, so only a test
 *      at the seam can see it.
 *   2. a body that SUPPLIES an actor or a moderator cannot override it.
 *      Asserting (1) alone would pass for a route that merely DEFAULTED it,
 *      which is the weakness the keyed sibling actually has — it reads
 *      `moderatorRef` from the body.
 *   3. both gates run — `admin.manage` AND `assertPlatformSupport`. The second
 *      is what stops an ADMIN of any one farm triaging ANOTHER farm's notices,
 *      because `ContentReport` has no `tenantId` to scope by.
 *   4. a missing notice is a 404 and not a 201 over an empty `actionId`.
 *   5. the queue passes its `status` filter through, and refuses an
 *      unrecognised one rather than silently answering with the default — a
 *      moderator filtering for ACTIONED and receiving RECEIVED reads "there
 *      are none".
 */
import type { NextRequest } from 'next/server';

const permissionKeys: string[] = [];
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (key: string, handler: unknown) =>
        async (req: unknown, routeArgs: { params: unknown }) => {
            permissionKeys.push(key);
            // RESOLVES `params` first, exactly as the real wrapper does since
            // GAP-05. A mock that passed the Promise through would hand the
            // handler an unawaited object, and every id would be `undefined` —
            // which reads as a routing bug rather than a harness one.
            const params = await routeArgs.params;
            return (handler as (r: unknown, a: unknown, ctx: unknown) => Promise<unknown>)(
                req,
                { ...routeArgs, params },
                { userId: 'u-moderator', tenantId: 't-platform', tenantSlug: 'platform' },
            );
        },
}));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: unknown[]) => assertPlatformSupport(...a),
    isPlatformTenant: () => true,
}));

const listNotices = jest.fn();
const actOnNotice = jest.fn();
jest.mock('@/app-layer/usecases/moderation', () => ({
    listNotices: (...a: unknown[]) => listNotices(...a),
    actOnNotice: (...a: unknown[]) => actOnNotice(...a),
}));

/**
 * `withApiErrorHandling` reads `req.headers.get(...)` and
 * `req.nextUrl.pathname`, so a bare `{ url, json }` throws a TypeError inside
 * the wrapper before any handler runs — which is how a shapeless
 * `rejects.toThrow()` passes for the wrong reason.
 */
function makeReq(path: string, body?: unknown, method = 'GET'): NextRequest {
    const url = new URL(`http://localhost:3000${path}`);
    return {
        method,
        headers: new Headers(),
        nextUrl: url,
        url: url.toString(),
        json: async () => body,
    } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ tenantSlug: 'platform' }) };

beforeEach(() => {
    permissionKeys.length = 0;
    // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS, so a throwing
    // implementation installed by one test would poison every later one.
    jest.resetAllMocks();
    listNotices.mockResolvedValue([]);
    actOnNotice.mockResolvedValue({ actionId: 'ma-1', status: 'ACTIONED' });
});

describe('#2735 — the decision is attributed to the SESSION, not the body', () => {
    it('hands `actOnNotice` an actor of kind `user` carrying ctx.userId', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await POST(
            makeReq('/api/t/platform/admin/moderation/notices', {
                reportId: 'cr-1',
                actionKind: 'CONTENT_REMOVED',
                rationale: 'the grade could not be substantiated',
            }, 'POST'),
            params,
        );

        expect(res.status).toBe(201);
        expect(actOnNotice).toHaveBeenCalledTimes(1);
        const arg = actOnNotice.mock.calls[0][0] as { actor: unknown };
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
    });

    it('IGNORES an actor or moderator supplied in the body', async () => {
        // The property (1) alone cannot distinguish: a route that spread the
        // body AFTER the actor would still pass it while being overridable.
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        await POST(
            makeReq('/api/t/platform/admin/moderation/notices', {
                reportId: 'cr-1',
                actionKind: 'CONTENT_REMOVED',
                rationale: 'reason',
                // Every shape a caller might try.
                actor: { kind: 'user', userId: 'u-somebody-else' },
                moderatorRef: 'user:u-somebody-else',
                generation: 'previous',
                reviewedBy: 'u-somebody-else',
            }, 'POST'),
            params,
        );

        const arg = actOnNotice.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
        // `ActOnNoticeSchema.strip()` drops the unknown keys, so they never
        // reach the usecase at all — rather than reaching it and being ignored,
        // which a later refactor could stop doing.
        expect(arg.moderatorRef).toBeUndefined();
        expect(arg.generation).toBeUndefined();
        expect(arg.reviewedBy).toBeUndefined();
    });

    it('runs BOTH gates — admin.manage and assertPlatformSupport', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        await POST(
            makeReq('/api/t/platform/admin/moderation/notices', {
                reportId: 'cr-1', actionKind: 'NONE', rationale: 'looked, no action',
            }, 'POST'),
            params,
        );
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });

    it('answers 404 when the notice does not exist', async () => {
        // `actOnNotice` reports a missing notice as an EMPTY `actionId` rather
        // than throwing, so a route that returned its result unexamined would
        // answer 201 over a decision that was never recorded.
        actOnNotice.mockResolvedValue({ actionId: '', status: 'RECEIVED' });
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await POST(
            makeReq('/api/t/platform/admin/moderation/notices', {
                reportId: 'cr-missing', actionKind: 'NONE', rationale: 'x',
            }, 'POST'),
            params,
        );
        expect(res.status).toBe(404);
    });

    it('refuses a malformed body with a 400 and calls nothing', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        // No rationale: REQUIRED, because a decision without a reason is what
        // Art 17 exists to prevent.
        const res = await POST(
            makeReq('/api/t/platform/admin/moderation/notices', {
                reportId: 'cr-1', actionKind: 'CONTENT_REMOVED',
            }, 'POST'),
            params,
        );
        expect(res.status).toBe(400);
        expect(actOnNotice).not.toHaveBeenCalled();
    });
});

describe('#2735 — the queue', () => {
    it('passes the status filter and the parsed limit through', async () => {
        const { GET } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await GET(
            makeReq('/api/t/platform/admin/moderation/notices?status=ACTIONED&limit=5'),
            params,
        );
        expect(res.status).toBe(200);
        expect(listNotices).toHaveBeenCalledWith({ status: 'ACTIONED', limit: 5 });
    });

    it('REFUSES an unrecognised status rather than answering with the default', async () => {
        // The failure this prevents: a moderator filtering for a status that
        // does not exist receives the unfiltered queue and reads it as the
        // answer to the question they asked.
        const { GET } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await GET(
            makeReq('/api/t/platform/admin/moderation/notices?status=WHATEVER'),
            params,
        );
        expect(res.status).toBe(400);
        expect(listNotices).not.toHaveBeenCalled();
    });

    it('REFUSES a non-integer limit rather than defaulting it', async () => {
        // My first draft asserted `limit` merely arrived non-NaN, on the
        // assumption that `parseLimitParam` returns undefined for junk. It
        // THROWS `INVALID_LIMIT`, and `withApiErrorHandling` catches a coded
        // error into a RESPONSE — so the truth is stronger than the assertion I
        // wrote: nothing reaches the usecase at all. Asserting the weaker thing
        // would have passed for a route that silently served the default queue
        // under a limit the caller asked for and did not get.
        const { GET } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await GET(
            makeReq('/api/t/platform/admin/moderation/notices?limit=abc'),
            params,
        );
        expect(res.status).toBe(400);
        expect(listNotices).not.toHaveBeenCalled();
    });

    it('omits `limit` when the param is absent, so the usecase default applies', async () => {
        // The positive control for the case above: a route that answered 400
        // for EVERY limit would satisfy it.
        const { GET } = await import(
            '@/app/api/t/[tenantSlug]/admin/moderation/notices/route'
        );
        const res = await GET(
            makeReq('/api/t/platform/admin/moderation/notices'),
            params,
        );
        expect(res.status).toBe(200);
        const arg = listNotices.mock.calls[0][0] as { limit: unknown };
        expect(arg.limit).toBeUndefined();
    });
});
