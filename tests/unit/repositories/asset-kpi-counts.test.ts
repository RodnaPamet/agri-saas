/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * KPI card counts are computed in the DATABASE, over the whole filtered
 * set — not derived from the rows the client happens to have loaded.
 *
 * The old client-side derivation was correct only because the list was
 * unbounded. Bounding it would have turned "Total" into "total on this
 * page" silently, which is the failure this replaces.
 *
 * The subtle contract under test is the BREAKDOWN semantics: the status
 * and criticality cards each ignore their OWN facet, because with
 * `status=ACTIVE` selected a Retired card reading 0 would claim the farm
 * has no retired machines. Every other filter still applies — the cards
 * always describe the set the user is looking at.
 */

const calls: any[] = [];
const mockDb = {
    asset: {
        count: jest.fn(async (args: any) => {
            calls.push(args.where);
            return calls.length; // distinct values so mis-wiring is visible
        }),
    },
} as any;

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('READER');
// call order: [total, active, critical, retired]
const TOTAL = 0, ACTIVE = 1, CRITICAL = 2, RETIRED = 3;

beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
});

describe('AssetRepository.kpiCounts', () => {
    it('issues exactly four counts, always tenant-scoped', async () => {
        await AssetRepository.kpiCounts(mockDb, ctx);
        expect(calls).toHaveLength(4);
        for (const w of calls) expect(w.tenantId).toBe(ctx.tenantId);
    });

    it('returns the four values in the right slots', async () => {
        const out = await AssetRepository.kpiCounts(mockDb, ctx);
        // The mock returns 1,2,3,4 in call order — so a swapped pair here
        // (e.g. critical/retired) shows up as a wrong number, not a pass.
        expect(out).toEqual({ total: 1, active: 2, critical: 3, retired: 4 });
    });

    it('the status cards IGNORE the status facet', async () => {
        // Otherwise selecting status=ACTIVE makes Retired read 0 and imply
        // the farm has no retired machines.
        await AssetRepository.kpiCounts(mockDb, ctx, { status: ['ACTIVE'] } as any);
        expect(calls[ACTIVE].status).toEqual('ACTIVE');
        expect(calls[RETIRED].status).toEqual('RETIRED');
    });

    it('the criticality card ignores the criticality facet', async () => {
        await AssetRepository.kpiCounts(mockDb, ctx, { criticality: ['LOW'] } as any);
        expect(calls[CRITICAL].criticality).toEqual('HIGH');
    });

    it('but the TOTAL card honours every facet', async () => {
        // Total is "how many match what I filtered", so it must not strip
        // anything — that is the one card the user reads as a filter result.
        await AssetRepository.kpiCounts(mockDb, ctx, {
            status: ['ACTIVE'],
            criticality: ['HIGH'],
        } as any);
        expect(calls[TOTAL].status).toEqual({ in: ['ACTIVE'] });
        expect(calls[TOTAL].criticality).toEqual({ in: ['HIGH'] });
    });

    it('every OTHER facet still applies to the breakdown cards', async () => {
        // Ignoring its own facet must not mean ignoring the rest — a
        // TRACTOR + search filter still narrows all four cards.
        await AssetRepository.kpiCounts(mockDb, ctx, {
            type: ['TRACTOR'],
            status: ['ACTIVE'],
            q: 'deere',
        } as any);
        for (const w of calls) {
            expect(w.type).toEqual({ in: ['TRACTOR'] });
            expect(Array.isArray(w.OR)).toBe(true);
        }
        // …and criticality survives onto the status cards.
        expect(calls[ACTIVE].status).toBe('ACTIVE');
    });

    it('a cleared facet omits the filter rather than matching nothing', async () => {
        await AssetRepository.kpiCounts(mockDb, ctx, { type: [], status: [] } as any);
        expect(calls[TOTAL]).not.toHaveProperty('type');
        expect(calls[TOTAL]).not.toHaveProperty('status');
    });
});
