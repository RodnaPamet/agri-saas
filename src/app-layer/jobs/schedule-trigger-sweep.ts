/**
 * Scheduled-trigger sweep (PR-E).
 *
 * The single Archer-parity time/schedule trigger. A rule with
 * `triggerEvent = 'SCHEDULE'` carries a `scheduleConfigJson`
 * `{ kind: 'DATE_RELATIVE', target, offsetDays }`. This daily sweep finds
 * every target entity whose due date is exactly `offsetDays` away and enqueues
 * a targeted `automation-event-dispatch` so the rule's action fires per entity
 * (`triggeredBy: 'schedule'`). A deterministic `stableKey` makes a re-run
 * idempotent — one execution per (rule, entity, due-day).
 *
 * Targets are ALLOWLISTED (entity → model + date field) so a rule config can
 * never schedule a scan of an arbitrary table/column.
 */
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';
import type { JobRunResult } from './types';
import { enqueue } from './queue';

// ControlException / ControlTestPlan were dropped with the compliance
// uproot; Evidence retention is the remaining date-relative trigger.
export type ScheduleTarget = 'Evidence';

export const SCHEDULE_TARGETS: Record<ScheduleTarget, { dateField: string }> = {
    Evidence: { dateField: 'retentionUntil' },
};

export interface ScheduleConfig {
    kind: 'DATE_RELATIVE';
    target: ScheduleTarget;
    offsetDays: number;
}

/** Validate + narrow a raw scheduleConfigJson. Returns null if unusable. */
export function parseScheduleConfig(raw: unknown): ScheduleConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (c.kind !== 'DATE_RELATIVE') return null;
    if (typeof c.target !== 'string' || !(c.target in SCHEDULE_TARGETS)) return null;
    if (typeof c.offsetDays !== 'number' || c.offsetDays < 0 || c.offsetDays > 365) return null;
    return { kind: 'DATE_RELATIVE', target: c.target as ScheduleTarget, offsetDays: c.offsetDays };
}

const DAY_MS = 86_400_000;

/** Pure — the UTC day window that is `offsetDays` from `now`. A target whose
 * date falls in [gte, lt) is due to fire today. */
export function dueWindow(now: Date, offsetDays: number): { gte: Date; lt: Date } {
    const t = now.getTime() + offsetDays * DAY_MS;
    const start = new Date(t);
    start.setUTCHours(0, 0, 0, 0);
    return { gte: start, lt: new Date(start.getTime() + DAY_MS) };
}

/** Query an allowlisted target's due entities (tenant-scoped, bounded). */
async function dueEntities(
    target: ScheduleTarget,
    tenantId: string,
    win: { gte: Date; lt: Date },
): Promise<Array<{ id: string; due: Date | null }>> {
    const field = SCHEDULE_TARGETS[target].dateField;
    const where = { tenantId, [field]: { gte: win.gte, lt: win.lt } };
    const select = { id: true, [field]: true };
    let rows: Array<Record<string, unknown>>;
    switch (target) {
        case 'Evidence':
            rows = await prisma.evidence.findMany({ where, select, take: 500 });
            break;
    }
    return rows.map((r) => ({ id: r.id as string, due: (r[field] as Date | null) ?? null }));
}

export async function runScheduleTriggerSweep(
    now: Date,
): Promise<{ result: JobRunResult; firedCount: number }> {
    return runJob('schedule-trigger-sweep', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();

        const rules = await prisma.automationRule.findMany({
            where: { triggerEvent: 'SCHEDULE', status: 'ENABLED', deletedAt: null },
            select: { id: true, tenantId: true, scheduleConfigJson: true },
            take: 2000,
        });

        let firedCount = 0;
        for (const rule of rules) {
            const cfg = parseScheduleConfig(rule.scheduleConfigJson);
            if (!cfg) continue;
            const win = dueWindow(now, cfg.offsetDays);
            const entities = await dueEntities(cfg.target, rule.tenantId, win);
            const dueDayKey = win.gte.toISOString().slice(0, 10);
            for (const entity of entities) {
                await enqueue('automation-event-dispatch', {
                    tenantId: rule.tenantId,
                    event: {
                        event: 'SCHEDULE',
                        tenantId: rule.tenantId,
                        entityType: cfg.target,
                        entityId: entity.id,
                        actorUserId: null,
                        emittedAt: now.toISOString(),
                        stableKey: `sched-${rule.id}-${entity.id}-${dueDayKey}`,
                        data: {
                            target: cfg.target,
                            dueAt: entity.due ? entity.due.toISOString() : null,
                            offsetDays: cfg.offsetDays,
                        },
                    },
                    targetRuleId: rule.id,
                    triggeredBy: 'schedule',
                });
                firedCount++;
            }
        }

        const result: JobRunResult = {
            jobName: 'schedule-trigger-sweep',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: rules.length,
            itemsActioned: firedCount,
            itemsSkipped: 0,
            details: { rules: rules.length, fired: firedCount },
        };
        return { result, firedCount };
    });
}
