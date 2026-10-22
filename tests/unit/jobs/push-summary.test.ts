/**
 * The 06:00 quiet-hours summary — P7.5 (#1994).
 *
 * The two properties worth protecting are both about what it does NOT send: a
 * zero-count push at six in the morning, and a count that includes
 * notifications the window never held back.
 */
const webPush = jest.fn();
const apns = jest.fn();
const info = jest.fn();
const warn = jest.fn();
let notificationCount = 0;
let countArgs: unknown = null;
let userRow: { uiLanguage: string | null } | null = { uiLanguage: 'bg' };
/**
 * The preference and device counts the job reads alongside the count.
 *
 * It asks `resolveDelivery` at 06:00 rather than only re-checking the clock,
 * because the night is eight hours long: somebody can turn push off at 23:00,
 * and a summary that skipped the decision would deliver exactly the push they
 * had just refused.
 */
let preferenceRow: { delivery: string } | null = null;
let deviceRows: Array<{ platform: string; _count: { _all: number } }> = [
    { platform: 'WEB', _count: { _all: 1 } },
    { platform: 'IOS', _count: { _all: 1 } },
];

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            notification: {
                count: async (args: unknown) => {
                    countArgs = args;
                    return notificationCount;
                },
            },
            userNotificationPreference: { findUnique: async () => preferenceRow },
            pushSubscription: { groupBy: async () => deviceRows },
        }),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { user: { findUnique: async () => userRow } },
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
        info: (...a: unknown[]) => info(...a),
        warn: (...a: unknown[]) => warn(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { runPushSummary } from '@/app-layer/jobs/push-summary';

const payload = { tenantId: 't-1', recipientUserId: 'u-2', nightKey: '2026-11-05' };

beforeEach(() => {
    jest.clearAllMocks();
    // A `TransportOutcome`, not `undefined` — #2171. See
    // `push-send.test.ts`: a double resolving nothing is indistinguishable
    // from a transport that delivered nothing, which is how this job came to
    // report every wanted transport as delivered.
    webPush.mockResolvedValue({ sent: 1, retryable: 0 });
    apns.mockResolvedValue({ sent: 1, retryable: 0 });
    notificationCount = 3;
    countArgs = null;
    userRow = { uiLanguage: 'bg' };
    preferenceRow = null;
    deviceRows = [
        { platform: 'WEB', _count: { _all: 1 } },
        { platform: 'IOS', _count: { _all: 1 } },
    ];
    // Outside the quiet window, so the 06:00 decision grants both channels —
    // which is what a summary job's own fire time looks like.
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 10, 6, 4, 0, 0)));
});

afterEach(() => {
    jest.useRealTimers();
});

describe('runPushSummary', () => {
    it('sends ONE push, not one per notification', async () => {
        notificationCount = 10;

        const r = await runPushSummary(payload);

        expect(webPush).toHaveBeenCalledTimes(1);
        expect(apns).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ count: 10, delivered: 2 });
    });

    it('sends NOTHING when the person read their bell overnight', async () => {
        // The case most worth not getting wrong: "Имате 0 нови известия" at
        // six in the morning is the push this whole design exists to avoid.
        notificationCount = 0;

        const r = await runPushSummary(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).not.toHaveBeenCalled();
        expect(r).toEqual({ count: 0, delivered: 0 });
        expect(info).toHaveBeenCalledWith('push.summary_empty', expect.anything());
    });

    it('counts only the window, and only unread', async () => {
        await runPushSummary(payload);

        const where = (countArgs as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({ userId: 'u-2', read: false });
        // A bounded range, not "everything unread": a notification from 21:00
        // already pushed normally, so including it would buzz twice about
        // something the person may have read and dismissed.
        const createdAt = where.createdAt as { gte: Date; lt: Date };
        expect(createdAt.gte).toBeInstanceOf(Date);
        expect(createdAt.lt).toBeInstanceOf(Date);
        expect(createdAt.lt.getTime()).toBeGreaterThan(createdAt.gte.getTime());
    });

    it('queries the window the NIGHT KEY names, not the hour it runs at', async () => {
        // By the time this fires, `now` is 06:00 and OUTSIDE the window it has
        // to describe — which is why the payload carries a key rather than the
        // job reading its own clock.
        await runPushSummary(payload);

        const { gte, lt } = (countArgs as { where: { createdAt: { gte: Date; lt: Date } } }).where
            .createdAt;
        const hourIn = (d: Date) =>
            Number(
                new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Europe/Sofia',
                    hour: '2-digit',
                    hourCycle: 'h23',
                }).format(d),
            );
        const dayIn = (d: Date) =>
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Sofia',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(d);

        expect(hourIn(gte)).toBe(22);
        expect(dayIn(gte)).toBe('2026-11-05');
        expect(hourIn(lt)).toBe(6);
        expect(dayIn(lt)).toBe('2026-11-06');
    });

    it('opens the bell rather than a single task', async () => {
        // The summary is about several notifications; there is no one target.
        await runPushSummary(payload);

        expect(webPush.mock.calls[0][2]).toMatchObject({ url: '/notifications' });
        expect(apns.mock.calls[0][2]).toMatchObject({ link: '/notifications' });
    });

    it('collapses on the night, so a second summary replaces rather than stacks', async () => {
        await runPushSummary(payload);

        expect(webPush.mock.calls[0][2]).toMatchObject({ tag: 'quiet-summary-2026-11-05' });
        expect(apns.mock.calls[0][2]).toMatchObject({ collapseId: 'quiet-summary-2026-11-05' });
    });

    describe('copy', () => {
        it('is grammatical at ONE — the common case, not an edge', async () => {
            notificationCount = 1;

            await runPushSummary(payload);

            const body = (webPush.mock.calls[0][2] as { body: string }).body;
            expect(body).toBe('Имате 1 ново известие.');
            // Specifically NOT the plural form with a 1 substituted, which is
            // what a single-key implementation produces.
            expect(body).not.toContain('нови известия');
        });

        it('is grammatical above one', async () => {
            notificationCount = 4;

            await runPushSummary(payload);

            expect((webPush.mock.calls[0][2] as { body: string }).body).toBe(
                'Имате 4 нови известия.',
            );
        });

        it('is in the RECIPIENT’s language, not a default', async () => {
            userRow = { uiLanguage: 'en' };
            notificationCount = 2;

            await runPushSummary(payload);

            expect((webPush.mock.calls[0][2] as { body: string }).body).toBe(
                'You have 2 new notifications.',
            );
        });

        it('falls back rather than rendering a raw key when uiLanguage is absent', async () => {
            userRow = { uiLanguage: null };

            await runPushSummary(payload);

            const body = (webPush.mock.calls[0][2] as { body: string }).body;
            expect(body).not.toContain('push.quietSummary');
            expect(body.length).toBeGreaterThan(0);
        });
    });

    it('one failing transport does not cost the other', async () => {
        apns.mockRejectedValue(new Error('apns down'));

        const r = await runPushSummary(payload);

        expect(webPush).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ count: 3, delivered: 1 });
    });

    it('does NOT throw when both fail — a retry would be the wrong shape', async () => {
        // `attempts: 1` in JOB_DEFAULTS, because a retry either re-sends the
        // same summary seconds later or sends one about a window that has
        // since closed. The bell is the fallback it has been all night.
        webPush.mockRejectedValue(new Error('push service down'));
        apns.mockRejectedValue(new Error('apns down'));

        await expect(runPushSummary(payload)).resolves.toEqual({ count: 3, delivered: 0 });
    });

    it('reports a transport that failed WITHOUT throwing as undelivered', async () => {
        // The shape the real senders produce — #2171. Both failure tests above
        // mock a throw, which neither transport does, so this job's
        // `push.summary_sent` counter reported deliveries it had not made.
        apns.mockResolvedValue({ sent: 0, retryable: 2 });

        const r = await runPushSummary(payload);

        expect(r).toEqual({ count: 3, delivered: 1 });
        expect(info).toHaveBeenCalledWith(
            'push.summary_sent',
            expect.objectContaining({ delivered: 1, failures: 1 }),
        );
    });

    it('still does not throw when neither transport reached a device', async () => {
        // `attempts: 1` is unchanged by #2171: a retried summary either
        // duplicates or describes a window that has closed. What changes is
        // that the COUNT now says nothing arrived.
        webPush.mockResolvedValue({ sent: 0, retryable: 1 });
        apns.mockResolvedValue({ sent: 0, retryable: 1 });

        await expect(runPushSummary(payload)).resolves.toEqual({ count: 3, delivered: 0 });
    });

    it('logs the count and the night, never the prose', async () => {
        await runPushSummary(payload);

        expect(info).toHaveBeenCalledWith(
            'push.summary_sent',
            expect.objectContaining({ nightKey: '2026-11-05', count: 3 }),
        );
        expect(JSON.stringify(info.mock.calls)).not.toContain('Имате');
    });
});

describe('the 06:00 decision is taken again, not assumed', () => {
    it('sends nothing when push was DISABLED during the night', async () => {
        // The gap this closes: the window is eight hours long, so somebody can
        // turn push off at 23:00. A summary that re-checked only the clock
        // would deliver at 06:00 exactly the push they had refused.
        preferenceRow = { delivery: 'DISABLED' };

        const r = await runPushSummary(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).not.toHaveBeenCalled();
        expect(r).toEqual({ count: 3, delivered: 0 });
        expect(info).toHaveBeenCalledWith(
            'push.summary_suppressed',
            expect.objectContaining({ reason: 'preference-disabled', count: 3 }),
        );
    });

    it('sends nothing when the devices are gone by morning', async () => {
        // A person who signed out on every device overnight. The count is
        // still reported, so the job's own result stays honest about what it
        // found versus what it sent.
        deviceRows = [];

        const r = await runPushSummary(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(r).toEqual({ count: 3, delivered: 0 });
    });

    it('asks only for the transports still held', async () => {
        deviceRows = [{ platform: 'IOS', _count: { _all: 2 } }];

        const r = await runPushSummary(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(apns).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ count: 3, delivered: 1 });
    });

    it('drops rather than re-defers if it somehow runs inside the NEXT window', async () => {
        // Only reachable on a backlog of eight hours or more. Chaining a
        // summary into the following night would announce a window two nights
        // old, and those rows are in the bell either way.
        jest.setSystemTime(new Date(Date.UTC(2026, 10, 6, 21, 0, 0))); // 23:00 Sofia

        const r = await runPushSummary(payload);

        expect(webPush).not.toHaveBeenCalled();
        expect(r).toEqual({ count: 3, delivered: 0 });
        expect(warn).toHaveBeenCalledWith('push.summary_too_late', expect.anything());
        // And ONLY that reason. Falling through to the suppression branch
        // produces the same delivery outcome, so the result alone cannot tell
        // the two apart — but it logs a second, different reason for one
        // event, and an operator reading both cannot tell which applied.
        const reasons = info.mock.calls.map((c) => c[0]);
        expect(reasons).not.toContain('push.summary_suppressed');
    });
});
