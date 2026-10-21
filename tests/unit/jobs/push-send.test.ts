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
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

beforeEach(() => {
    jest.clearAllMocks();
    webPush.mockResolvedValue(undefined);
    apns.mockResolvedValue(undefined);
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
