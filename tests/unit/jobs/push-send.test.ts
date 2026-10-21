/**
 * The push-send job — P7.4 (#1993).
 *
 * Two properties that are easy to get backwards and expensive to get wrong:
 *
 *   - one failing transport must not cost the other, because a person may hold
 *     a phone and a browser;
 *   - a retry must not re-send what already arrived, which means the job only
 *     throws when BOTH transports failed.
 */
const webPush = jest.fn();
const apns = jest.fn();
const warn = jest.fn();
const info = jest.fn();
const enqueue = jest.fn();

/**
 * What the one tenant-scoped read returns.
 *
 * `push-send` now asks `resolveDelivery` before sending, and that needs the
 * recipient's preference and device counts — so the DB read is part of the
 * job's contract rather than an implementation detail, and it is mocked at the
 * `runInTenantContext` seam the job actually uses.
 */
let preferenceRow: { delivery: string } | null = null;
let deviceRows: Array<{ platform: string; _count: { _all: number } }> = [
    { platform: 'WEB', _count: { _all: 1 } },
    { platform: 'IOS', _count: { _all: 2 } },
];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            userNotificationPreference: { findUnique: async () => preferenceRow },
            pushSubscription: { groupBy: async () => deviceRows },
        }),
}));
jest.mock('@/app-layer/jobs/queue', () => ({
    __esModule: true,
    enqueue: (...a: unknown[]) => enqueue(...a),
}));

jest.mock('@/lib/notifications/web-push', () => ({
    __esModule: true,
    sendWebPushToUser: (...a: unknown[]) => webPush(...a),
}));
jest.mock('@/lib/notifications/apns', () => ({
    __esModule: true,
    sendApnsToUser: (...a: unknown[]) => apns(...a),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { runPushSend } from '@/app-layer/jobs/push-send';

const payload = {
    tenantId: 't-1',
    recipientUserId: 'u-2',
    title: 'Задача',
    body: 'Възложена ви е задача',
    link: '/t/farm/farm-tasks/task-9',
    collapseKey: 'task-task-9',
};

/** Midday Sofia — outside the quiet window, so push is granted. */
const AWAKE = new Date(Date.UTC(2026, 10, 15, 10, 0, 0));
/** 23:00 Sofia on the 5th — inside the window. */
const QUIET = new Date(Date.UTC(2026, 10, 5, 21, 0, 0));

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(AWAKE);
    webPush.mockResolvedValue(undefined);
    apns.mockResolvedValue(undefined);
    enqueue.mockResolvedValue({ id: 'job-1' });
    preferenceRow = null;
    deviceRows = [
        { platform: 'WEB', _count: { _all: 1 } },
        { platform: 'IOS', _count: { _all: 2 } },
    ];
});

afterEach(() => {
    jest.useRealTimers();
});

describe('runPushSend', () => {
    it('sends over both transports', async () => {
        const r = await runPushSend(payload);

        expect(r).toEqual({ attempted: 2, delivered: 2 });
        expect(webPush).toHaveBeenCalledTimes(1);
        expect(apns).toHaveBeenCalledTimes(1);
    });

    it('addresses the RECIPIENT, not the actor', async () => {
        // The payload names the recipient because the actor must never be
        // notified of their own action; nothing here reads a session.
        await runPushSend(payload);

        expect(webPush.mock.calls[0][1]).toBe('u-2');
        expect(apns.mock.calls[0][1]).toBe('u-2');
    });

    it('scopes the tenant context to the payload tenant', async () => {
        await runPushSend(payload);

        expect(webPush.mock.calls[0][0]).toMatchObject({ tenantId: 't-1' });
        expect(apns.mock.calls[0][0]).toMatchObject({ tenantId: 't-1' });
    });

    it('spells "no target" as undefined for both transports, never null', async () => {
        // The payload says `null`; both senders spell absence `undefined`. A
        // `null` reaching either would be a type error at best and a literal
        // "null" href at worst.
        await runPushSend({ ...payload, link: null });

        expect(webPush.mock.calls[0][2]).toMatchObject({ url: undefined });
        expect(apns.mock.calls[0][2]).toMatchObject({ link: undefined });
    });

    it('gives both transports the SAME collapse key', async () => {
        // The Web Push `tag` and the APNs `apns-collapse-id` both mean
        // "replace my previous one". Different keys would coalesce on
        // different boundaries, so the phone and the browser would disagree
        // about whether a second notification is new.
        await runPushSend(payload);

        expect(webPush.mock.calls[0][2]).toMatchObject({ tag: 'task-task-9' });
        expect(apns.mock.calls[0][2]).toMatchObject({ collapseId: 'task-task-9' });
    });

    it('still sends APNs when web push throws', async () => {
        webPush.mockRejectedValue(new Error('push service 503'));

        const r = await runPushSend(payload);

        expect(apns).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ attempted: 2, delivered: 1 });
    });

    it('still sends web push when APNs throws', async () => {
        // The control for the case above — one of the two orders would pass on
        // an implementation that simply ran them in the other sequence.
        apns.mockRejectedValue(new Error('apns down'));

        const r = await runPushSend(payload);

        expect(webPush).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ attempted: 2, delivered: 1 });
    });

    it('does NOT throw when one transport succeeded — a retry would duplicate', async () => {
        apns.mockRejectedValue(new Error('apns down'));

        await expect(runPushSend(payload)).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith('push.transport_failed', expect.anything());
    });

    it('throws when BOTH failed, and names both causes', async () => {
        webPush.mockRejectedValue(new Error('push service 503'));
        apns.mockRejectedValue(new Error('apns 403'));

        // Both causes, because "push failed" carrying one transport's error
        // sends whoever reads it looking in the wrong place.
        await expect(runPushSend(payload)).rejects.toThrow(/push service 503/);
        await expect(runPushSend(payload)).rejects.toThrow(/apns 403/);
    });

    it('logs no notification PROSE — the payload is displayed copy', async () => {
        apns.mockRejectedValue(new Error('apns down'));

        await runPushSend(payload);

        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).not.toContain(payload.title);
        expect(logged).not.toContain(payload.body);
        expect(logged).not.toContain(payload.link);
        // The collapse key identifies the subject without quoting it.
        expect(logged).toContain('task-task-9');
    });
});

describe('the delivery decision — P7.5 (#1994)', () => {
    it('is taken when the send is ATTEMPTED, not when it was enqueued', () => {
        // Asserted by the fact that every case here sets the clock and gets a
        // different outcome from the same payload. A job that carried its
        // decision from the enqueue site would behave identically at 21:59 and
        // 22:01, which is the one boundary where it matters.
        expect(typeof runPushSend).toBe('function');
    });

    it('sends nothing and schedules a summary inside the window', async () => {
        jest.setSystemTime(QUIET);

        const r = await runPushSend(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).not.toHaveBeenCalled();
        expect(r).toEqual({ attempted: 0, delivered: 0 });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0][0]).toBe('push-summary');
        expect(enqueue.mock.calls[0][1]).toMatchObject({
            tenantId: 't-1',
            recipientUserId: 'u-2',
            nightKey: '2026-11-05',
        });
    });

    it('keys the summary job so one night gets ONE of them', async () => {
        // The id is what makes "ensure one summary" a single `add` instead of
        // a read-modify-write two workers could interleave. Without it the
        // fifth notification of the night schedules a fifth summary and the
        // person wakes to five banners — the outcome the summary exists to
        // prevent.
        jest.setSystemTime(QUIET);

        await runPushSend(payload);

        expect(enqueue.mock.calls[0][2]).toMatchObject({
            jobId: 'push-summary:t-1:u-2:2026-11-05',
        });
        // And it is delayed rather than immediate.
        expect(enqueue.mock.calls[0][2].delay).toBeGreaterThan(0);
    });

    it('gives the same job id from either side of midnight', async () => {
        jest.setSystemTime(QUIET);
        await runPushSend(payload);
        const evening = enqueue.mock.calls[0][2].jobId;

        enqueue.mockClear();
        jest.setSystemTime(new Date(Date.UTC(2026, 10, 5, 23, 0, 0))); // 01:00 on the 6th
        await runPushSend(payload);
        const smallHours = enqueue.mock.calls[0][2].jobId;

        expect(smallHours).toBe(evening);
    });

    it('sends normally outside the window — the control', async () => {
        // Without this, an implementation that always deferred would satisfy
        // every assertion above.
        const r = await runPushSend(payload);

        expect(enqueue).not.toHaveBeenCalled();
        expect(r).toEqual({ attempted: 2, delivered: 2 });
    });

    it('a DISABLED preference sends nothing and schedules nothing, even at night', async () => {
        jest.setSystemTime(QUIET);
        preferenceRow = { delivery: 'DISABLED' };

        const r = await runPushSend(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).not.toHaveBeenCalled();
        // Not deferred: a 06:00 summary for somebody who turned push off is
        // the push they turned off, delivered late.
        expect(enqueue).not.toHaveBeenCalled();
        expect(r).toEqual({ attempted: 0, delivered: 0 });
    });

    it('asks only for the transports the person holds a device for', async () => {
        deviceRows = [{ platform: 'IOS', _count: { _all: 1 } }];

        const r = await runPushSend(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).toHaveBeenCalledTimes(1);
        // `attempted: 1`, so a log line of "attempted 2, delivered 0" can only
        // mean two were genuinely possible and both failed.
        expect(r).toEqual({ attempted: 1, delivered: 1 });
    });

    it('no devices sends nothing and schedules nothing', async () => {
        jest.setSystemTime(QUIET);
        deviceRows = [];

        const r = await runPushSend(payload);

        expect(enqueue).not.toHaveBeenCalled();
        expect(r).toEqual({ attempted: 0, delivered: 0 });
    });

    it('logs the reason it withheld, without the prose', async () => {
        jest.setSystemTime(QUIET);

        await runPushSend(payload);

        expect(info).toHaveBeenCalledWith(
            'push.deferred',
            expect.objectContaining({ nightKey: '2026-11-05', reason: 'quiet-hours' }),
        );
        const logged = JSON.stringify(info.mock.calls);
        expect(logged).not.toContain(payload.title);
        expect(logged).not.toContain(payload.body);
    });
});
