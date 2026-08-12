/**
 * Achievements — the four meaningful farm milestones + a journaling streak,
 * all DERIVED from existing rows (no new schema). Read-only; safe to call on
 * the dashboard load. Each milestone reports `earned` + the timestamp it was
 * earned (so the UI can show "earned 3 days ago" and the client can fire a
 * one-time celebration). Routine saves never appear here — only the moments
 * that matter.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
// The derived-state types + the display order live in celebrations.ts
// (client-safe) so the dashboard CARD can import them without dragging this
// prisma-backed usecase into the browser bundle. Re-exported for server
// callers (ag-dashboard) + tests that import them from here.
import { AG_MILESTONE_ORDER, type AchievementItem, type AchievementsResult, type JournalStreak } from '@/lib/celebrations';
export { AG_MILESTONE_ORDER, type AchievementItem, type AchievementsResult, type JournalStreak };

const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}
function isConsecutive(earlier: string, later: string): boolean {
    return new Date(`${later}T00:00:00Z`).getTime() - new Date(`${earlier}T00:00:00Z`).getTime() === DAY_MS;
}

/**
 * Pure streak math (exported for tests). `current` is the run ending today
 * OR yesterday (a one-day grace so the streak isn't "broken" before the day
 * is even over); 0 if the most recent entry is older than that. `best` is the
 * longest run across the supplied dates.
 */
export function computeStreak(occurredAt: Date[], now: Date = new Date()): JournalStreak {
    if (occurredAt.length === 0) return { current: 0, best: 0 };
    const days = Array.from(new Set(occurredAt.map(dayKey))).sort();

    let best = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
        run = isConsecutive(days[i - 1], days[i]) ? run + 1 : 1;
        if (run > best) best = run;
    }

    const today = dayKey(now);
    const yesterday = dayKey(new Date(now.getTime() - DAY_MS));
    const last = days[days.length - 1];
    let current = 0;
    if (last === today || last === yesterday) {
        current = 1;
        for (let i = days.length - 1; i > 0; i--) {
            if (isConsecutive(days[i - 1], days[i])) current++;
            else break;
        }
    }
    return { current, best };
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export async function getAchievements(ctx: RequestContext): Promise<AchievementsResult> {
    const t = ctx.tenantId;
    return runInTenantContext(ctx, async (db) => {
        // GRC teardown phase 2 (plan §1c) dropped the two milestones that
        // reached GRC models through Prisma delegates while importing no GRC
        // module — `inspection-passed` (db.auditPack) and `sop-100-ack`
        // (db.policy + db.policyAcknowledgement). No import-graph scan could
        // see them; they were found by reading the delegates. The
        // tenantMembership count went with `sop-100-ack`, its only consumer.
        const [firstField, sprayDone, firstHarvest, seasonClosed, streakRows] =
            await Promise.all([
                db.location.findFirst({ where: { tenantId: t, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
                db.task.findFirst({ where: { tenantId: t, type: 'FIELD_OPERATION', status: 'RESOLVED', deletedAt: null }, orderBy: { completedAt: 'asc' }, select: { completedAt: true } }),
                db.logEntry.findFirst({ where: { tenantId: t, type: 'HARVEST', status: 'DONE', deletedAt: null }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
                db.season.findFirst({ where: { tenantId: t, status: 'CLOSED', deletedAt: null }, orderBy: { endDate: 'asc' }, select: { endDate: true } }),
                db.logEntry.findMany({ where: { tenantId: t, status: 'DONE', deletedAt: null }, select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 400 }),
            ]);

        const milestones: AchievementItem[] = [
            { key: 'first-field-mapped', earned: !!firstField, earnedAt: iso(firstField?.createdAt) },
            { key: 'spray-job-complete', earned: !!sprayDone, earnedAt: iso(sprayDone?.completedAt) },
            { key: 'first-harvest', earned: !!firstHarvest, earnedAt: iso(firstHarvest?.occurredAt) },
            { key: 'season-closed', earned: !!seasonClosed, earnedAt: iso(seasonClosed?.endDate) },
        ];

        return { milestones, streak: computeStreak(streakRows.map((r) => r.occurredAt)) };
    });
}
