/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks/shims;
 * the file-level disable is the codebase's standard pattern for test
 * surfaces that mirror Prisma + usecase contracts. */
/**
 * Unit tests for the agro-signals usecase.
 *
 * Verifies the rule → AgroSignal claim → Notification side
 * effects, and (the key invariant) that a same-day re-run does NOT
 * duplicate the notification because the AgroSignal
 * unique-claim collapses (createMany returns count=0).
 */

// ── mockDb shared across runs ──
const mockDb: any = {
    location: { findFirst: jest.fn() },
    weatherObservation: { findMany: jest.fn() },
    agroSignal: { createMany: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));


const createAgroNotificationMock = jest.fn().mockResolvedValue({ status: 'created' });
jest.mock('@/app-layer/notifications/agro', () => ({
    createAgroSignalNotification: (...args: any[]) => createAgroNotificationMock(...args),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { evaluateLocationSignals } from '@/app-layer/usecases/agro-signals';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', tenantSlug: 'acme' });
const NOW = new Date('2026-06-15T09:00:00Z');

/** A warm-wet day that is BOTH disease-conducive and spray-UNSUITABLE. */
function warmWetDay(offsetDays: number) {
    const d = new Date(Date.UTC(2026, 5, 15 - offsetDays));
    return {
        obsDate: d,
        tempMaxC: 24,
        tempMinC: 14,
        tempMeanC: 19, // disease band [10,30]; spray band [5,28] OK
        precipMm: 6, // ≥ 2 ⇒ spray UNSUITABLE; ≥ 0.2 ⇒ conducive
        windMaxKmh: 8,
        humidityMean: 93, // ≥ 90 ⇒ conducive
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.notification.createMany.mockResolvedValue({ count: 1 });
    mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1', name: 'Home Field', ownerUserId: 'owner-1' });
    // 5 consecutive warm-wet days incl. today.
    mockDb.weatherObservation.findMany.mockResolvedValue(
        [4, 3, 2, 1, 0].map(warmWetDay),
    );
    mockDb.agroSignal.updateMany.mockResolvedValue({ count: 1 });
});

describe('evaluateLocationSignals — first run (signals fire)', () => {
    it('claims both signals and notifies the owner', async () => {
        // Both claims succeed (NEW rows).
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        // Two new signals created.
        expect(result.created).toBe(2);
        expect(result.spray.fired).toBe(true);
        expect(result.spray.status).toBe('UNSUITABLE');
        expect(result.disease.fired).toBe(true);
        expect(result.disease.level).toBe('HIGH');

        // Two notifications — spray + disease — to the location owner.
        expect(createAgroNotificationMock).toHaveBeenCalledTimes(2);
        const kinds = createAgroNotificationMock.mock.calls.map((c) => c[1]);
        expect(kinds).toContain('SPRAY_WINDOW_WARNING');
        expect(kinds).toContain('DISEASE_RISK_RAISED');
        for (const call of createAgroNotificationMock.mock.calls) {
            expect(call[2].recipientUserId).toBe('owner-1');
        }
    });

    it('falls back to the ctx admin user when the location has no owner', async () => {
        mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1', name: 'Home Field', ownerUserId: null });
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        for (const call of createAgroNotificationMock.mock.calls) {
            expect(call[2].recipientUserId).toBe(ctx.userId);
        }
    });
});

describe('evaluateLocationSignals — idempotent re-run (no duplicates)', () => {
    it('a same-day re-run claims nothing → no Risk, no notification', async () => {
        // The unique-claim collapses on the second run: count=0 for both.
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 0 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        expect(result.created).toBe(0);
        expect(result.spray.fired).toBe(false);
        expect(result.disease.fired).toBe(false);
        // No Risk and no notification on the duplicate day.
        expect(createAgroNotificationMock).not.toHaveBeenCalled();
    });
});

describe('evaluateLocationSignals — calm/dry weather (no signals)', () => {
    it('does not claim signals when the window is GOOD + disease LOW', async () => {
        mockDb.weatherObservation.findMany.mockResolvedValue([
            { obsDate: new Date(Date.UTC(2026, 5, 15)), tempMaxC: 20, tempMinC: 12, tempMeanC: 16, precipMm: 0, windMaxKmh: 6, humidityMean: 55 },
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        expect(result.created).toBe(0);
        expect(mockDb.agroSignal.createMany).not.toHaveBeenCalled();
    });

    it('returns early (no throw) when the location is missing', async () => {
        mockDb.location.findFirst.mockResolvedValue(null);
        const result = await evaluateLocationSignals(ctx, 'loc-x', NOW);
        expect(result.created).toBe(0);
    });
});
