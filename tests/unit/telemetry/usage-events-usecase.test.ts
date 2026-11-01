/**
 * What the ingest usecase DROPS, CLAMPS and IGNORES.
 *
 * Every rule here is one the iOS and web clients depend on being true, and
 * none is visible from the schema: the schema admits any string as a `name`
 * precisely so an unknown one can be dropped rather than 400'd.
 */
import { recordUsageEvents } from '@/app-layer/usecases/usage-events';
import { MAX_CLIENT_CLOCK_SKEW_MS } from '@/app-layer/telemetry/usage-events';
import { makeRequestContext } from '../../helpers/make-context';

const createMany = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn((_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({ usageEvent: { createMany } }),
    ),
}));
jest.mock('@/lib/feature-flags', () => ({ assertFeatureEnabled: jest.fn() }));

const ctx = () => makeRequestContext('EDITOR', { tenantId: 't-1', userId: 'u-1' });
const rowsWritten = () => (createMany.mock.calls[0]?.[0]?.data ?? []) as Record<string, unknown>[];

beforeEach(() => {
    createMany.mockReset();
    createMany.mockResolvedValue({ count: 0 });
});

describe('recordUsageEvents', () => {
    it('DROPS an unknown name and keeps the rest of the batch', async () => {
        const out = await recordUsageEvents(ctx(), {
            events: [
                { name: 'cost_saved', at: '2026-11-01T09:00:00.000Z' },
                { name: 'treatment_saved_wheat', at: '2026-11-01T09:00:00.000Z' },
                { name: 'definitely_not_a_name', at: '2026-11-01T09:00:00.000Z' },
            ],
        });
        // The batch is NOT refused — that is the whole contract.
        expect(out).toEqual({ accepted: 1, dropped: 2 });
        expect(rowsWritten().map((r) => r.name)).toEqual(['cost_saved']);
    });

    it('DROPS a screen_opened whose surface it cannot name', async () => {
        const out = await recordUsageEvents(ctx(), {
            events: [
                { name: 'screen_opened', surface: '/journal', at: '2026-11-01T09:00:00.000Z' },
                { name: 'screen_opened', surface: '/locations/abc123', at: '2026-11-01T09:00:00.000Z' },
                { name: 'screen_opened', at: '2026-11-01T09:00:00.000Z' },
            ],
        });
        // A parameterised surface carries a farm record id; an absent one
        // measures nothing. Storing either would inflate the total while
        // leaving the per-screen breakdown short — two numbers that disagree.
        expect(out).toEqual({ accepted: 1, dropped: 2 });
        expect(rowsWritten()[0].surface).toBe('/journal');
    });

    it('DISCARDS a surface sent on an action', async () => {
        await recordUsageEvents(ctx(), {
            events: [{ name: 'cost_saved', surface: '/journal', at: '2026-11-01T09:00:00.000Z' }],
        });
        // Not refused, not stored — `surface` belongs to screen_opened alone,
        // or the column becomes a second unvalidated dimension on 25 names.
        expect(rowsWritten()[0].surface).toBeNull();
    });

    it('CLAMPS a client clock that is impossible, and keeps one that is not', async () => {
        const now = Date.now();
        const future = new Date(now + 60 * 60 * 1000).toISOString();
        const ancient = new Date(now - MAX_CLIENT_CLOCK_SKEW_MS - 60_000).toISOString();
        const fine = new Date(now - 60_000).toISOString();

        await recordUsageEvents(ctx(), {
            events: [
                { name: 'cost_saved', at: future },
                { name: 'task_closed', at: ancient },
                { name: 'task_created', at: fine },
            ],
        });
        const rows = rowsWritten();
        // Clamped to ~now, not dropped: discarding would bias the data toward
        // people whose clocks happen to be right.
        expect(rows).toHaveLength(3);
        expect((rows[0].at as Date).getTime()).toBeLessThanOrEqual(Date.now());
        expect((rows[1].at as Date).getTime()).toBeGreaterThan(now - MAX_CLIENT_CLOCK_SKEW_MS);
        expect((rows[2].at as Date).toISOString()).toBe(fine);
    });

    it('takes tenantId and userId from the SESSION, never the body', async () => {
        await recordUsageEvents(ctx(), {
            // A client sending these has them stripped by the schema; this
            // asserts the usecase would ignore them even if they survived.
            events: [{ name: 'cost_saved', at: '2026-11-01T09:00:00.000Z' }],
        } as never);
        expect(rowsWritten()[0]).toMatchObject({ tenantId: 't-1', userId: 'u-1' });
    });

    it('writes NOTHING when every event in the batch is unknown', async () => {
        const out = await recordUsageEvents(ctx(), {
            events: [{ name: 'nope', at: '2026-11-01T09:00:00.000Z' }],
        });
        expect(out).toEqual({ accepted: 0, dropped: 1 });
        // No empty createMany — an all-dropped batch is still a 204.
        expect(createMany).not.toHaveBeenCalled();
    });
});
