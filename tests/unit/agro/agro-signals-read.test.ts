/**
 * `GET /api/t/{slug}/agro/signals` and its usecase — #3077.
 *
 * Two concerns in one file because they are two halves of one contract: the
 * route decides what it will ANSWER FOR, and the usecase decides what the
 * answer MEANS. The fields worth protecting are `horizon` and `truncated`,
 * and both fail toward a client rendering a confident "no warning" over
 * something it does not know.
 */
const mockDb: Record<string, unknown> = {
    agroSignal: { findMany: jest.fn() },
    weatherObservation: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/t/[tenantSlug]/agro/signals/route';
import { AGRO_SIGNALS_MAX_ROWS, listAgroSignals } from '@/app-layer/usecases/agro-signals-read';
import { MAX_SIGNAL_DAYS } from '@/lib/agro/signal-window';
import { DEFAULT_FROST_THRESHOLDS } from '@/lib/agro/rules';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant-1', tenantSlug: 'acme' });

function call(qs: string) {
    return GET(new NextRequest(`https://app.agrent.bg/api/t/acme/agro/signals${qs}`), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
}

const signalRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        locationId: `loc-${i}`,
        kind: 'FROST_RISK' as const,
        level: 'FROST',
        signalDate: new Date(Date.UTC(2026, 3, 12)),
    }));

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(ctx);
    (mockDb.agroSignal as { findMany: jest.Mock }).findMany.mockResolvedValue(signalRows(2));
    (mockDb.weatherObservation as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
        obsDate: new Date(Date.UTC(2026, 3, 14)),
    });
});

describe('the route decides what it will answer for', () => {
    it('refuses a missing from or to', async () => {
        for (const qs of ['', '?from=2026-04-01', '?to=2026-04-30']) {
            const res = await call(qs);
            expect(res.status).toBe(400);
        }
    });

    it('refuses a date that does not exist, rather than sliding it', async () => {
        // `new Date('2026-02-30')` is 2 March, silently. The shared
        // `parseDateRangeParam` round-trips for exactly this reason, which is
        // why the route borrows it instead of parsing dates itself.
        const res = await call('?from=2026-02-30&to=2026-03-02');
        expect(res.status).toBe(400);
    });

    it(`refuses a span wider than ${MAX_SIGNAL_DAYS} days`, async () => {
        const wide = await call('?from=2026-01-01&to=2026-12-31');
        expect(wide.status).toBe(400);
        // The boundary itself is allowed, so the cap is where it says it is.
        const from = new Date(Date.UTC(2026, 3, 1));
        const to = new Date(from.getTime() + (MAX_SIGNAL_DAYS - 1) * 86_400_000);
        const ok = await call(
            `?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`,
        );
        expect(ok.status).toBe(200);
    });

    it('answers 200 with the view, and an ETag', async () => {
        const res = await call('?from=2026-04-01&to=2026-04-30');
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toBeTruthy();
        const body = await res.json();
        expect(body.signals).toHaveLength(2);
        expect(body.horizon).toBe('2026-04-14');
        expect(body.frostThresholdC).toBe(DEFAULT_FROST_THRESHOLDS.tempMinC);
        expect(body.truncated).toBe(false);
    });
});

describe('the usecase decides what the answer MEANS', () => {
    const range = { from: new Date(Date.UTC(2026, 3, 1)), to: new Date(Date.UTC(2026, 3, 30)) };

    it('reports the horizon from the newest observation, not from a constant', async () => {
        (mockDb.weatherObservation as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
            obsDate: new Date(Date.UTC(2026, 3, 13)),
        });
        const view = await listAgroSignals(ctx, range);
        expect(view.horizon).toBe('2026-04-13');

        // A farm with no weather at all has NO horizon — which a client must
        // read as "nothing known", never as "nothing found".
        (mockDb.weatherObservation as { findFirst: jest.Mock }).findFirst.mockResolvedValue(null);
        expect((await listAgroSignals(ctx, range)).horizon).toBeNull();
    });

    it('asks for the newest observation WITHOUT the range filter', async () => {
        // The horizon is a fact about the farm, not about the window asked
        // for: a client reading last month still needs to know how far
        // forward anything is known. Filtering it by `range` would report the
        // end of the requested window and make the field a tautology.
        await listAgroSignals(ctx, range);
        const where = (mockDb.weatherObservation as { findFirst: jest.Mock }).findFirst.mock.calls[0][0]
            .where as Record<string, unknown>;
        expect(where).toEqual({ tenantId: 'tenant-1' });
        expect(where).not.toHaveProperty('obsDate');
    });

    it('reports truncation rather than silently dropping a block’s warning', async () => {
        // It asks for cap+1 so it can TELL, and trims to the cap. A block
        // whose warning fell off the end with `truncated: false` would be the
        // exact failure this endpoint exists to prevent.
        (mockDb.agroSignal as { findMany: jest.Mock }).findMany.mockResolvedValue(
            signalRows(AGRO_SIGNALS_MAX_ROWS + 1),
        );
        const view = await listAgroSignals(ctx, range);
        expect(view.truncated).toBe(true);
        expect(view.signals).toHaveLength(AGRO_SIGNALS_MAX_ROWS);

        const take = (mockDb.agroSignal as { findMany: jest.Mock }).findMany.mock.calls[0][0].take;
        expect(take).toBe(AGRO_SIGNALS_MAX_ROWS + 1);
    });

    it('scopes to the tenant and formats dates as day keys', async () => {
        const view = await listAgroSignals(ctx, range);
        const where = (mockDb.agroSignal as { findMany: jest.Mock }).findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
        expect(view.signals[0].signalDate).toBe('2026-04-12');
        expect(view.signals[0].locationId).toBe('loc-0');
    });
});
