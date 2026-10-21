/**
 * `POST /api/me/probe-event` — P7.9 (#1998).
 *
 * The endpoint exists because #1998's probe has to CAUSE a realtime event, and
 * every existing producer notifies somebody else — task assignment
 * deliberately says nothing when the assignee is the actor. So the properties
 * worth protecting are that it can only ever ping the caller, and that it is
 * NOT flag-gated, which is what lets the probe tell "off by decision" from
 * "the publisher is broken".
 */
import { NextRequest } from 'next/server';

const getUserCtxMock = jest.fn();
const getLegacyCtxMock = jest.fn();
const publishMock = jest.fn();
const info = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getUserCtx: (...a: unknown[]) => getUserCtxMock(...a),
    getLegacyCtx: (...a: unknown[]) => getLegacyCtxMock(...a),
}));
jest.mock('@/lib/notifications/notification-bus', () => ({
    __esModule: true,
    publishNotificationEvent: (...a: unknown[]) => publishMock(...a),
}));
/**
 * The logger mock keeps the module's OTHER exports.
 *
 * `withApiErrorHandling` calls `extractErrorMeta` from this same module, so a
 * mock that replaced the barrel with only `logger` made the error path throw
 * `extractErrorMeta is not a function` — which presented as the refusal case
 * failing for a reason that had nothing to do with refusals. Same trap as the
 * ~55 suites that mock `@/lib/audit` partially.
 */
/**
 * `afterCommit` runs its callback IMMEDIATELY when no transaction frame is
 * open, which is the case in every test here — so the real module is used and
 * the publish is still observable synchronously. Mocking it would hide the
 * wrapper the `notification-publish-after-commit` guard requires, which is
 * the one thing these cases must not do.
 */
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    __esModule: true,
    logger: { info: (...a: unknown[]) => info(...a), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { POST } from '@/app/api/me/probe-event/route';
// From the frame contract, not the route: a Next route module may export only
// handlers and segment config (`...export only what Next allows`).
import { PROBE_ID_PREFIX } from '@/lib/realtime/stream-frame';

const request = () => new NextRequest('http://localhost/api/me/probe-event', { method: 'POST' });

/**
 * The second argument `withApiErrorHandling` passes through.
 *
 * This route reads no path params — it is `/api/me/`, with the subject taken
 * from the session — but the wrapper's signature requires the slot, so an
 * empty resolved params object is what a real call supplies here.
 */
const CTX = { params: Promise.resolve({}) };

beforeEach(() => {
    jest.clearAllMocks();
    getUserCtxMock.mockResolvedValue({ requestId: 'r-1', userId: 'u-1', email: 'a@b.c' });
    getLegacyCtxMock.mockResolvedValue({ requestId: 'r-1', userId: 'u-1', tenantId: 't-1' });
});

describe('POST /api/me/probe-event', () => {
    it('publishes one event and returns the id to match on', async () => {
        // Returning the id is what lets the probe assert THIS event arrived
        // rather than that something did — the difference between a working
        // transport and an unrelated notification landing in the window.
        const res = await POST(request(), CTX);
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(publishMock).toHaveBeenCalledTimes(1);
        expect(body.id).toMatch(new RegExp(`^${PROBE_ID_PREFIX}`));
        expect(publishMock.mock.calls[0][2]).toEqual({ id: body.id });
    });

    it('can only ping the CALLER — no parameter names a recipient', async () => {
        // The channel is built from the caller's own context, so there is no
        // recipient to confuse for another. That is what makes this safe to
        // expose to any signed-in caller.
        await POST(request(), CTX);

        expect(publishMock).toHaveBeenCalledWith('t-1', 'u-1', expect.anything());
    });

    it('IGNORES anything in the request that looks like a recipient', async () => {
        // The case above cannot catch a recipient parameter being introduced:
        // a mutation reading `x-recipient` and falling back to the session
        // left it green, because the request sent no such header. Proved by
        // mutating the route and watching all eight cases pass.
        //
        // So this one supplies every plausible spelling at once. It must make
        // no difference — the publish is addressed from the session or the
        // endpoint stops being safe to expose.
        const hostile = new NextRequest('http://localhost/api/me/probe-event?userId=victim', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-recipient': 'victim',
                'x-user-id': 'victim',
            },
            body: JSON.stringify({ userId: 'victim', recipientUserId: 'victim', tenantId: 'other' }),
        });

        await POST(hostile, CTX);

        expect(publishMock).toHaveBeenCalledWith('t-1', 'u-1', expect.anything());
        // And nothing named `victim` reached the bus under any argument.
        expect(JSON.stringify(publishMock.mock.calls)).not.toContain('victim');
    });

    it('authenticates the PERSON before resolving a tenant', async () => {
        // Same order and reason as `/api/me/stream`: `getUserCtx` is the only
        // one of the two given the request, so it is the only one that can
        // refuse an API key presented as a person credential.
        const order: string[] = [];
        getUserCtxMock.mockImplementation(async () => {
            order.push('person');
            return { requestId: 'r', userId: 'u-1', email: '' };
        });
        getLegacyCtxMock.mockImplementation(async () => {
            order.push('tenant');
            return { requestId: 'r', userId: 'u-1', tenantId: 't-1' };
        });

        await POST(request(), CTX);

        expect(order).toEqual(['person', 'tenant']);
    });

    it('refuses an unauthenticated caller, publishing nothing', async () => {
        getUserCtxMock.mockRejectedValue(new Error('API_KEY_NOT_PERSON_SCOPED'));

        const res = await POST(request(), CTX);

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(publishMock).not.toHaveBeenCalled();
    });

    it('writes NO notification row', async () => {
        // It asserts the transport, not that a row appeared. A client that
        // receives the id refetches and finds nothing new, which is correct —
        // and it means this cannot be used to put text in front of anybody.
        await POST(request(), CTX);

        // Nothing but the bus was touched: the route imports no repository and
        // no db-context, which the source assertion below locks.
        const src = require('node:fs').readFileSync(
            require('node:path').join(__dirname, '../../../src/app/api/me/probe-event/route.ts'),
            'utf8',
        );
        expect(src).not.toMatch(/runInTenantContext|prisma\./);
    });

    it('is NOT flag-gated, which is the point', async () => {
        // If it were behind `notifications.sse`, then with the flag off the
        // probe would be refused HERE and get a 204 from the stream, and could
        // not tell "off by decision" from "the publisher is broken". Publishing
        // is always allowed; whether anybody listens is the stream's business.
        const src = require('node:fs').readFileSync(
            require('node:path').join(__dirname, '../../../src/app/api/me/probe-event/route.ts'),
            'utf8',
        );
        expect(src).not.toMatch(/isFeatureEnabled|assertFeatureEnabled/);

        // And behaviourally: it publishes with no flag mock in place at all.
        const res = await POST(request(), CTX);
        expect(res.status).toBe(202);
    });

    it('mints an id that can never be mistaken for a replay cursor', async () => {
        // `notification-replay` shape-checks `Last-Event-ID` against a cuid,
        // so a probe id must not be cuid-shaped — otherwise a client echoing
        // one back would send it as a cursor and get a silent empty replay.
        const res = await POST(request(), CTX);
        const { id } = await res.json();

        expect(id).not.toMatch(/^c[a-z0-9]{20,32}$/);
        expect(id.startsWith(PROBE_ID_PREFIX)).toBe(true);
    });

    it('logs the id, so a failed probe can be matched against the publish', async () => {
        const res = await POST(request(), CTX);
        const { id } = await res.json();

        expect(info).toHaveBeenCalledWith(
            'realtime.probe_published',
            expect.objectContaining({ probeId: id }),
        );
    });
});
