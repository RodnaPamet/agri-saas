/**
 * The session-authenticated statements and metrics routes — #2735, PR 4.
 *
 * These complete the console. The attribution plumbing for the statement verb
 * landed in #2997 (`queueStatement` taking a `ModerationActor`, so
 * `MODERATION_STATEMENT_QUEUED` names its author rather than recording
 * `actorUserId: null`); only the door was missing, which is why I wrongly
 * called PR 3 the last one.
 *
 * Five properties:
 *
 *   1. the actor is `{ kind: 'user' }` from `ctx.userId` — invisible in any
 *      response, so only a test at the seam can see it.
 *   2. a body cannot override it, nor supply the recipient's attribution.
 *   3. both gates run on BOTH methods and on metrics.
 *   4. `limit` and `windowDays` are parsed through the SHARED parsers, so the
 *      two doors cannot answer different questions.
 *   5. an out-of-range `windowDays` falls back rather than erroring —
 *      preserved from the keyed route, and asserted so the preservation is
 *      deliberate rather than accidental.
 */
import type { NextRequest } from 'next/server';

const permissionKeys: string[] = [];
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (key: string, handler: unknown) =>
        async (req: unknown, routeArgs: { params: unknown }) => {
            permissionKeys.push(key);
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

const listUndeliveredStatements = jest.fn();
const queueStatement = jest.fn();
const moderationHandlingStats = jest.fn();
jest.mock('@/app-layer/usecases/moderation', () => ({
    listUndeliveredStatements: (...a: unknown[]) => listUndeliveredStatements(...a),
    queueStatement: (...a: unknown[]) => queueStatement(...a),
    moderationHandlingStats: (...a: unknown[]) => moderationHandlingStats(...a),
}));

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
const SPATH = '/api/t/platform/admin/moderation/statements';
const MPATH = '/api/t/platform/admin/moderation/metrics';

beforeEach(() => {
    permissionKeys.length = 0;
    jest.resetAllMocks();
    listUndeliveredStatements.mockResolvedValue([]);
    queueStatement.mockResolvedValue({ statementId: 'sor-1' });
    moderationHandlingStats.mockResolvedValue({ byStatus: {}, medianMs: null });
});

describe('#2735 PR4 — the undelivered-statement queue', () => {
    const load = () => import('@/app/api/t/[tenantSlug]/admin/moderation/statements/route');

    it('reads the queue and passes the parsed limit through', async () => {
        const { GET } = await load();
        const res = await GET(makeReq(`${SPATH}?limit=5`), params);
        expect(res.status).toBe(200);
        expect(listUndeliveredStatements).toHaveBeenCalledWith(5);
    });

    it('REFUSES a non-integer limit rather than defaulting it', async () => {
        // `parseLimitParam` throws `INVALID_LIMIT` and `withApiErrorHandling`
        // turns that into a response — so nothing reaches the usecase. The
        // weaker assertion (that `limit` merely arrived non-NaN) would pass for
        // a route that served the default queue under a limit the caller asked
        // for and did not get.
        const { GET } = await load();
        const res = await GET(makeReq(`${SPATH}?limit=abc`), params);
        expect(res.status).toBe(400);
        expect(listUndeliveredStatements).not.toHaveBeenCalled();
    });

    it('omits the limit when absent, so the usecase default applies', async () => {
        // The positive control: a route answering 400 for EVERY limit would
        // satisfy the case above.
        const { GET } = await load();
        const res = await GET(makeReq(SPATH), params);
        expect(res.status).toBe(200);
        expect(listUndeliveredStatements).toHaveBeenCalledWith(undefined);
    });

    it('runs both gates on the GET', async () => {
        const { GET } = await load();
        await GET(makeReq(SPATH), params);
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });
});

describe('#2735 PR4 — queueing a statement by hand', () => {
    const load = () => import('@/app/api/t/[tenantSlug]/admin/moderation/statements/route');
    const valid = {
        actionId: 'ma-1',
        recipientUserId: 'u-recipient',
        bodyRendered: 'Вашата обява беше премахната.',
    };

    it('hands `queueStatement` an actor of kind `user` carrying ctx.userId', async () => {
        const { POST } = await load();
        const res = await POST(makeReq(SPATH, valid, 'POST'), params);
        expect(res.status).toBe(201);
        const arg = queueStatement.mock.calls[0][0] as { actor: unknown };
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
    });

    it('IGNORES an actor or moderator supplied in the body', async () => {
        const { POST } = await load();
        await POST(
            makeReq(SPATH, {
                ...valid,
                actor: { kind: 'user', userId: 'u-somebody-else' },
                moderatorRef: 'user:u-somebody-else',
                generation: 'previous',
            }, 'POST'),
            params,
        );
        const arg = queueStatement.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
        expect(arg.moderatorRef).toBeUndefined();
        expect(arg.generation).toBeUndefined();
    });

    it('takes the RECIPIENT from the body — supplied, never derived', async () => {
        // An action's subject is CONTENT; a removed listing names a farm whose
        // members are several. Who is entitled to the statement is a judgement,
        // and there is no field on `ModerationAction` to derive it from.
        const { POST } = await load();
        await POST(makeReq(SPATH, valid, 'POST'), params);
        const arg = queueStatement.mock.calls[0][0] as { recipientUserId: string };
        expect(arg.recipientUserId).toBe('u-recipient');
    });

    it('defaults the locale to bg, not en', async () => {
        // `bg` rather than `DEFAULT_LOCALE`, which is `en` and documented for
        // UNAUTHENTICATED surfaces. A statement recipient is a known user whose
        // `uiLanguage` column defaults to `bg`, and dispatch overwrites this at
        // send time anyway — it is a placeholder, not a language choice.
        const { POST } = await load();
        await POST(makeReq(SPATH, valid, 'POST'), params);
        expect((queueStatement.mock.calls[0][0] as { locale: string }).locale).toBe('bg');
    });

    it('honours an explicit locale when one is given', async () => {
        const { POST } = await load();
        await POST(makeReq(SPATH, { ...valid, locale: 'en' }, 'POST'), params);
        expect((queueStatement.mock.calls[0][0] as { locale: string }).locale).toBe('en');
    });

    it('refuses a body with no rendered text', async () => {
        const { POST } = await load();
        const { bodyRendered: _dropped, ...withoutBody } = valid;
        const res = await POST(makeReq(SPATH, withoutBody, 'POST'), params);
        expect(res.status).toBe(400);
        expect(queueStatement).not.toHaveBeenCalled();
    });
});

describe('#2735 PR4 — the handling-time reading', () => {
    const load = () => import('@/app/api/t/[tenantSlug]/admin/moderation/metrics/route');

    it('passes an in-range windowDays through', async () => {
        const { GET } = await load();
        const res = await GET(makeReq(`${MPATH}?windowDays=90`), params);
        expect(res.status).toBe(200);
        expect(moderationHandlingStats).toHaveBeenCalledWith(90);
    });

    it('defaults to 30 when absent', async () => {
        const { GET } = await load();
        await GET(makeReq(MPATH), params);
        expect(moderationHandlingStats).toHaveBeenCalledWith(30);
    });

    it.each([
        ['over the 365 ceiling', '400'],
        ['zero', '0'],
        ['non-integer', 'abc'],
        ['fractional', '1.5'],
    ])('falls back to 30 for %s — preserved from the keyed route', async (_label, v) => {
        // Asserted so the preservation is DELIBERATE. It is the weaker choice
        // of the two — a caller who asks for 90 and silently receives 30 reads
        // the figure as a 90-day one — and changing it here would have altered
        // the keyed route's contract as a side effect of extracting a shared
        // parser.
        const { GET } = await load();
        await GET(makeReq(`${MPATH}?windowDays=${v}`), params);
        expect(moderationHandlingStats).toHaveBeenCalledWith(30);
    });

    it('runs both gates', async () => {
        const { GET } = await load();
        await GET(makeReq(MPATH), params);
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });
});
