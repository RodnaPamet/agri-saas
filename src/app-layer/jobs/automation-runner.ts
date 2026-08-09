/**
 * Scheduled Automation Runner
 *
 * Cron-based job that finds Practices with automationKey configured,
 * determines which are due for execution, and dispatches checks.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DUE-SELECTION RULES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A practice is due for an automated check when ALL of:
 *   1. automationKey is set (non-null)
 *   2. evidenceSource = 'INTEGRATION' (explicitly opted in)
 *   3. Practice is not soft-deleted (deletedAt is null)
 *   4. Practice is APPLICABLE
 *   5. nextDueAt <= now (schedule window reached)
 *   6. No successful execution exists within the current frequency window
 *      (idempotency / duplicate-run protection)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FREQUENCY → INTERVAL MAPPING
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   AD_HOC     → manual only (skipped by scheduler)
 *   DAILY      → 24 hours
 *   WEEKLY     → 7 days
 *   MONTHLY    → 30 days
 *   QUARTERLY  → 90 days
 *   ANNUALLY   → 365 days
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RESULT MAPPING
 * ═══════════════════════════════════════════════════════════════════════
 *
 * After each check:
 *   - IntegrationExecution row created (PASSED/FAILED/ERROR)
 *   - Evidence row created (type: CONFIGURATION, source: integration)
 *   - Practice.nextDueAt advanced to next window
 *
 * Usage (cron):
 *   import { runScheduledAutomations } from '@/app-layer/jobs/automation-runner';
 *   await runScheduledAutomations();                    // all tenants, now
 *   await runScheduledAutomations({ tenantId: 'xxx' }); // specific tenant
 *   await runScheduledAutomations({ dryRun: true });    // preview only
 *
 * @module jobs/automation-runner
 */
import { Prisma, EvidenceType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { registry } from '../integrations/registry';
import { isScheduledCheckProvider, parseAutomationKey } from '../integrations/types';
import type { CheckInput, CheckResult } from '../integrations/types';
import { decryptField } from '@/lib/security/encryption';

// ─── Types ───────────────────────────────────────────────────────────

export interface AutomationRunnerOptions {
    tenantId?: string;
    now?: Date;
    dryRun?: boolean;
}

export interface AutomationRunnerResult {
    totalDue: number;
    executed: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    dryRun: boolean;
    jobRunId: string;
}

interface DuePractice {
    id: string;
    tenantId: string;
    automationKey: string;
    frequency: string | null;
    nextDueAt: Date | null;
    name: string;
}

// ─── Frequency → Interval Mapping ────────────────────────────────────

const FREQUENCY_INTERVALS_MS: Record<string, number> = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
    QUARTERLY: 90 * 24 * 60 * 60 * 1000,
    ANNUALLY: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Get the interval in ms for a given frequency.
 * Returns null for AD_HOC or unknown frequencies.
 */
export function getFrequencyIntervalMs(frequency: string | null): number | null {
    if (!frequency || frequency === 'AD_HOC') return null;
    return FREQUENCY_INTERVALS_MS[frequency] ?? null;
}

/**
 * Calculate the next due date given frequency and current due date.
 */
export function computeNextDueAt(frequency: string | null, fromDate: Date): Date | null {
    const interval = getFrequencyIntervalMs(frequency);
    if (!interval) return null;
    return new Date(fromDate.getTime() + interval);
}

// ─── Due Practice Selection ───────────────────────────────────────────

/**
 * Find practices that are due for automated checks.
 *
 * A practice is due when:
 *   - automationKey is set
 *   - evidenceSource = 'INTEGRATION'
 *   - not deleted, is APPLICABLE
 *   - nextDueAt <= now (or nextDueAt is null and frequency is set)
 *   - no execution within current frequency window
 */
export async function findDueAutomationPractices(
    now: Date,
    tenantId?: string
): Promise<DuePractice[]> {
    const where: Prisma.PracticeWhereInput = {
        automationKey: { not: null },
        evidenceSource: 'INTEGRATION',
        deletedAt: null,
        applicability: 'APPLICABLE',
        frequency: { not: null, notIn: ['AD_HOC'] },
        OR: [
            { nextDueAt: { lte: now } },
            { nextDueAt: null }, // never scheduled yet — execute immediately
        ],
    };

    if (tenantId) {
        where.tenantId = tenantId;
    } else {
        where.tenantId = { not: null }; // only tenant-scoped practices
    }

    const practices = await prisma.practice.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            automationKey: true,
            frequency: true,
            nextDueAt: true,
            name: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: 500, // bounded batch size
    });

    // Filter: skip practices where a recent execution already exists within the window
    const duePractices: DuePractice[] = [];

    for (const ctrl of practices) {
        if (!ctrl.tenantId || !ctrl.automationKey) continue;

        const interval = getFrequencyIntervalMs(ctrl.frequency);
        if (!interval) continue;

        // Check for existing execution within the current window
        const windowStart = new Date(now.getTime() - interval);
        const recentExecution = await prisma.integrationExecution.findFirst({
            where: {
                practiceId: ctrl.id,
                tenantId: ctrl.tenantId,
                automationKey: ctrl.automationKey,
                status: { in: ['PASSED', 'FAILED', 'RUNNING'] },
                executedAt: { gte: windowStart },
            },
            select: { id: true },
        });

        if (!recentExecution) {
            duePractices.push({
                id: ctrl.id,
                tenantId: ctrl.tenantId,
                automationKey: ctrl.automationKey,
                frequency: ctrl.frequency,
                nextDueAt: ctrl.nextDueAt,
                name: ctrl.name,
            });
        }
    }

    return duePractices;
}

// ─── Single Practice Execution ────────────────────────────────────────

/**
 * Decrypt connection secrets safely.
 */
function decryptSecrets(secretEncrypted: string | null): Record<string, unknown> {
    if (!secretEncrypted) return {};
    try {
        return JSON.parse(decryptField(secretEncrypted));
    } catch {
        return {};
    }
}

/**
 * Execute an automation check for a single practice.
 * Creates IntegrationExecution, Evidence, and updates Practice scheduling.
 */
export async function executePracticeAutomation(
    practice: DuePractice,
    jobRunId: string,
    now: Date
): Promise<{ status: 'PASSED' | 'FAILED' | 'ERROR'; executionId: string }> {
    const parsed = parseAutomationKey(practice.automationKey);
    if (!parsed) {
        logger.warn('Invalid automationKey', {
            component: 'automation-runner',
            practiceId: practice.id,
            automationKey: practice.automationKey,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Resolve provider
    const resolution = registry.resolveByAutomationKey(practice.automationKey);
    if (!resolution) {
        logger.warn('No provider for automationKey', {
            component: 'automation-runner',
            automationKey: practice.automationKey,
        });
        return { status: 'ERROR', executionId: '' };
    }

    const { provider } = resolution;
    if (!isScheduledCheckProvider(provider)) {
        logger.warn('Provider does not support scheduled checks', {
            component: 'automation-runner',
            provider: parsed.provider,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Find active connection
    const connection = await prisma.integrationConnection.findFirst({
        where: {
            tenantId: practice.tenantId,
            provider: parsed.provider,
            isEnabled: true,
        },
    });

    if (!connection) {
        logger.warn('No active connection for provider', {
            component: 'automation-runner',
            tenantId: practice.tenantId,
            provider: parsed.provider,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Create RUNNING execution
    const execution = await prisma.integrationExecution.create({
        data: {
            tenantId: practice.tenantId,
            connectionId: connection.id,
            provider: parsed.provider,
            automationKey: practice.automationKey,
            practiceId: practice.id,
            status: 'RUNNING',
            triggeredBy: 'scheduled',
            jobRunId,
        },
    });

    // Execute check
    const startTime = Date.now();
    let result: CheckResult;

    try {
        const secrets = decryptSecrets(connection.secretEncrypted);
        const checkInput: CheckInput = {
            automationKey: practice.automationKey,
            parsed,
            tenantId: practice.tenantId,
            practiceId: practice.id,
            connectionConfig: {
                ...(connection.configJson as Record<string, unknown>),
                ...secrets,
            },
            triggeredBy: 'scheduled',
            jobRunId,
        };

        result = await provider.runCheck(checkInput);
    } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        await prisma.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: 'ERROR',
                errorMessage,
                durationMs,
                completedAt: now,
            },
        });

        return { status: 'ERROR', executionId: execution.id };
    }

    const durationMs = result.durationMs ?? (Date.now() - startTime);

    // Create evidence from result
    let evidenceId: string | undefined;
    const evidencePayload = provider.mapResultToEvidence(
        {
            automationKey: practice.automationKey,
            parsed,
            tenantId: practice.tenantId,
            practiceId: practice.id,
            connectionConfig: {},
            triggeredBy: 'scheduled',
            jobRunId,
        },
        result
    );

    if (evidencePayload) {
        const evidence = await prisma.evidence.create({
            data: {
                tenantId: practice.tenantId,
                practiceId: practice.id,
                // EvidencePayload.type uses integration-layer vocab (CONFIGURATION etc.)
                // that maps to Prisma EvidenceType at runtime; cast is narrow and bounded.
                type: evidencePayload.type as EvidenceType,
                title: evidencePayload.title,
                content: evidencePayload.content,
                category: evidencePayload.category ?? 'integration',
                status: 'APPROVED',
            },
        });
        evidenceId = evidence.id;
    }

    // Update execution
    await prisma.integrationExecution.update({
        where: { id: execution.id },
        data: {
            status: result.status,
            resultJson: result.details as Prisma.InputJsonValue,
            evidenceId,
            errorMessage: result.errorMessage,
            durationMs,
            completedAt: now,
        },
    });

    // Advance practice scheduling. This also wrote `lastTested: now`
    // until that column went with the practice exoskeleton — a stale
    // scalar in a Prisma `update` throws at runtime rather than being
    // ignored, so every scheduled automation run was failing here. The
    // run timestamp is still recorded on the IntegrationExecution row
    // written above, which is where callers read it from.
    const nextDueAt = computeNextDueAt(practice.frequency, now);
    if (nextDueAt) {
        await prisma.practice.update({
            where: { id: practice.id },
            data: { nextDueAt },
        });
    }

    return { status: result.status, executionId: execution.id };
}

// ─── Batch Runner ────────────────────────────────────────────────────

/**
 * Run all due scheduled automations.
 *
 * This is the main entry point called by cron.
 * Uses runJob() for structured observability.
 */
export async function runScheduledAutomations(
    options: AutomationRunnerOptions = {}
): Promise<AutomationRunnerResult> {
    return runJob('automation-runner', async () => {
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const jobRunId = crypto.randomUUID();

        // 1. Find due practices
        const duePractices = await findDueAutomationPractices(now, options.tenantId);

        logger.info('Automation runner: due practices found', {
            component: 'automation-runner',
            totalDue: duePractices.length,
            dryRun,
            jobRunId,
        });

        if (dryRun) {
            return {
                totalDue: duePractices.length,
                executed: 0,
                passed: 0,
                failed: 0,
                errors: 0,
                skipped: duePractices.length,
                dryRun: true,
                jobRunId,
            };
        }

        // 2. Execute each practice
        let executed = 0;
        let passed = 0;
        let failed = 0;
        let errors = 0;
        let skipped = 0;

        for (const practice of duePractices) {
            // Verify provider exists before executing
            if (!registry.canHandle(practice.automationKey)) {
                skipped++;
                logger.info('Automation runner: skipping (no provider)', {
                    component: 'automation-runner',
                    practiceId: practice.id,
                    automationKey: practice.automationKey,
                });
                continue;
            }

            try {
                const result = await executePracticeAutomation(practice, jobRunId, now);
                executed++;

                switch (result.status) {
                    case 'PASSED': passed++; break;
                    case 'FAILED': failed++; break;
                    case 'ERROR': errors++; break;
                }
            } catch (err) {
                errors++;
                logger.error('Automation runner: execution failed', {
                    component: 'automation-runner',
                    practiceId: practice.id,
                    err: err instanceof Error ? err : new Error(String(err)),
                });
            }
        }

        logger.info('Automation runner: batch complete', {
            component: 'automation-runner',
            jobRunId,
            totalDue: duePractices.length,
            executed,
            passed,
            failed,
            errors,
            skipped,
        });

        return {
            totalDue: duePractices.length,
            executed,
            passed,
            failed,
            errors,
            skipped,
            dryRun: false,
            jobRunId,
        };
    }, { tenantId: options.tenantId });
}
