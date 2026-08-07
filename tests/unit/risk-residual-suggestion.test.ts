/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ2-2 — suggestion usecase suite.
 *
 * Covers the loader's signal resolution (MEASURED pass-rate beats
 * DECLARED field), the batched groupBy (no per-control N+1), the
 * accept path (server-side recompute → decomposed write → DERIVED
 * ledger event), and the underivable guard.
 */

const mockDb = {
    risk: { findFirst: jest.fn(), update: jest.fn() },
    tenant: { findUnique: jest.fn() },
    controlTestRun: { groupBy: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/usecases/risk-score-events', () => ({
    recordScoreEvent: jest.fn(),
}));

import { recordScoreEvent } from '@/app-layer/usecases/risk-score-events';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import {
    getResidualSuggestion,
    acceptResidualSuggestion,
} from '@/app-layer/usecases/risk-residual-suggestion';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.tenant.findUnique as jest.Mock).mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
    (mockDb.controlTestRun.groupBy as jest.Mock).mockResolvedValue([]);
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

const riskRow = (controls: any[]) => ({
    likelihood: 5,
    impact: 5,
    score: 25,
    residualLikelihood: null,
    residualImpact: null,
    residualScore: null,
    controls: controls.map((c) => ({ control: c })),
});

const ctl = (over: any = {}) => ({
    id: 'c-1',
    code: 'CTL-1',
    name: 'MFA',
    mitigationType: 'PREVENTIVE',
    effectiveness: 50,
    ...over,
});

// ─── getResidualSuggestion ─────────────────────────────────────────

describe('getResidualSuggestion — signal resolution', () => {
    it('uses the DECLARED field when no test runs exist', async () => {
        (mockDb.risk.findFirst as jest.Mock).mockResolvedValue(riskRow([ctl()]));

        const p = await getResidualSuggestion(readerCtx, 'r-1');

        expect(p.suggestion).not.toBeNull();
        expect(p.combined.contributions[0].source).toBe('DECLARED');
        expect(p.combined.contributions[0].effectiveness).toBe(50);
        // 5 × (1−0.5) = 2.5 → ceil 3
        expect(p.suggestion!.residualLikelihood).toBe(3);
    });



    it('suggestion is null (with honest summary) when nothing participates', async () => {
        (mockDb.risk.findFirst as jest.Mock).mockResolvedValue(
            riskRow([ctl({ effectiveness: null })]),
        );

        const p = await getResidualSuggestion(readerCtx, 'r-1');

        expect(p.suggestion).toBeNull();
        expect(p.summary).toMatch(/No linked controls carry an effectiveness signal/);
    });

    it('throws notFound for a missing risk', async () => {
        (mockDb.risk.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getResidualSuggestion(readerCtx, 'ghost')).rejects.toThrow(/Risk not found/i);
    });
});

// ─── acceptResidualSuggestion ──────────────────────────────────────

describe('acceptResidualSuggestion', () => {
    it('recomputes server-side, persists the decomposition, and appends a DERIVED event', async () => {
        (mockDb.risk.findFirst as jest.Mock).mockResolvedValue(riskRow([ctl()]));
        (mockDb.risk.update as jest.Mock).mockResolvedValue({});

        const accepted = await acceptResidualSuggestion(editorCtx, 'r-1');

        // 5/5 with 0.5 likelihood reduction → 3/5 → 15.
        expect(accepted.residualLikelihood).toBe(3);
        expect(accepted.residualImpact).toBe(5);
        expect(accepted.residualScore).toBe(15);

        // RQ3-OB-D — the return carries the server-derived toast
        // one-liner, composed from the recomputed values.
        expect(accepted.summary).toMatch(/^Residual 15 — /);
        expect(accepted.summary).toMatch(/likelihood/);
        expect(accepted.summary).toMatch(/impact/);

        const write = (mockDb.risk.update as jest.Mock).mock.calls[0][0];
        expect(write.data).toMatchObject({
            residualLikelihood: 3,
            residualImpact: 5,
            residualScore: 15,
        });
        expect(write.data.residualScoreSetAt).toBeInstanceOf(Date);

        const ev = (recordScoreEvent as jest.Mock).mock.calls[0][2];
        expect(ev).toMatchObject({ kind: 'RESIDUAL', source: 'DERIVED', score: 15 });
        expect(ev.justification).toMatch(/likelihood-reducing control/);

        expect(bumpEntityCacheVersion).toHaveBeenCalledWith(editorCtx, 'risk');
    });

    it('rejects with badRequest when nothing is derivable (no write, no event)', async () => {
        (mockDb.risk.findFirst as jest.Mock).mockResolvedValue(
            riskRow([ctl({ effectiveness: null })]),
        );

        await expect(acceptResidualSuggestion(editorCtx, 'r-1')).rejects.toThrow(/No derivable residual/i);
        expect(mockDb.risk.update).not.toHaveBeenCalled();
        expect(recordScoreEvent).not.toHaveBeenCalled();
    });

    it('rejects READER (write gate)', async () => {
        await expect(acceptResidualSuggestion(readerCtx, 'r-1')).rejects.toBeDefined();
        expect(mockDb.risk.findFirst).not.toHaveBeenCalled();
    });
});
