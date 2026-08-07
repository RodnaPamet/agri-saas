/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ2-8 — getRiskStaleness loader suite: batched signal queries (no
 * per-risk loops), correct map joins, rot-first ordering.
 */

const mockDb = {
    risk: { findMany: jest.fn() },
    riskScoreEvent: { groupBy: jest.fn() },
    riskControl: { findMany: jest.fn() },
    controlTestRun: { groupBy: jest.fn() },
    // RQ3-7 — KRI breach signal source.
    keyRiskIndicator: { findMany: jest.fn() },
    kriReading: { groupBy: jest.fn(), findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

import { getRiskStaleness } from '@/app-layer/usecases/risk-staleness';
import { makeRequestContext } from '../helpers/make-context';

const readerCtx = makeRequestContext('READER');
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.risk.findMany as jest.Mock).mockResolvedValue([]);
    (mockDb.riskScoreEvent.groupBy as jest.Mock).mockResolvedValue([]);
    (mockDb.riskControl.findMany as jest.Mock).mockResolvedValue([]);
    (mockDb.controlTestRun.groupBy as jest.Mock).mockResolvedValue([]);
    (mockDb.keyRiskIndicator.findMany as jest.Mock).mockResolvedValue([]);
    (mockDb.kriReading.groupBy as jest.Mock).mockResolvedValue([]);
    (mockDb.kriReading.findMany as jest.Mock).mockResolvedValue([]);
});

describe('getRiskStaleness', () => {
    it('an empty register short-circuits with zero queries beyond the scan', async () => {
        const report = await getRiskStaleness(readerCtx);
        expect(report).toMatchObject({ staleRisks: [], staleCount: 0, totalCount: 0 });
        expect(mockDb.riskScoreEvent.groupBy).not.toHaveBeenCalled();
    });

    // The CONTROLS_MOVED_SINCE signal was derived from ControlTestRun
    // executions. Test runs went with the compliance uproot, so staleness now
    // joins TWO sources — review-overdue and score-event age — and a risk
    // whose only claim to staleness was a re-tested control is no longer
    // flagged. The fixture keeps that risk so the change is visible.
    it('joins the two remaining signal sources and flags only the rotten rows', async () => {
        (mockDb.risk.findMany as jest.Mock).mockResolvedValue([
            { id: 'fresh', title: 'Fresh', nextReviewAt: daysAgo(-30), residualScoreSetAt: daysAgo(2) },
            { id: 'overdue', title: 'Overdue', nextReviewAt: daysAgo(10), residualScoreSetAt: null },
            { id: 'moved', title: 'Moved', nextReviewAt: null, residualScoreSetAt: daysAgo(90) },
        ]);
        (mockDb.riskScoreEvent.groupBy as jest.Mock).mockResolvedValue([
            { riskId: 'fresh', _max: { createdAt: daysAgo(2) } },
            { riskId: 'overdue', _max: { createdAt: daysAgo(20) } },
            { riskId: 'moved', _max: { createdAt: daysAgo(90) } },
        ]);
        (mockDb.riskControl.findMany as jest.Mock).mockResolvedValue([
            { riskId: 'moved', controlId: 'c-1' },
        ]);

        const report = await getRiskStaleness(readerCtx);

        expect(report.totalCount).toBe(3);
        expect(report.staleCount).toBe(1);
        const ids = report.staleRisks.map((r) => r.riskId);
        expect(ids).toContain('overdue');
        expect(ids).not.toContain('fresh');
        // 'moved' was stale ONLY via CONTROLS_MOVED_SINCE, which no longer
        // has a source. It stays in the fixture so this stops being true the
        // moment an equivalent signal is reintroduced.
        expect(ids).not.toContain('moved');
    });


    it('a RED-latest KRI reading newer than the last assessment flags SIGNAL_MOVED (RQ3-7)', async () => {
        (mockDb.risk.findMany as jest.Mock).mockResolvedValue([
            { id: 'sig', title: 'Sig', nextReviewAt: daysAgo(-30), residualScoreSetAt: daysAgo(2) },
        ]);
        (mockDb.riskScoreEvent.groupBy as jest.Mock).mockResolvedValue([
            { riskId: 'sig', _max: { createdAt: daysAgo(30) } },
        ]);
        (mockDb.keyRiskIndicator.findMany as jest.Mock).mockResolvedValue([
            { id: 'k-1', riskId: 'sig' },
        ]);
        (mockDb.kriReading.groupBy as jest.Mock).mockResolvedValue([
            { kriId: 'k-1', _max: { recordedAt: daysAgo(2) } },
        ]);
        (mockDb.kriReading.findMany as jest.Mock).mockResolvedValue([
            { kriId: 'k-1', ragStatus: 'RED', recordedAt: daysAgo(2) },
        ]);

        const report = await getRiskStaleness(readerCtx);
        const sig = report.staleRisks.find((r) => r.riskId === 'sig')!;
        expect(sig).toBeDefined();
        expect(sig.reasons).toContain('SIGNAL_MOVED');
        expect(sig.description).toMatch(/key risk indicator breached/);
    });

    it('a recovered KRI (latest reading not RED) raises no SIGNAL_MOVED — un-breach is silent', async () => {
        (mockDb.risk.findMany as jest.Mock).mockResolvedValue([
            { id: 'ok', title: 'OK', nextReviewAt: daysAgo(-30), residualScoreSetAt: daysAgo(2) },
        ]);
        (mockDb.riskScoreEvent.groupBy as jest.Mock).mockResolvedValue([
            { riskId: 'ok', _max: { createdAt: daysAgo(30) } },
        ]);
        (mockDb.keyRiskIndicator.findMany as jest.Mock).mockResolvedValue([
            { id: 'k-2', riskId: 'ok' },
        ]);
        (mockDb.kriReading.groupBy as jest.Mock).mockResolvedValue([
            { kriId: 'k-2', _max: { recordedAt: daysAgo(1) } },
        ]);
        // Latest reading recovered to GREEN — no live signal.
        (mockDb.kriReading.findMany as jest.Mock).mockResolvedValue([
            { kriId: 'k-2', ragStatus: 'GREEN', recordedAt: daysAgo(1) },
        ]);

        const report = await getRiskStaleness(readerCtx);
        expect(report.staleCount).toBe(0);
    });

    it('orders rot-first: more reasons, then older assessments', async () => {
        (mockDb.risk.findMany as jest.Mock).mockResolvedValue([
            { id: 'a', title: 'A', nextReviewAt: daysAgo(1), residualScoreSetAt: null },
            { id: 'b', title: 'B', nextReviewAt: daysAgo(1), residualScoreSetAt: null },
        ]);
        (mockDb.riskScoreEvent.groupBy as jest.Mock).mockResolvedValue([
            { riskId: 'a', _max: { createdAt: daysAgo(200) } },
            { riskId: 'b', _max: { createdAt: daysAgo(400) } },
        ]);
        const report = await getRiskStaleness(readerCtx);
        expect(report.staleRisks.map((r) => r.riskId)).toEqual(['b', 'a']);
    });
});
