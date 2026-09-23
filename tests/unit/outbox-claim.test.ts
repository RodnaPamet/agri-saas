/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * The outbox claim, and the schedule that made it necessary.
 *
 * `processOutbox` used to read PENDING rows, send them, and mark them SENT
 * afterwards. That is safe with exactly one runner, and there was exactly one:
 * `daily-evidence-expiry` flushed the outbox at the end of its 06:00 sweep and
 * nothing else did. The cost was measured on production rows — enqueue-to-send
 * latency of 15.35h minimum, 24.44h average, 37.28h maximum, with every SENT
 * row bearing a 06:00 timestamp.
 *
 * Adding a five-minute sweep fixes the latency and breaks the assumption in the
 * same stroke: the new sweep meets the daily one at 06:00 and can meet its own
 * next tick if a send is slow. Two runners over a read-send-then-mark loop both
 * see the same PENDING row and both send it, and the failure mode is a
 * duplicate email to a real person — precisely what an outbox exists to
 * prevent. So the claim and the schedule belong to one change, and this file
 * tests them together.
 */

const mockPrisma = {
    notificationOutbox: {
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: mockPrisma,
    default: mockPrisma,
}));
jest.mock('@/lib/mailer', () => ({ sendEmail: jest.fn() }));
jest.mock('@/app-layer/notifications/settings', () => ({
    getTenantNotificationSettings: jest.fn(),
}));

import { processOutbox } from '@/app-layer/notifications/processOutbox';
import { sendEmail } from '@/lib/mailer';
import { getTenantNotificationSettings } from '@/app-layer/notifications/settings';
import { ALL_SCHEDULES } from '@/app-layer/jobs/schedules';

const mockedSend = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockedSettings = getTenantNotificationSettings as jest.MockedFunction<
    typeof getTenantNotificationSettings
>;

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'row-1',
        tenantId: 'tenant-1',
        type: 'TASK_ASSIGNED',
        toEmail: 'operator@example.test',
        subject: 'subject',
        bodyText: 'body',
        bodyHtml: '',
        attempts: 0,
        dedupeKey: 'dk-1',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockedSettings.mockResolvedValue({
        enabled: true,
        defaultFromName: 'Agrent',
        defaultFromEmail: 'no-reply@example.test',
        complianceMailbox: null,
    } as any);
    mockPrisma.notificationOutbox.update.mockResolvedValue({});
    mockedSend.mockResolvedValue(undefined as any);
});

describe('the outbox claim', () => {
    it('sends a row it successfully claims', async () => {
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row()]);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });

        const result = await processOutbox();

        expect(mockedSend).toHaveBeenCalledTimes(1);
        expect(result.sent).toBe(1);
    });

    it('does NOT send a row another runner claimed first', async () => {
        // The whole point. `count: 0` is what a losing runner sees: the winner
        // already bumped `attempts`, so the compare-and-swap matches nothing.
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row()]);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 0 });

        const result = await processOutbox();

        expect(mockedSend).not.toHaveBeenCalled();
        expect(result.sent).toBe(0);
        expect(result.skipped).toBe(1);
        // And it must not be written as SENT on the strength of a claim it lost.
        expect(mockPrisma.notificationOutbox.update).not.toHaveBeenCalled();
    });

    it('claims on BOTH status and attempts, not on id alone', async () => {
        // Keying the claim on `id` alone would match every time and claim
        // nothing — the test above would still pass while the guarantee was
        // gone, because the mock would still be told `count: 1`. The where
        // clause is the mechanism, so the where clause is what is asserted.
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row({ attempts: 2 })]);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });

        await processOutbox({ maxAttempts: 5 });

        const where = mockPrisma.notificationOutbox.updateMany.mock.calls[0][0].where;
        expect(where).toEqual({ id: 'row-1', status: 'PENDING', attempts: 2 });
        expect(mockPrisma.notificationOutbox.updateMany.mock.calls[0][0].data)
            .toEqual({ attempts: 3 });
    });

    it('spends exactly one attempt per send — the claim, not the claim plus the mark', async () => {
        // `attempts` moved to the claim. Leaving the old `attempts: row.attempts + 1`
        // on the SENT update would burn two per send, so a row would reach
        // maxAttempts in half the retries it is configured for.
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row()]);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });

        await processOutbox();

        const sentUpdate = mockPrisma.notificationOutbox.update.mock.calls[0][0];
        expect(sentUpdate.data.status).toBe('SENT');
        expect(sentUpdate.data).not.toHaveProperty('attempts');
    });

    it('a tenant with notifications disabled is skipped WITHOUT spending an attempt', async () => {
        mockedSettings.mockResolvedValue({ enabled: false } as any);
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row()]);

        const result = await processOutbox();

        expect(mockPrisma.notificationOutbox.updateMany).not.toHaveBeenCalled();
        expect(mockedSend).not.toHaveBeenCalled();
        expect(result.skipped).toBe(1);
    });

    it('a send that throws marks the row without re-incrementing attempts', async () => {
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([row({ attempts: 0 })]);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
        mockedSend.mockRejectedValue(new Error('550 domain not verified'));

        await processOutbox({ maxAttempts: 3 });

        const failUpdate = mockPrisma.notificationOutbox.update.mock.calls[0][0];
        expect(failUpdate.data).not.toHaveProperty('attempts');
        expect(failUpdate.data.status).toBe('PENDING'); // 1 of 3 — still retryable
        expect(failUpdate.data.lastError).toContain('550');
    });
});

describe('platform mail is not silenced by the tenant it is about', () => {
    // `EmailNotificationType`'s own docblock promises INSURANCE_LEAD "is NOT
    // silenced by the tenant's own notification switch". `enqueueEmail` honoured
    // that; `processOutbox` did not, because `audience` gated the enqueue and
    // was never persisted. The row passed the first gate and was skipped at the
    // second on every sweep, for ever.
    beforeEach(() => {
        mockedSettings.mockResolvedValue({
            enabled: false, // the tenant has switched their notifications OFF
            defaultFromName: 'Agrent',
            defaultFromEmail: 'no-reply@example.test',
            complianceMailbox: null,
        } as any);
        mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    });

    it('sends an INSURANCE_LEAD even though the tenant disabled notifications', () => {
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([
            row({ type: 'INSURANCE_LEAD' }),
        ]);
        return processOutbox().then((result) => {
            expect(mockedSend).toHaveBeenCalledTimes(1);
            expect(result.sent).toBe(1);
        });
    });

    it('still silences ordinary tenant mail — the exemption is not a blanket one', () => {
        // The other half of the rule. Without this, "fixing" the gate by
        // deleting the settings check entirely would pass the test above and
        // override a preference every tenant is entitled to.
        mockPrisma.notificationOutbox.findMany.mockResolvedValue([
            row({ type: 'TASK_ASSIGNED' }),
        ]);
        return processOutbox().then((result) => {
            expect(mockedSend).not.toHaveBeenCalled();
            expect(result.skipped).toBe(1);
        });
    });
});

describe('the schedule that delivers the mail', () => {
    const outbox = ALL_SCHEDULES.find((s) => s.name === 'process-outbox');

    it('exists', () => {
        // Without it the only drain is `daily-evidence-expiry` at 06:00 and the
        // 24-hour latency comes straight back.
        expect(outbox).toBeDefined();
    });

    it('is enabled — not key-gated behind an env var', () => {
        // `SCHEDULED_JOBS` filters on `enabled !== false`. A gated entry would
        // silently not register wherever the key is absent, which is how a
        // delivery guarantee becomes environment-dependent.
        expect(outbox?.enabled).not.toBe(false);
    });

    it('runs at least every 15 minutes', () => {
        // The assertion is on the CADENCE, not on the literal string, so
        // tightening `*/5` to `*/2` passes and relaxing it to hourly or daily
        // fails. An operator waiting on an insurance lead is the reason.
        const pattern = outbox?.pattern ?? '';
        const m = /^\*\/(\d+) \* \* \* \*$/.exec(pattern);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeLessThanOrEqual(15);
    });
});
