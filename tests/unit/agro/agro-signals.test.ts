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
    agroSignal: { createMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
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
    mockDb.agroSignal.deleteMany.mockResolvedValue({ count: 0 });
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

    // ── #2490: the recipient's LANGUAGE, and the reason rendered in it ──
    //
    // The notification writer is doubled here, so these assert the WIRING:
    // that the locale reaching it is the owner's rather than a default, and
    // that `detail` is a rendered sentence rather than `reasons[0]`, which
    // is English whatever the recipient speaks.

    it('threads the owner uiLanguage through as the notification locale', async () => {
        mockDb.location.findFirst.mockResolvedValue({
            id: 'loc-1', name: 'Home Field', ownerUserId: 'owner-1',
            owner: { uiLanguage: 'en' },
        });
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        expect(createAgroNotificationMock).toHaveBeenCalledTimes(2);
        for (const call of createAgroNotificationMock.mock.calls) {
            expect(call[2].locale).toBe('en');
        }
    });

    it('falls back to bg — the column default — when the preference is absent', async () => {
        // The fixture deliberately omits `owner`, which is the unowned-location
        // case: notified to ctx.userId, whose language this query never read.
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        for (const call of createAgroNotificationMock.mock.calls) {
            expect(call[2].locale).toBe('bg');
        }
    });

    it('passes a RENDERED reason as the detail, not the English sentence', async () => {
        mockDb.location.findFirst.mockResolvedValue({
            id: 'loc-1', name: 'Home Field', ownerUserId: 'owner-1',
            owner: { uiLanguage: 'bg' },
        });
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        const byKind = new Map(createAgroNotificationMock.mock.calls.map((c) => [c[1], c[2]]));

        // warmWetDay() is 6 mm of rain, so the first spray reason is the
        // wash-off one. The English sentence that used to be passed here
        // reads 'Rain 6 mm — wash-off risk (limit 2 mm)'.
        const spray = byKind.get('SPRAY_WINDOW_WARNING');
        expect(spray.detail).toBe('Дъжд 6 мм — риск от отмиване (граница 2 мм)');
        expect(spray.detail).not.toMatch(/[A-Za-z]/);

        // 5 consecutive conducive days; the count rides AFTER a label
        // because `translateFor` has no ICU.
        const disease = byKind.get('DISEASE_RISK_RAISED');
        expect(disease.detail).toBe('Топло-влажни дни подред: 5 — благоприятни за листни болести');
        expect(disease.detail).not.toMatch(/[A-Za-z]/);
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

/**
 * A FORECAST day, cold enough to warrant a frost warning.
 *
 * Positive offsets, unlike `warmWetDay`'s: the existing fixture walks
 * BACKWARDS from today and every one of its days is at 14 degrees C, which is
 * why the suites above claim no frost and stay about what they were written
 * for.
 */
function frostyForecastDay(offsetDays: number, tempMinC: number | null = 1) {
    const d = new Date(Date.UTC(2026, 5, 15 + offsetDays));
    return {
        obsDate: d,
        tempMaxC: 9,
        tempMinC,
        // Calm and dry, so neither of the other two signals fires and a frost
        // assertion cannot be satisfied by a spray or disease claim.
        tempMeanC: 5,
        precipMm: 0,
        windMaxKmh: 4,
        humidityMean: 60,
    };
}

/** The `data[0]` of every createMany call, by kind. */
function claimsOfKind(kind: string) {
    return (mockDb.agroSignal.createMany.mock.calls as unknown[][])
        .map((c) => (c[0] as { data: Array<Record<string, unknown>> }).data[0])
        .filter((row: Record<string, unknown>) => row.kind === kind);
}

describe('FROST_RISK — claimed per forecast day (#3077)', () => {
    it('claims a row for each cold forecast day and notifies ONCE, naming the nearest', async () => {
        mockDb.weatherObservation.findMany.mockResolvedValue([
            warmWetDay(0), // today, 14 degrees C — not frost
            frostyForecastDay(1, 1.5),
            frostyForecastDay(2, -2),
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        const frost = claimsOfKind('FROST_RISK');
        expect(frost).toHaveLength(2);
        expect(frost.map((r) => (r.signalDate as Date).toISOString().slice(0, 10))).toEqual([
            '2026-06-16',
            '2026-06-17',
        ]);
        expect(result.frost.fired).toBe(true);
        expect(result.frost.days).toEqual(['2026-06-16', '2026-06-17']);

        /*
         * ONE notification for the snap, not one per day — three pushes about
         * one cold spell is how somebody turns notifications off.
         *
         * Asserted on `createAgroNotificationMock` and NOT on
         * `notification.createMany`: this suite mocks the notification factory,
         * so the Prisma call never happens and a `createMany` assertion reads
         * zero whatever the code does. My first version asserted the wrong
         * collector and failed for that reason rather than for a defect.
         */
        // `createAgroSignalNotification(db, kind, target, now)` — so the KIND
        // is argument 1 and the target argument 2. Reading index 0 as the kind
        // is what my first version did, and it reported zero calls rather than
        // a wrong one: an index mistake in a mock reader looks exactly like the
        // code never running.
        const frostCalls = (createAgroNotificationMock.mock.calls as unknown[][]).filter(
            (c: unknown[]) => c[1] === 'FROST_RISK_WARNING',
        );
        expect(frostCalls).toHaveLength(1);
        const target = frostCalls[0][2] as { detail: string; locale: string };
        // Naming the NEAREST day, not the coldest — `obs` is ascending and the
        // detail is rendered from the first day claimed.
        expect(target.detail).toContain('2026-06-16');
        expect(target.detail).not.toContain('2026-06-17');
        // Bulgarian, because the location has no owner preference and `bg` is
        // the column default — the same rule as its two siblings.
        expect(target.locale).toBe('bg');
        expect(target.detail).toMatch(/слана/);

        // Both days are marked notified, so neither can be re-claimed or
        // retracted later.
        type UpdateArg = { where: { kind?: string; signalDate?: { in?: Date[] } } };
        const marked = (mockDb.agroSignal.updateMany.mock.calls as unknown[][])
            .map((c) => c[0] as UpdateArg)
            .find((a: UpdateArg) => a.where.kind === 'FROST_RISK');
        expect(marked?.where.signalDate?.in?.map((d) => d.toISOString().slice(0, 10))).toEqual([
            '2026-06-16',
            '2026-06-17',
        ]);
    });

    it('claims nothing when the forecast stays above the threshold', async () => {
        mockDb.weatherObservation.findMany.mockResolvedValue([
            warmWetDay(0),
            frostyForecastDay(1, 2.1),
            frostyForecastDay(2, 8),
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        expect(claimsOfKind('FROST_RISK')).toHaveLength(0);
        expect(result.frost.fired).toBe(false);
        // The control: 2.1 is above and 2.0 is not, so the boundary is where
        // the ruling put it rather than a degree either side.
        mockDb.agroSignal.createMany.mockClear();
        mockDb.weatherObservation.findMany.mockResolvedValue([frostyForecastDay(1, 2)]);
        await evaluateLocationSignals(ctx, 'loc-1', NOW);
        expect(claimsOfKind('FROST_RISK')).toHaveLength(1);
    });

    it('ignores a cold day that has already PASSED', async () => {
        // A frost last Tuesday is not a reason to refuse to sow next week, and
        // back-filling would suppress advice on days already gone.
        mockDb.weatherObservation.findMany.mockResolvedValue([
            { ...warmWetDay(3), tempMinC: -5 },
            { ...warmWetDay(1), tempMinC: -5 },
            warmWetDay(0),
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        expect(claimsOfKind('FROST_RISK')).toHaveLength(0);
    });

    it('treats a MISSING minimum as unknown, never as clear', async () => {
        mockDb.weatherObservation.findMany.mockResolvedValue([
            warmWetDay(0),
            frostyForecastDay(1, null),
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });

        await evaluateLocationSignals(ctx, 'loc-1', NOW);

        // No claim — we may not warn on a day we know nothing about…
        expect(claimsOfKind('FROST_RISK')).toHaveLength(0);
        // …and no retraction of it either, which is the half that matters:
        // deleting a row for an unforecast day would be a claim that the day
        // is clear. The delete is bounded by the horizon for that reason.
        const del = mockDb.agroSignal.deleteMany.mock.calls[0]?.[0] as
            | { where: { signalDate: { gt: Date; lte: Date } } }
            | undefined;
        expect(del).toBeDefined();
        expect(del?.where.signalDate.lte.toISOString().slice(0, 10)).toBe('2026-06-16');
    });

    it('retracts only FUTURE, UN-NOTIFIED rows the forecast no longer supports', async () => {
        mockDb.weatherObservation.findMany.mockResolvedValue([
            warmWetDay(0),
            frostyForecastDay(1, 1),
            frostyForecastDay(2, 7), // warmed up — any row here must go
        ]);
        mockDb.agroSignal.createMany.mockResolvedValue({ count: 1 });
        mockDb.agroSignal.deleteMany.mockResolvedValue({ count: 1 });

        const result = await evaluateLocationSignals(ctx, 'loc-1', NOW);

        const where = (mockDb.agroSignal.deleteMany.mock.calls[0][0] as {
            where: Record<string, unknown>;
        }).where;
        // A notified row stands whatever the forecast now says — that is what
        // makes "never notify twice about one day" a property of the data
        // rather than of a flag somebody has to remember to check.
        expect(where.notified).toBe(false);
        expect(where.kind).toBe('FROST_RISK');
        // Strictly after today, so a past row is never touched.
        expect((where.signalDate as { gt: Date }).gt.toISOString().slice(0, 10)).toBe('2026-06-15');
        // And the still-warranted day is excluded from the delete.
        const kept = (where.NOT as { signalDate: { in: Date[] } }).signalDate.in.map((d: Date) =>
            d.toISOString().slice(0, 10),
        );
        expect(kept).toEqual(['2026-06-16']);
        expect(result.frost.retracted).toBe(1);
    });
});
