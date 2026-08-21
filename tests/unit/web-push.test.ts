/**
 * Web Push send unit tests — proves the notification → push fan-out.
 *
 * NOTE ON THE FIXTURES (#696): these used to be `https://push/1`,
 * `https://push/dead` and friends — single-label hosts. Those are now REFUSED,
 * because inside the compose network `redis`, `db` and `pgbouncer` all resolve
 * to 172.18.0.x and a single-label name is neither an IP literal nor a blocked
 * name nor a `.internal` suffix. The fixtures are real push-service endpoints
 * now, which is also what they should always have been: a test that cannot
 * survive the production policy is not testing the production path.
 *
 * Proves:
 *   - configured + subscriptions → one sendNotification per device, with the
 *     JSON payload;
 *   - a 410 Gone response prunes the dead subscription;
 *   - unconfigured (no VAPID keys) → silent no-op (dev/CI/self-hosted).
 *
 * web-push + the tenant-context DB are mocked; the real send/prune wiring in
 * src/lib/notifications/web-push.ts is exercised.
 */
import type { RequestContext } from '@/app-layer/types';

const setVapidDetails = jest.fn();
const sendNotification = jest.fn();
jest.mock('web-push', () => ({
    __esModule: true,
    default: {
        setVapidDetails: (...a: unknown[]) => setVapidDetails(...a),
        sendNotification: (...a: unknown[]) => sendNotification(...a),
    },
}));

const findMany = jest.fn();
const deleteMany = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({ pushSubscription: { findMany, deleteMany } }),
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
const warn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn() },
}));

// The send path now runs the SSRF gate (#696), whose second layer resolves DNS.
// Mocked here for the same reason `automation-action-executor.test.ts` mocks it:
// a unit test must not depend on the network, and the endpoints below are real
// push-service names that would otherwise be looked up for real.
const lookupMock = jest.fn((..._a: unknown[]) =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
);
jest.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

const ctx = { tenantId: 't1', userId: 'u-sender', requestId: 'r1' } as unknown as RequestContext;

function loadWithEnv(vapid: Record<string, string | undefined>) {
    jest.resetModules();
    jest.doMock('@/env', () => ({ env: vapid }));
    return require('@/lib/notifications/web-push') as typeof import('@/lib/notifications/web-push');
}

beforeEach(() => {
    setVapidDetails.mockClear();
    sendNotification.mockClear();
    findMany.mockReset();
    deleteMany.mockReset();
    warn.mockReset();
    lookupMock.mockClear();
    // The DNS verdict cache is module-scoped; without this a verdict from one
    // case decides the next.
    (require('@/app-layer/automation/webhook-safety') as {
        _resetDnsVerdictCache: () => void;
    })._resetDnsVerdictCache();
});

describe('sendWebPushToUser', () => {
    it('sends one push per subscription with the JSON payload when configured', async () => {
        const wp = loadWithEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:x@y.z' });
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'k1', auth: 'a1' },
            { id: 's2', endpoint: 'https://fcm.googleapis.com/fcm/send/2', p256dh: 'k2', auth: 'a2' },
        ]);
        sendNotification.mockResolvedValue(undefined);

        await wp.sendWebPushToUser(ctx, 'u-recipient', { title: 'Assigned', body: 'T-1 is yours', url: '/t/acme/tasks/1' });

        expect(wp.isWebPushConfigured()).toBe(true);
        expect(sendNotification).toHaveBeenCalledTimes(2);
        const [sub, payload] = sendNotification.mock.calls[0];
        expect(sub).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'k1', auth: 'a1' } });
        expect(JSON.parse(payload as string)).toMatchObject({ title: 'Assigned', body: 'T-1 is yours', url: '/t/acme/tasks/1' });
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('prunes a subscription that returns 410 Gone', async () => {
        const wp = loadWithEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
        findMany.mockResolvedValue([
            { id: 'dead', endpoint: 'https://fcm.googleapis.com/fcm/send/dead', p256dh: 'k', auth: 'a' },
            { id: 'live', endpoint: 'https://web.push.apple.com/live', p256dh: 'k', auth: 'a' },
        ]);
        sendNotification.mockImplementation((sub: { endpoint: string }) => {
            if (sub.endpoint.endsWith('/dead')) return Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }));
            return Promise.resolve(undefined);
        });
        deleteMany.mockResolvedValue({ count: 1 });

        await wp.sendWebPushToUser(ctx, 'u-recipient', { title: 'x', body: 'y' });

        expect(deleteMany).toHaveBeenCalledTimes(1);
        expect(deleteMany.mock.calls[0][0]).toEqual({ where: { id: { in: ['dead'] } } });
    });

    it('is a silent no-op when VAPID keys are absent', async () => {
        const wp = loadWithEnv({});
        await wp.sendWebPushToUser(ctx, 'u-recipient', { title: 'x', body: 'y' });
        expect(wp.isWebPushConfigured()).toBe(false);
        expect(sendNotification).not.toHaveBeenCalled();
        expect(findMany).not.toHaveBeenCalled();
    });
});

// ─── #696 — the SSRF gate on the send path ───────────────────────────

/**
 * The write-time schema check cannot help a row stored under an older policy,
 * and a DNS answer can change after the row was written. This is the only seam
 * that re-examines a STORED endpoint, so it is the only one that can claim the
 * SSRF is closed.
 */
describe('sendWebPushToUser — SSRF gate', () => {
    const VAPID = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:x@y.z' };

    it('does not send to a stored endpoint whose host is now refused', async () => {
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://169.254.169.254/x', p256dh: 'k', auth: 'a' },
        ]);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(sendNotification).not.toHaveBeenCalled();
    });

    it('does not send to a host that RESOLVES into private space', async () => {
        // Layer 2. The host is a perfectly ordinary FQDN; only DNS gives it
        // away, which is exactly the case a structural check cannot see.
        const wp = loadWithEnv(VAPID);
        lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://evil.example.com/x', p256dh: 'k', auth: 'a' },
        ]);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(sendNotification).not.toHaveBeenCalled();
    });

    it('NEVER prunes a blocked endpoint', async () => {
        // The load-bearing one. `PushOptIn.tsx:46-49` renders a static "alerts
        // on" span with no button once the BROWSER holds a subscription, and
        // `public/sw.js` has no `pushsubscriptionchange` handler — so deleting
        // the row is permanent, silent notification loss the operator cannot
        // undo. A blocked endpoint is skipped, not reaped.
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://10.0.0.5/x', p256dh: 'k', auth: 'a' },
        ]);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('surfaces a block under its OWN event, not send_failed', async () => {
        // `web-push.send_failed`'s only discriminator is `status`, so a block
        // logged there would arrive as `status: 0` — indistinguishable from a
        // network blip, and invisible to an operator asking "why did nothing
        // arrive?".
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://10.0.0.5/x', p256dh: 'k', auth: 'a' },
        ]);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(warn).toHaveBeenCalledWith(
            'web-push.endpoint_blocked',
            expect.objectContaining({ component: 'web-push', host: '10.0.0.5' }),
        );
    });

    it('never logs the endpoint path — it is a capability URL', async () => {
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://10.0.0.5/secret-capability-token', p256dh: 'k', auth: 'a' },
        ]);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-capability-token');
    });

    it('one blocked endpoint does not stop the others', async () => {
        // Resolving power in the other direction: the gate partitions, it does
        // not abort the fan-out.
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 'bad', endpoint: 'https://10.0.0.5/x', p256dh: 'k', auth: 'a' },
            { id: 'ok', endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh: 'k', auth: 'a' },
        ]);
        sendNotification.mockResolvedValue(undefined);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(sendNotification.mock.calls[0][0].endpoint).toBe(
            'https://fcm.googleapis.com/fcm/send/ok',
        );
    });

    it('passes a socket timeout — web-push has none of its own', async () => {
        // `web-push-lib.js:222` only sets `httpsOptions.timeout` when the
        // caller supplies one. Without it a send to a blackholed address hangs
        // the calling request indefinitely, which also widens the TOCTOU window
        // between the DNS check and the connection.
        const wp = loadWithEnv(VAPID);
        findMany.mockResolvedValue([
            { id: 's1', endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'k', auth: 'a' },
        ]);
        sendNotification.mockResolvedValue(undefined);
        await wp.sendWebPushToUser(ctx, 'u', { title: 'T', body: 'B' });
        expect(sendNotification.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) });
    });
});
