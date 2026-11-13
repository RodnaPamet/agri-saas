/**
 * The person-scoped push — #2987 PR B.
 *
 * The tenantless sibling of `push-send`, and three of its properties are new
 * rather than inherited:
 *
 *   - the preference is the STRICTEST of a person's per-farm rows, because a
 *     tenantless event belongs to none of those farms;
 *   - quiet hours SUPPRESS rather than defer, because a tenantless event
 *     writes no `Notification` row and a summary would have nothing to count
 *     (#3020);
 *   - the device counts are DEDUPED per transport's own identity, because
 *     `PushSubscription` is one row per (tenant, user, endpoint) and one
 *     physical device registered in two farms is two rows.
 *
 * `push-send`'s two hard-won properties are inherited and re-asserted anyway:
 * one failing transport must not cost the other, and `delivered` counts
 * transports that reached a DEVICE rather than calls that returned — #2171,
 * where neither transport throws, so `delivered += 1` inside a `try` counted
 * an unconfigured transport as a success.
 */
const webPush = jest.fn();
const apns = jest.fn();
const warn = jest.fn();
const info = jest.fn();

/** What the one privileged read returns. */
let preferenceRows: Array<{ delivery: string }> = [];
let subscriptionRows: Array<{
    platform: string;
    deviceToken: string | null;
    endpoint: string | null;
}> = [
    { platform: 'WEB', deviceToken: null, endpoint: 'https://push.example/a' },
    { platform: 'IOS', deviceToken: 'tok-1', endpoint: null },
];

/**
 * Mocked at the `runWithoutRls` seam the resolver actually uses.
 *
 * The REASON is asserted, not ignored: a call that passed an unknown reason
 * would throw in production (`rls-middleware` checks it against the union) and
 * a mock that accepted anything would hide that.
 */
const bypassReasons: string[] = [];
jest.mock('@/lib/db/rls-middleware', () => ({
    __esModule: true,
    runWithoutRls: (opts: { reason: string }, cb: (db: unknown) => unknown) => {
        bypassReasons.push(opts.reason);
        return cb({
            userNotificationPreference: { findMany: async () => preferenceRows },
            pushSubscription: { findMany: async () => subscriptionRows },
        });
    },
}));

jest.mock('@/lib/notifications/web-push', () => ({
    __esModule: true,
    sendWebPushToPerson: (...a: unknown[]) => webPush(...a),
}));
jest.mock('@/lib/notifications/apns', () => ({
    __esModule: true,
    sendApnsToPerson: (...a: unknown[]) => apns(...a),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) },
}));

import { runPersonPushSend } from '@/app-layer/jobs/person-push-send';
import { strictestPreference, DELIVERY_STRICTNESS } from '@/app-layer/notifications/person-delivery';

const INPUT = {
    recipientUserId: 'u-recipient',
    title: 'Споменаха Ви',
    body: 'Някой Ви спомена в «Пшеница».',
    link: '/channels/ch-1',
    collapseKey: 'channel-ch-1-mention',
};

/** 12:00 Sofia — comfortably outside the 22:00–06:00 quiet window. */
const AWAKE = new Date('2026-11-13T10:00:00Z');
/** 23:30 Sofia. */
const ASLEEP = new Date('2026-11-13T21:30:00Z');

function at(when: Date): void {
    jest.useFakeTimers({ now: when, doNotFake: ['nextTick', 'setImmediate'] });
}

beforeEach(() => {
    jest.clearAllMocks();
    bypassReasons.length = 0;
    preferenceRows = [];
    subscriptionRows = [
        { platform: 'WEB', deviceToken: null, endpoint: 'https://push.example/a' },
        { platform: 'IOS', deviceToken: 'tok-1', endpoint: null },
    ];
    webPush.mockResolvedValue({ sent: 1, retryable: 0 });
    apns.mockResolvedValue({ sent: 1, retryable: 0 });
    at(AWAKE);
});

afterEach(() => {
    jest.useRealTimers();
});

describe('the strictest preference wins', () => {
    it('orders IMMEDIATE < DAILY_DIGEST < DISABLED', () => {
        // Asserted against the exported ORDER rather than restated, so the
        // policy has one definition. A second copy here is how the two come to
        // disagree.
        expect(DELIVERY_STRICTNESS).toEqual(['IMMEDIATE', 'DAILY_DIGEST', 'DISABLED']);
    });

    it('returns null for a person with NO rows — which means IMMEDIATE', () => {
        // The state nearly every person is in: the table has zero rows in
        // production. Reading absence as DISABLED would silence the feature
        // for everybody while looking like it worked.
        expect(strictestPreference([])).toBeNull();
    });

    it('picks DISABLED over IMMEDIATE, whichever order the rows arrive in', () => {
        // Both orders, because a `reduce` that kept the LAST value would pass
        // one of them and fail the other — and `findMany` makes no ordering
        // promise.
        expect(strictestPreference([
            { delivery: 'IMMEDIATE' }, { delivery: 'DISABLED' },
        ] as never)).toBe('DISABLED');
        expect(strictestPreference([
            { delivery: 'DISABLED' }, { delivery: 'IMMEDIATE' },
        ] as never)).toBe('DISABLED');
    });

    it('picks DAILY_DIGEST over IMMEDIATE but not over DISABLED', () => {
        expect(strictestPreference([
            { delivery: 'IMMEDIATE' }, { delivery: 'DAILY_DIGEST' },
        ] as never)).toBe('DAILY_DIGEST');
        expect(strictestPreference([
            { delivery: 'DAILY_DIGEST' }, { delivery: 'DISABLED' },
        ] as never)).toBe('DISABLED');
    });

    it('a single IMMEDIATE row stays IMMEDIATE — the positive control', () => {
        // Without this, a function that always returned DISABLED would satisfy
        // every case above.
        expect(strictestPreference([{ delivery: 'IMMEDIATE' }] as never)).toBe('IMMEDIATE');
    });
});

describe('the awake path', () => {
    it('attempts BOTH transports and reports two deliveries', async () => {
        const r = await runPersonPushSend(INPUT);

        expect(r).toEqual({ attempted: 2, delivered: 2 });
        expect(webPush).toHaveBeenCalledTimes(1);
        expect(apns).toHaveBeenCalledTimes(1);
        // The recipient, and the payload's own fields — never a tenant, which
        // this job does not have.
        expect(apns.mock.calls[0][0]).toBe('u-recipient');
        expect(apns.mock.calls[0][1]).toMatchObject({
            title: INPUT.title,
            body: INPUT.body,
            collapseId: INPUT.collapseKey,
        });
    });

    it('reads devices and preferences under the DECLARED bypass reason', async () => {
        await runPersonPushSend(INPUT);
        // One block holding both reads — see the site ceiling's note in
        // `no-untyped-rls-bypass`.
        expect(bypassReasons).toEqual(['person-push-devices']);
    });

    it('passes `undefined` for a null link, never the string "null"', async () => {
        await runPersonPushSend({ ...INPUT, link: null });
        expect(apns.mock.calls[0][1].link).toBeUndefined();
        expect(webPush.mock.calls[0][1].url).toBeUndefined();
    });

    it('one failing transport does NOT cost the other', async () => {
        // A person may hold a phone and a browser, and #2171's accounting is
        // what makes this readable: `delivered` counts transports that reached
        // a DEVICE, so a transport that returned having sent nothing is
        // attempted-and-not-delivered.
        apns.mockResolvedValue({ sent: 0, retryable: 1 });

        const r = await runPersonPushSend(INPUT);

        expect(r).toEqual({ attempted: 2, delivered: 1 });
        expect(webPush).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            'person-push.transport_failed',
            expect.objectContaining({ transport: 'apns' }),
        );
    });

    it('counts a transport that SENT NOTHING as undelivered', async () => {
        // The #2171 regression in its purest form: neither transport throws,
        // so a `delivered += 1` on the absence of a throw would report two.
        webPush.mockResolvedValue({ sent: 0, retryable: 0 });
        apns.mockResolvedValue({ sent: 0, retryable: 0 });

        expect(await runPersonPushSend(INPUT)).toEqual({ attempted: 2, delivered: 0 });
    });
});

describe('the suppressions', () => {
    it('QUIET HOURS suppress rather than defer, and enqueue no summary', async () => {
        // #3020. A tenantless event writes no `Notification` row, so a 06:00
        // summary would have nothing to count — it would wake somebody to tell
        // them about zero things. The person finds the message when they open
        // the app; the SSE frame and the REST read are unaffected.
        at(ASLEEP);

        const r = await runPersonPushSend(INPUT);

        expect(r).toEqual({ attempted: 0, delivered: 0 });
        expect(webPush).not.toHaveBeenCalled();
        expect(apns).not.toHaveBeenCalled();
        // The night key is logged, because that count is the evidence #3020
        // asks for before anybody decides what to build.
        expect(info).toHaveBeenCalledWith(
            'person-push.suppressed',
            expect.objectContaining({ reason: 'quiet-hours', nightKey: expect.any(String) }),
        );
    });

    it('a DISABLED preference in ANY farm suppresses', async () => {
        preferenceRows = [{ delivery: 'IMMEDIATE' }, { delivery: 'DISABLED' }];

        const r = await runPersonPushSend(INPUT);

        expect(r).toEqual({ attempted: 0, delivered: 0 });
        expect(apns).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
            'person-push.suppressed',
            expect.objectContaining({ reason: 'preference-disabled' }),
        );
    });

    it('DAILY_DIGEST suppresses too — the digest IS the delivery', async () => {
        preferenceRows = [{ delivery: 'DAILY_DIGEST' }];
        expect(await runPersonPushSend(INPUT)).toEqual({ attempted: 0, delivered: 0 });
        expect(info).toHaveBeenCalledWith(
            'person-push.suppressed',
            expect.objectContaining({ reason: 'digest-only' }),
        );
    });

    it('NO DEVICES suppresses, and that is checked before quiet hours', async () => {
        // Order matters: a deviceless person inside the window must not be
        // reported as quiet-hours, or an operator reads "the push is coming at
        // 06:00" when it is never coming at all.
        at(ASLEEP);
        subscriptionRows = [];

        await runPersonPushSend(INPUT);

        expect(info).toHaveBeenCalledWith(
            'person-push.suppressed',
            expect.objectContaining({ reason: 'no-devices' }),
        );
    });

    it('the SAME call with devices and no preference DOES send — the control', async () => {
        // Every suppression above is a zero, and a job that always returned
        // zero would satisfy all of them.
        expect(await runPersonPushSend(INPUT)).toEqual({ attempted: 2, delivered: 2 });
    });
});

describe('the device count is deduped per transport identity', () => {
    it('one physical iPhone registered in two farms counts ONCE', async () => {
        // Two rows, same `deviceToken` — which is what one device registered
        // under two farms looks like, because `PushSubscription` is one row
        // per (tenant, user, endpoint).
        //
        // ASSERTED ON THE LOG, and that is the whole point of the log line.
        // The first version of this case asserted `attempted === 1` and
        // `apns` called once, and a mutation that counted ROWS instead of
        // distinct tokens left it GREEN — because each transport is attempted
        // once however many devices it has, so the decision only ever reads
        // zero-ness. The deduped COUNT has exactly one observable
        // consequence, and this is it.
        subscriptionRows = [
            { platform: 'IOS', deviceToken: 'tok-1', endpoint: null },
            { platform: 'IOS', deviceToken: 'tok-1', endpoint: null },
        ];

        const r = await runPersonPushSend(INPUT);

        expect(info).toHaveBeenCalledWith(
            'person-delivery.resolved',
            expect.objectContaining({ devicesIos: 1, rowsRead: 2 }),
        );
        // Both numbers, because `devicesIos: 1` alone is also what ONE row
        // produces — `rowsRead: 2` is what makes it a dedupe rather than a
        // fixture with a single device in it.
        expect(r.attempted).toBe(1);
        expect(apns).toHaveBeenCalledTimes(1);
        expect(webPush).not.toHaveBeenCalled();
    });

    it('a browser registered in two farms counts ONCE too', async () => {
        // The Web Push half: the identity is the ENDPOINT, not the token.
        // Keyed on `id` the dedupe would collapse nothing, because `id` is
        // exactly what differs between the two rows.
        subscriptionRows = [
            { platform: 'WEB', deviceToken: null, endpoint: 'https://push.example/a' },
            { platform: 'WEB', deviceToken: null, endpoint: 'https://push.example/a' },
        ];

        await runPersonPushSend(INPUT);

        expect(info).toHaveBeenCalledWith(
            'person-delivery.resolved',
            expect.objectContaining({ devicesWeb: 1, rowsRead: 2 }),
        );
    });

    it('logs no userId — the decision, not who was messaged', async () => {
        await runPersonPushSend(INPUT);
        const call = info.mock.calls.find((c) => c[0] === 'person-delivery.resolved');
        expect(call).toBeDefined();
        expect(Object.keys(call![1] as object)).not.toContain('userId');
    });

    it('a row with NEITHER identifier is counted by neither transport', async () => {
        // It cannot be sent to, and counting it would make `no-devices`
        // unreachable for a person whose only row is malformed.
        subscriptionRows = [{ platform: 'IOS', deviceToken: null, endpoint: null }];

        await runPersonPushSend(INPUT);

        expect(info).toHaveBeenCalledWith(
            'person-push.suppressed',
            expect.objectContaining({ reason: 'no-devices' }),
        );
    });
});
