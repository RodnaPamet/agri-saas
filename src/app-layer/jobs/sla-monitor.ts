/**
 * SLA monitor job (Automation Epic 5).
 *
 * Scans RUNNING automation executions whose parent rule declares an
 * `slaWindowMinutes` and whose start is older than that window. Each
 * breached execution is completed as FAILED with an `slaBreached` outcome,
 * an audit event is written, and — when the rule configures a NOTIFY_USER
 * breach action — notifications are created for the configured recipients.
 *
 * Detection + marking is the load-bearing capability; richer breach actions
 * (reassign, status change) record their intent in the outcome and are a
 * follow-up. Runs every 5 minutes (see schedules.ts).
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { withTenantDb } from '@/lib/db-context';
import { getPermissionsForRole } from '@/lib/permissions';
import { AutomationExecutionRepository } from '../automation';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';
import type { JobRunResult } from './types';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

function makeSystemCtx(tenantId: string): RequestContext {
    return {
        requestId: `sla-monitor-${tenantId}-${Date.now()}`,
        userId: 'system',
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

export async function runSlaMonitorJob(options?: {
    tenantId?: string;
    now?: Date;
}): Promise<{ result: JobRunResult; breachedCount: number }> {
    return runJob('sla-monitor', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const now = options?.now ?? new Date();

        const tenants = options?.tenantId
            ? [{ id: options.tenantId }]
            : await prisma.tenant.findMany({ select: { id: true } });

        let breached = 0;
        let errored = 0;

        for (const tenant of tenants) {
            try {
                breached += await sweepTenant(tenant.id, now);
            } catch (err) {
                errored++;
                logger.error('SLA monitor failed for tenant', {
                    component: 'sla-monitor',
                    tenantId: tenant.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'sla-monitor',
            jobRunId: crypto.randomUUID(),
            success: errored === 0,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: tenants.length,
            itemsActioned: breached,
            itemsSkipped: errored,
            details: { breached, errored },
        };
        return { result, breachedCount: breached };
    });
}

/** Returns the number of breached executions actioned for one tenant. */
export async function sweepTenant(tenantId: string, now: Date): Promise<number> {
    const ctx = makeSystemCtx(tenantId);
    return withTenantDb(tenantId, async (db) => {
        // RUNNING executions whose rule has an SLA window set.
        const running = await db.automationExecution.findMany({
            where: { tenantId, status: 'RUNNING', rule: { slaWindowMinutes: { not: null } } },
            include: { rule: true },
            take: 500,
        });

        // The tenant's member languages, read ONCE per sweep and memoised.
        //
        // LAZILY, not eagerly: a breach needs a RUNNING execution already past
        // its window, so the queue is empty on almost every run — an
        // unconditional read would be a query per tenant every two minutes for
        // nothing.
        //
        // And once per SWEEP rather than once per breached execution, which is
        // the N+1 Layer D1 caught in the first draft of this change. Several
        // rules breaching in the same window is the normal shape here, not an
        // edge case: they share a tenant and usually a cause.
        //
        // Scoped to the tenant rather than to the configured ids, because the
        // ids differ per rule and the union would have to be collected in a
        // first pass over the same loop. A farm's ACTIVE membership is a
        // handful of rows, so the whole set is cheaper than the bookkeeping.
        let localeCache: Map<string, Locale> | null = null;
        const memberLocales = async (): Promise<Map<string, Locale>> => {
            if (localeCache) return localeCache;
            const members = await db.tenantMembership.findMany({
                where: { tenantId, status: 'ACTIVE' },
                select: { userId: true, user: { select: { uiLanguage: true } } },
                take: 500,
            });
            localeCache = new Map(
                members.map((m) => [m.userId, resolveRecipientLocale(m.user?.uiLanguage)]),
            );
            return localeCache;
        };

        let count = 0;
        for (const exec of running) {
            const windowMin = exec.rule.slaWindowMinutes;
            if (!windowMin) continue;
            const startedAtMs = (exec.startedAt ?? exec.createdAt).getTime();
            const deadline = startedAtMs + windowMin * 60_000;
            if (now.getTime() < deadline) continue; // not breached yet

            await AutomationExecutionRepository.recordCompletion(db, ctx, exec.id, {
                status: 'FAILED',
                outcome: {
                    slaBreached: true,
                    breachedAt: now.toISOString(),
                    slaWindowMinutes: windowMin,
                    breachAction: exec.rule.slaBreachActionType ?? null,
                },
                errorMessage: `SLA window of ${windowMin}m breached`,
            });

            await logEvent(db, ctx, {
                action: 'AUTOMATION_SLA_BREACHED',
                entityType: 'AutomationExecution',
                entityId: exec.id,
                detailsJson: {
                    ruleId: exec.ruleId,
                    slaWindowMinutes: windowMin,
                    breachAction: exec.rule.slaBreachActionType ?? null,
                },
            });

            // NOTIFY_USER breach action — create notifications for recipients.
            if (exec.rule.slaBreachActionType === 'NOTIFY_USER' && exec.rule.slaBreachConfigJson) {
                const cfg = exec.rule.slaBreachConfigJson as { userIds?: string[]; message?: string };
                const userIds = Array.isArray(cfg.userIds) ? cfg.userIds : [];
                if (userIds.length > 0) {
                    // Read through the membership rather than `User` directly:
                    // this runs in a tenant context and `User` carries no
                    // `tenantId`, so RLS returns nothing from here. The
                    // configured ids are tenant members by construction — the
                    // rule builder picks them from this list.
                    const localeByUser = await memberLocales();

                    // `cfg.message` stays a PASSTHROUGH when set: it is the
                    // operator's own wording, typed into the rule builder, and
                    // translating a tenant's own copy would be rewriting it.
                    // Only the fallback is ours to localise (#2511).
                    const rows = [];
                    for (const userId of userIds) {
                        const locale =
                            localeByUser.get(userId) ?? resolveRecipientLocale(undefined);
                        rows.push({
                            tenantId,
                            userId,
                            type: 'GENERAL' as const,
                            title: await translateFor(locale, 'notifications.slaBreach.title'),
                            message:
                                cfg.message ??
                                (await translateFor(locale, 'notifications.slaBreach.body', {
                                    minutes: String(windowMin),
                                })),
                        });
                    }
                    await db.notification.createMany({ data: rows });
                }
            }
            count++;
        }
        return count;
    });
}
