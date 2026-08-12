/**
 * Achievements — the streak math (pure) + milestone derivation from rows.
 * The tenant-context DB is mocked so we assert the mapping, not Prisma.
 */
import type { RequestContext } from '@/app-layer/types';

const db = {
    location: { findFirst: jest.fn() },
    task: { findFirst: jest.fn() },
    logEntry: { findFirst: jest.fn(), findMany: jest.fn() },
    season: { findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (d: unknown) => unknown) => cb(db),
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

import { getAchievements, computeStreak } from '@/app-layer/usecases/achievements';

const ctx = { tenantId: 't1', userId: 'u', requestId: 'r' } as unknown as RequestContext;
const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

describe('computeStreak', () => {
    it('empty → 0/0', () => {
        expect(computeStreak([])).toEqual({ current: 0, best: 0 });
    });
    it('three consecutive days ending today → 3/3', () => {
        expect(computeStreak([day('2026-06-17'), day('2026-06-18'), day('2026-06-19')], day('2026-06-19')))
            .toEqual({ current: 3, best: 3 });
    });
    it('grace — last entry was yesterday → current still 1', () => {
        expect(computeStreak([day('2026-06-18')], day('2026-06-19'))).toEqual({ current: 1, best: 1 });
    });
    it('stale — last entry 4 days ago → current 0, best from the longest run', () => {
        const r = computeStreak([day('2026-06-10'), day('2026-06-11'), day('2026-06-15')], day('2026-06-19'));
        expect(r.current).toBe(0);
        expect(r.best).toBe(2);
    });
    it('dedupes multiple entries on the same day', () => {
        const r = computeStreak([day('2026-06-19'), day('2026-06-19'), day('2026-06-18')], day('2026-06-19'));
        expect(r).toEqual({ current: 2, best: 2 });
    });
});

describe('getAchievements', () => {
    beforeEach(() => {
        for (const model of Object.values(db)) {
            for (const fn of Object.values(model)) (fn as jest.Mock).mockReset();
        }
    });

    it('derives earned milestones from the rows that exist', async () => {
        db.location.findFirst.mockResolvedValue({ createdAt: new Date('2026-01-01') }); // first field
        db.task.findFirst.mockResolvedValue(null); // no completed spray job
        db.logEntry.findFirst.mockResolvedValue({ occurredAt: new Date('2026-02-01') }); // first harvest
        db.season.findFirst.mockResolvedValue(null);
        db.logEntry.findMany.mockResolvedValue([{ occurredAt: new Date() }]);

        const res = await getAchievements(ctx);
        const earned = new Set(res.milestones.filter((m) => m.earned).map((m) => m.key));
        expect(earned.has('first-field-mapped')).toBe(true);
        expect(earned.has('first-harvest')).toBe(true);
        expect(earned.has('spray-job-complete')).toBe(false);
        expect(earned.has('season-closed')).toBe(false);
        // Only the four agri milestones exist since GRC teardown phase 2.
        expect(res.milestones).toHaveLength(4);
        // earnedAt carried through for the rows that have a timestamp.
        const field = res.milestones.find((m) => m.key === 'first-field-mapped');
        expect(field?.earnedAt).toBe(new Date('2026-01-01').toISOString());
    });

    it('reports every milestone unearned when no qualifying row exists', async () => {
        // Replaces the old SOP-acknowledgement case, whose data source
        // (Policy + PolicyAcknowledgement) went with GRC teardown phase 2.
        // The all-locked path is still worth pinning: a new tenant's
        // dashboard must render four locked milestones, not an empty list.
        db.location.findFirst.mockResolvedValue(null);
        db.task.findFirst.mockResolvedValue(null);
        db.logEntry.findFirst.mockResolvedValue(null);
        db.season.findFirst.mockResolvedValue(null);
        db.logEntry.findMany.mockResolvedValue([]);

        const res = await getAchievements(ctx);
        expect(res.milestones).toHaveLength(4);
        expect(res.milestones.every((m) => !m.earned)).toBe(true);
        expect(res.streak).toEqual({ current: 0, best: 0 });
    });
});
