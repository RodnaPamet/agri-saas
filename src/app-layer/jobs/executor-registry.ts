/**
 * Job Executor Registry — Typed Job Dispatch
 *
 * Provides a central, type-safe registry that maps job names to their
 * executor functions. This decouples job *dispatch* from job *scheduling*,
 * allowing any entrypoint (BullMQ worker, Vercel Cron route, node-cron,
 * CLI scripts) to execute jobs through one unified interface.
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
 *   │ BullMQ      │────▶│                  │────▶│ automation   │
 *   │ Worker      │     │  ExecutorRegistry │     │ runner       │
 *   ├─────────────┤     │                  │     ├──────────────┤
 *   │ Vercel Cron │────▶│  .execute(name,  │────▶│ evidence     │
 *   │ Route       │     │    payload)       │     │ expiry       │
 *   ├─────────────┤     │                  │     ├──────────────┤
 *   │ node-cron   │────▶│  .getExecutor()  │────▶│ retention    │
 *   │ Scheduler   │     │  .listRegistered()│    │ sweep        │
 *   └─────────────┘     └──────────────────┘     └──────────────┘
 *
 * Usage:
 *   import { executorRegistry } from '@/app-layer/jobs/executor-registry';
 *   const result = await executorRegistry.execute('vendor-renewal-check', {});
 *
 * Adding new jobs:
 *   1. Define payload in types.ts (JobPayloadMap)
 *   2. Create job module (e.g. vendor-renewal-check.ts)
 *   3. Register executor below
 *
 * @module app-layer/jobs/executor-registry
 */
import { logger } from '@/lib/observability/logger';
import { recordJobMetrics } from '@/lib/observability/metrics';
import { env } from '@/env';
import type { JobName, JobPayload, JobRunResult } from './types';

// ─── Executor Contract ──────────────────────────────────────────────

/**
 * Optional context the worker passes to executors that benefit from
 * mid-run observability hooks. Today only `updateProgress` is wired —
 * forwarded by the BullMQ worker as `(p) => job.updateProgress(p)`.
 * The Vercel Cron / node-cron / CLI entrypoints don't supply this
 * (they run outside a BullMQ Job), so executors must treat the
 * callbacks as optional and degrade gracefully when absent.
 *
 * Payload shape is intentionally `unknown` — each executor designs
 * its own progress JSON. The shape MUST NOT carry secrets, raw
 * keys, or anything sensitive: it's surfaced via the public job-
 * status endpoints.
 */
export interface JobExecutorContext {
    /**
     * Report mid-run progress. Called per meaningful boundary
     * (typically per batch / per phase). The callback awaits the
     * underlying transport (BullMQ -> Redis); executors should
     * `await` it so the GET status endpoint sees the latest value
     * immediately.
     */
    updateProgress?: (progress: unknown) => Promise<void>;
}

/**
 * A job executor function.
 *
 * Takes a typed payload and returns a `JobRunResult`.
 * Executors are responsible for:
 *   - Performing the job's business logic
 *   - Using `runJob()` for observability
 *   - Returning a consistent `JobRunResult`
 *   - NOT catching errors (let the registry handle fault isolation)
 *
 * The optional `ctx` argument carries worker-injected hooks (e.g.
 * BullMQ progress reporting). Executors that don't need it can
 * ignore it; entrypoints that don't supply it (cron, CLI) pass
 * nothing.
 */
export type JobExecutor<T extends JobName> = (
    payload: JobPayload<T>,
    ctx?: JobExecutorContext,
) => Promise<JobRunResult>;

// ─── Registry Implementation ────────────────────────────────────────

/**
 * Internal storage for registered executors.
 * Uses `Map` for O(1) lookup and safe iteration.
 */
const executors = new Map<string, JobExecutor<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The executor registry — singleton service.
 *
 * Thread-safe in Node.js (single-threaded). Registry mutations
 * (register) should only happen at module load time.
 */
export const executorRegistry = {
    /**
     * Register a job executor.
     *
     * @param name — job name (must match a key in JobPayloadMap)
     * @param executor — async function that processes the job
     * @throws if a duplicate registration is attempted
     */
    register<T extends JobName>(name: T, executor: JobExecutor<T>): void {
        if (executors.has(name)) {
            throw new Error(
                `Duplicate executor registration for job "${name}". ` +
                `Each job must have exactly one executor.`,
            );
        }
        executors.set(name, executor);
        logger.debug('executor registered', {
            component: 'executor-registry',
            jobName: name,
        });
    },

    /**
     * Execute a job by name with fault isolation.
     *
     * If the executor throws, the error is caught, logged, and
     * a failure `JobRunResult` is returned. One failing job
     * never crashes the scheduler or other jobs.
     *
     * @param name — job name
     * @param payload — typed payload
     * @param ctx — optional hooks (e.g. BullMQ progress callback)
     *   forwarded by the worker. Cron / CLI entrypoints leave this
     *   unset; executors that need progress must guard the calls.
     * @returns JobRunResult (always — never throws)
     */
    async execute<T extends JobName>(
        name: T,
        payload: JobPayload<T>,
        ctx?: JobExecutorContext,
    ): Promise<JobRunResult> {
        const executor = executors.get(name);
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const jobRunId = crypto.randomUUID();

        if (!executor) {
            logger.error('no executor registered for job', {
                component: 'executor-registry',
                jobName: name,
            });
            return {
                jobName: name,
                jobRunId,
                success: false,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: 0,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
                errorMessage: `No executor registered for job "${name}"`,
            };
        }

        try {
            const result = await executor(payload, ctx);
            // ── Record job success metric ──
            recordJobMetrics({
                jobName: name,
                success: result.success,
                durationMs: result.durationMs ?? Math.round(performance.now() - startMs),
            });
            return result;
        } catch (error) {
            const durationMs = Math.round(performance.now() - startMs);
            const errorMessage = error instanceof Error
                ? error.message
                : String(error);

            logger.error('job executor threw', {
                component: 'executor-registry',
                jobName: name,
                jobRunId,
                durationMs,
                error: errorMessage,
            });

            // ── Record job failure metric ──
            recordJobMetrics({ jobName: name, success: false, durationMs });

            return {
                jobName: name,
                jobRunId,
                success: false,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
                errorMessage,
            };
        }
    },

    /**
     * Get the executor for a job name (or undefined).
     * Useful for the BullMQ worker to check registration before dispatch.
     */
    getExecutor<T extends JobName>(name: T): JobExecutor<T> | undefined {
        return executors.get(name) as JobExecutor<T> | undefined;
    },

    /**
     * Check if an executor is registered for a job name.
     */
    has(name: string): boolean {
        return executors.has(name);
    },

    /**
     * List all registered job names.
     */
    listRegistered(): string[] {
        return Array.from(executors.keys());
    },

    /**
     * Total number of registered executors.
     */
    get size(): number {
        return executors.size;
    },

    /**
     * Clear all registrations. **Test-only.**
     * @internal
     */
    _reset(): void {
        executors.clear();
    },
};

// ─── Default Registrations ──────────────────────────────────────────
//
// Each registration uses dynamic import so that heavy modules
// (Prisma, integration SDK, etc.) are only loaded when the job
// actually executes — not at registry import time.
// ─────────────────────────────────────────────────────────────────────

/**
 * Helper: create a normalized JobRunResult from a legacy job's
 * ad-hoc return shape. Jobs that already return JobRunResult
 * should be registered directly.
 */
function makeResult(
    jobName: string,
    startedAt: string,
    startMs: number,
    scanned: number,
    actioned: number,
    skipped: number,
    details?: Record<string, unknown>,
): JobRunResult {
    return {
        jobName,
        jobRunId: crypto.randomUUID(),
        success: true,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startMs),
        itemsScanned: scanned,
        itemsActioned: actioned,
        itemsSkipped: skipped,
        details,
    };
}

// ── health-check ─────────────────────────────────────────────────────

executorRegistry.register('health-check', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    return makeResult('health-check', startedAt, startMs, 0, 0, 0, {
        enqueuedAt: payload.enqueuedAt,
        message: payload.message ?? 'pong',
        processedAt: new Date().toISOString(),
    });
});

// ── embed-chunks (RAG — feat/ai-rag) ─────────────────────────────────
//
// Embeds the tenant's un-embedded KnowledgeChunk rows (bounded batch).
// tenantId scopes the run via runInTenantContext inside runEmbedChunks;
// the executor requires it (the GLOBAL catalog is embedded by the
// ingestion script, not this job).

executorRegistry.register('embed-chunks', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    if (!payload.tenantId) {
        throw new Error('embed-chunks requires a tenantId (GLOBAL catalog is embedded by the ingestion script).');
    }
    const { runEmbedChunks } = await import('./embed-chunks');
    const r = await runEmbedChunks({ tenantId: payload.tenantId, batchSize: payload.batchSize });
    return makeResult(
        'embed-chunks', startedAt, startMs,
        r.scanned, r.embedded, r.scanned - r.embedded,
        { tenantId: r.tenantId, embedded: r.embedded },
    );
});

// ── reindex-knowledge-article (KB agronomy structure PR) ─────────────
//
// Enqueued by publishArticle/archiveArticle/unarchiveArticle. Re-reads
// the article's current state and either paragraph-chunks + replaces its
// KB chunk set (PUBLISHED with content) or removes it (everything else).

executorRegistry.register('reindex-knowledge-article', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runReindexKnowledgeArticle } = await import('./reindex-knowledge-article');
    const r = await runReindexKnowledgeArticle({ tenantId: payload.tenantId, articleId: payload.articleId });
    return makeResult(
        'reindex-knowledge-article', startedAt, startMs,
        r.chunksWritten + r.chunksRemoved, r.chunksWritten, r.chunksRemoved,
        { tenantId: r.tenantId, articleId: r.articleId, action: r.action },
    );
});

// ── automation-runner ────────────────────────────────────────────────

executorRegistry.register('automation-runner', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runScheduledAutomations } = await import('./automation-runner');
    const r = await runScheduledAutomations({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    return makeResult(
        'automation-runner', startedAt, startMs,
        r.totalDue, r.executed, r.skipped,
        { passed: r.passed, failed: r.failed, errors: r.errors, dryRun: r.dryRun },
    );
});

// ── daily-evidence-expiry ────────────────────────────────────────────

executorRegistry.register('daily-evidence-expiry', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runDailyEvidenceExpiryNotifications } = await import('./dailyEvidenceExpiry');
    const r = await runDailyEvidenceExpiryNotifications({
        tenantId: payload.tenantId,
        skipOutbox: payload.skipOutbox,
    });
    const totalCreated = r.sweeps.days30.tasksCreated
        + r.sweeps.days7.tasksCreated + r.sweeps.days1.tasksCreated;
    const totalSkipped = r.sweeps.days30.skippedDuplicate
        + r.sweeps.days7.skippedDuplicate + r.sweeps.days1.skippedDuplicate;
    const totalScanned = r.sweeps.days30.scanned
        + r.sweeps.days7.scanned + r.sweeps.days1.scanned;
    return makeResult(
        'daily-evidence-expiry', startedAt, startMs,
        totalScanned, totalCreated, totalSkipped,
        { sweeps: r.sweeps, outbox: r.outbox },
    );
});

// ── data-lifecycle ───────────────────────────────────────────────────

executorRegistry.register('data-lifecycle', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const {
        purgeSoftDeletedOlderThan,
        purgeExpiredEvidenceOlderThan,
        runRetentionSweep,
    } = await import('./data-lifecycle');

    const purgeResults = await purgeSoftDeletedOlderThan({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    const evidencePurge = await purgeExpiredEvidenceOlderThan({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    const retentionResults = await runRetentionSweep({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });

    const totalScanned = purgeResults.reduce((s, r) => s + r.scanned, 0)
        + evidencePurge.scanned
        + retentionResults.reduce((s, r) => s + r.scanned, 0);
    const totalActioned = purgeResults.reduce((s, r) => s + r.purged, 0)
        + evidencePurge.purged
        + retentionResults.reduce((s, r) => s + r.expired, 0);

    return makeResult(
        'data-lifecycle', startedAt, startMs,
        totalScanned, totalActioned, 0,
        { purgeResults, evidencePurge, retentionResults },
    );
});

// ── policy-review-reminder ───────────────────────────────────────────

executorRegistry.register('policy-review-reminder', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processOverdueReminders } = await import('./policyReviewReminder');
    const { prisma } = await import('@/lib/prisma');
    const r = await processOverdueReminders(prisma, { tenantId: payload.tenantId });
    return makeResult(
        'policy-review-reminder', startedAt, startMs,
        r.processed, r.processed, 0,
        { policies: r.policies },
    );
});

// ── access-review-reminder (Epic G-4) ───────────────────────────────

executorRegistry.register('access-review-reminder', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processAccessReviewReminders } = await import(
        './access-review-reminder'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processAccessReviewReminders(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'access-review-reminder',
        startedAt,
        startMs,
        r.scanned,
        r.enqueued,
        0,
        {
            skippedDuplicate: r.skippedDuplicate,
            skippedNoEmail: r.skippedNoEmail,
            skippedComplete: r.skippedComplete,
        },
    );
});

// ── access-review-overdue-escalation (Audit Coherence S7) ───────────

executorRegistry.register('access-review-overdue-escalation', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processAccessReviewOverdueEscalation } = await import(
        './access-review-overdue-escalation'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processAccessReviewOverdueEscalation(prisma, {
        tenantId: payload.tenantId,
    });
    return makeResult(
        'access-review-overdue-escalation',
        startedAt,
        startMs,
        r.scanned,
        r.enqueued,
        0,
        {
            skippedDuplicate: r.skippedDuplicate,
            skippedNoAdminEmail: r.skippedNoAdminEmail,
            skippedComplete: r.skippedComplete,
        },
    );
});

// ── exchange-expiry-sweep ───────────────────────────────────────────

executorRegistry.register('exchange-expiry-sweep', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runExchangeExpirySweep } = await import('./exchange-expiry-sweep');
    const { prisma } = await import('@/lib/prisma');
    const r = await runExchangeExpirySweep(prisma, { batchSize: payload.batchSize });
    return makeResult(
        'exchange-expiry-sweep',
        startedAt,
        startMs,
        r.scanned,
        r.transitionedToExpired,
        0,
    );
});

executorRegistry.register('soil-fetch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    // Tenant-scoped: soil is fetched + persisted under the payload tenant's
    // RLS context (runSoilFetch builds a tenant ctx from payload.tenantId).
    if (!payload.tenantId) {
        throw new Error('soil-fetch requires a tenantId in the payload.');
    }
    const { runSoilFetch } = await import('./soil-fetch');
    const r = await runSoilFetch(payload);
    return makeResult(
        'soil-fetch', startedAt, startMs,
        r.scanned, r.populated, r.skipped,
        { scanned: r.scanned, populated: r.populated, skipped: r.skipped },
    );
});

// ── task-due-notification ───────────────────────────────────────────

executorRegistry.register('task-due-notification', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { processTaskDueNotifications } = await import(
        './task-due-notification'
    );
    const { prisma } = await import('@/lib/prisma');
    const r = await processTaskDueNotifications(prisma, {
        tenantId: payload.tenantId,
        tz: env.NOTIFICATIONS_TZ,
    });
    return makeResult(
        'task-due-notification',
        startedAt,
        startMs,
        r.scanned,
        r.created,
        r.skippedDuplicate,
        { byWindow: r.byWindow },
    );
});

// ── retention-sweep ──────────────────────────────────────────────────

executorRegistry.register('retention-sweep', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceRetentionSweep } = await import('./retention');
    const r = await runEvidenceRetentionSweep({
        tenantId: payload.tenantId,
        dryRun: payload.dryRun,
    });
    return makeResult(
        'retention-sweep', startedAt, startMs,
        r.scanned, r.archived, 0,
        { expired: r.expired, dryRun: r.dryRun },
    );
});

// ── promotion-lead-retention ─────────────────────────────────────────

executorRegistry.register('promotion-lead-retention', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runPromotionLeadRetentionSweep } = await import('./promotion-lead-retention');
    const r = await runPromotionLeadRetentionSweep({ dryRun: payload.dryRun });
    return makeResult(
        'promotion-lead-retention', startedAt, startMs,
        r.expired + r.purged, r.expired, 0,
        { expired: r.expired, purged: r.purged, dryRun: r.dryRun },
    );
});

// ── vendor-renewal-check ─────────────────────────────────────────────

executorRegistry.register('vendor-renewal-check', async (payload) => {
    const { runVendorRenewalCheck } = await import('./vendor-renewal-check');
    const { result } = await runVendorRenewalCheck({ tenantId: payload.tenantId });
    return result;
});

// ── low-stock-monitor ────────────────────────────────────────────────

executorRegistry.register('low-stock-monitor', async (payload) => {
    const { runLowStockMonitor } = await import('./low-stock-monitor');
    const { result } = await runLowStockMonitor({ tenantId: payload.tenantId });
    return result;
});

// ── lease-expiry-sweep (land administration) ─────────────────────────

executorRegistry.register('lease-expiry-sweep', async (payload) => {
    const { runLeaseExpirySweep } = await import('./lease-expiry-sweep');
    const { result } = await runLeaseExpirySweep({
        tenantId: payload.tenantId,
        withinDays: payload.withinDays,
    });
    return result;
});

// ── contract-delivery-window-sweep (grain fulfilment) ────────────────

executorRegistry.register('contract-delivery-window-sweep', async (payload) => {
    const { runContractDeliveryWindowSweep } = await import(
        './contract-delivery-window-sweep'
    );
    const { result } = await runContractDeliveryWindowSweep({
        tenantId: payload.tenantId,
        withinDays: payload.withinDays,
    });
    return result;
});

// ── reconcile-inventory-ledgers (data-integrity) ─────────────────────

executorRegistry.register('reconcile-inventory-ledgers', async (payload) => {
    const { runReconcileInventoryLedgers } = await import('./reconcile-inventory-ledgers');
    const { result } = await runReconcileInventoryLedgers({ tenantId: payload.tenantId });
    return result;
});

// ── agronomy-copilot (AI — on-demand AgroSignal explanation) ─────────

executorRegistry.register('agronomy-copilot', async (payload) => {
    const { runAgronomyCopilot } = await import('./agronomy-copilot');
    const { result } = await runAgronomyCopilot({
        tenantId: payload.tenantId,
        locationId: payload.locationId,
        kind: payload.kind,
        signalDateIso: payload.signalDateIso,
    });
    return result;
});

// ── classify-photo (AI vision — async LogEntry photo classification) ──
//
// Reads the image bytes, runs the vision orchestrator (on-device ONNX →
// Claude fallback), gates low confidence, grounds the recommendation via
// the RAG knowledge base, and writes the advisory result under
// LogEntry.attributesJson.pestId. tenantId scopes the persist + RAG read
// via runInTenantContext inside runClassifyPhoto.

executorRegistry.register('classify-photo', async (payload) => {
    const { runClassifyPhoto } = await import('./classify-photo');
    const { result } = await runClassifyPhoto({
        tenantId: payload.tenantId,
        logEntryId: payload.logEntryId,
        fileId: payload.fileId,
    });
    return result;
});

// ── weather-pull (Agro-intel) ────────────────────────────────────────

executorRegistry.register('weather-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runWeatherPull } = await import('./weather-pull');
    const r = await runWeatherPull({ tenantId: payload.tenantId });
    return makeResult(
        'weather-pull', startedAt, startMs,
        r.scanned, r.created, 0,
        { tenants: r.tenants, scanned: r.scanned, created: r.created, signals: r.signals },
    );
});

// ── market-prices-pull (Trends) ──────────────────────────────────────

executorRegistry.register('market-prices-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runMarketPricesPull } = await import('./market-prices-pull');
    const r = await runMarketPricesPull({ source: payload.source });
    return makeResult(
        'market-prices-pull', startedAt, startMs,
        r.pointsUpserted + r.listingsScanned, r.pointsUpserted, r.suppressed,
        {
            sources: r.sources,
            seriesTouched: r.seriesTouched,
            pointsUpserted: r.pointsUpserted,
            listingsScanned: r.listingsScanned,
            suppressed: r.suppressed,
        },
    );
});

// ── market-prices-barchart (intraday delayed MATIF) ──────────────────
// Runs the SAME pull scoped to the Barchart source only. Scheduled every
// ~20 min on weekdays, but ONLY when BARCHART_API_KEY is set; without the
// key the pull no-ops, so this executor is a cheap guard either way.
executorRegistry.register('market-prices-barchart', async () => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runMarketPricesPull } = await import('./market-prices-pull');
    const r = await runMarketPricesPull({ source: 'barchart' });
    return makeResult(
        'market-prices-barchart', startedAt, startMs,
        r.pointsUpserted, r.pointsUpserted, r.suppressed,
        {
            sources: r.sources,
            seriesTouched: r.seriesTouched,
            pointsUpserted: r.pointsUpserted,
        },
    );
});

// ── market-news-pull (Trends → News) ─────────────────────────────────

executorRegistry.register('market-news-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runMarketNewsPull } = await import('./market-news-pull');
    const r = await runMarketNewsPull({ feedSlug: payload.feedSlug });
    return makeResult(
        'market-news-pull', startedAt, startMs,
        r.fetched, r.upserted, r.pruned,
        { feeds: r.feeds, fetched: r.fetched, upserted: r.upserted, pruned: r.pruned },
    );
});

// ── news-event-extraction (calendar roadmap PR 3 — AI news calendar events) ──
// Daily extraction of subsidy/regulation dates from the GLOBAL policy-news
// cache via Claude Haiku. Scheduled ONLY when ANTHROPIC_API_KEY is set (see
// schedules.ts); without the key the run no-ops
// (isNewsEventExtractionConfigured() gate inside the job), so this
// executor is a cheap guard either way.
executorRegistry.register('news-event-extraction', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runNewsEventExtraction } = await import('./news-event-extraction');
    const r = await runNewsEventExtraction({ lookbackHours: payload.lookbackHours });
    return makeResult(
        'news-event-extraction', startedAt, startMs,
        r.scanned, r.created, r.skipped,
        { scanned: r.scanned, extracted: r.extracted, created: r.created, skipped: r.skipped },
    );
});

// ── support-scheme-extraction ────────────────────────────────────────
//
// The schedule only registers when ANTHROPIC_API_KEY is set, but an ad-hoc /
// CLI / API-triggered run reaches this executor regardless — the job's own
// `isSupportSchemeExtractionConfigured()` gate makes that a clean no-op.

executorRegistry.register('support-scheme-extraction', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSupportSchemeExtraction } = await import('./support-scheme-extraction');
    const r = await runSupportSchemeExtraction({ lookbackHours: payload.lookbackHours });
    return makeResult(
        'support-scheme-extraction', startedAt, startMs,
        r.scanned, r.created, r.skipped,
        { scanned: r.scanned, extracted: r.extracted, created: r.created, skipped: r.skipped },
    );
});

// ── deadline-monitor ─────────────────────────────────────────────────

executorRegistry.register('deadline-monitor', async (payload) => {
    const { runDeadlineMonitor } = await import('./deadline-monitor');
    const { result } = await runDeadlineMonitor({
        tenantId: payload.tenantId,
        windows: payload.windows,
    });
    return result;
});

// ── evidence-expiry-monitor ──────────────────────────────────────────

executorRegistry.register('evidence-expiry-monitor', async (payload) => {
    const { runEvidenceExpiryMonitor } = await import('./evidence-expiry-monitor');
    const { result } = await runEvidenceExpiryMonitor({
        tenantId: payload.tenantId,
        windows: payload.windows,
    });
    return result;
});

// ── evidence-stale-review-sweep ──────────────────────────────────────
//
// Written 2026-05-22, registered 2026-08-05. In between it had zero callers:
// `nextReviewDate` was settable, shown in the compliance calendar, and counted
// by the dashboard's overdue tile, while nothing ever acted on it. Evidence
// aged past its review date holding status APPROVED, and readiness counted it
// as fresh — the precise failure the usecase's own docblock describes.

executorRegistry.register('evidence-stale-review-sweep', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceStaleReviewSweep } = await import(
        '../usecases/evidence-stale-review-sweep'
    );
    const r = await runEvidenceStaleReviewSweep({ tenantId: payload.tenantId });
    return makeResult(
        'evidence-stale-review-sweep', startedAt, startMs,
        r.transitioned, r.transitioned, 0,
        { transitioned: r.transitioned },
    );
});

// ── notification-dispatch ────────────────────────────────────────────

executorRegistry.register('notification-dispatch', async (payload) => {
    const { runNotificationDispatch } = await import('./notification-dispatch');
    const { result } = await runNotificationDispatch({
        tenantId: payload.tenantId,
        categories: payload.categories,
        windows: payload.windows,
    });
    return result;
});

// ── sync-pull ────────────────────────────────────────────────────────

executorRegistry.register('sync-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSyncPull } = await import('./sync-pull');
    await runSyncPull(payload);
    return makeResult('sync-pull', startedAt, startMs, 1, 1, 0, {
        provider: payload.mappingKey.provider,
        remoteEntityType: payload.mappingKey.remoteEntityType,
    });
});

// ── compliance-snapshot ──────────────────────────────────────────────

executorRegistry.register('compliance-snapshot', async (payload) => {
    const { runSnapshotJob } = await import('./snapshot');
    const { result } = await runSnapshotJob({
        tenantId: payload.tenantId,
        date: payload.date ? new Date(payload.date) : undefined,
    });
    return result;
});

// ── sla-monitor (Automation Epic 5) ──────────────────────────────────

executorRegistry.register('sla-monitor', async (payload) => {
    const { runSlaMonitorJob } = await import('./sla-monitor');
    const { result } = await runSlaMonitorJob({ tenantId: payload.tenantId });
    return result;
});

// ── rule-chain-dispatch (Automation Epic 7) ──────────────────────────

executorRegistry.register('rule-chain-dispatch', async (payload) => {
    const { runRuleChainDispatch } = await import('./rule-chain-dispatch');
    // Tenant scope: payload.tenantId flows through to the chain dispatcher,
    // which scopes every query by it (and the chained execution rows).
    const { result } = await runRuleChainDispatch({ ...payload, tenantId: payload.tenantId });
    return result;
});

// ── subflow-dispatch (Visual Rule Editor VR-7) ───────────────────────
executorRegistry.register('subflow-dispatch', async (payload) => {
    const { runSubflowDispatch } = await import('./subflow-dispatcher');
    // Tenant scope: payload.tenantId scopes the entry-rule lookup + the child
    // execution rows.
    const { result } = await runSubflowDispatch({ ...payload, tenantId: payload.tenantId });
    return result;
});

// ── schedule-trigger-sweep (PR-E) ────────────────────────────────────
// Global sweep — scans every tenant's SCHEDULE rules and enqueues a
// per-(rule, entity) targeted dispatch (each scoped to the rule's tenantId
// inside runScheduleTriggerSweep + the dispatch it enqueues).
executorRegistry.register('schedule-trigger-sweep', async () => {
    const { runScheduleTriggerSweep } = await import('./schedule-trigger-sweep');
    const { result } = await runScheduleTriggerSweep(new Date());
    return result;
});

// ── compliance-digest ────────────────────────────────────────────────

executorRegistry.register('compliance-digest', async (payload) => {
    const { runComplianceDigest } = await import('./compliance-digest');
    const { result } = await runComplianceDigest({
        tenantId: payload.tenantId,
        recipientOverrides: payload.recipientOverrides,
        trendDays: payload.trendDays,
    });
    return result;
});

// ── key-rotation (Epic B.3) ──────────────────────────────────────────

executorRegistry.register('key-rotation', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runKeyRotation } = await import('./key-rotation');
    const r = await runKeyRotation({
        tenantId: payload.tenantId,
        initiatedByUserId: payload.initiatedByUserId,
        requestId: payload.requestId,
    });
    return makeResult(
        'key-rotation',
        startedAt,
        startMs,
        r.totalScanned,
        r.totalRewritten,
        0,
        {
            tenantId: r.tenantId,
            dekRewrapped: r.dekRewrapped,
            dekRewrapError: r.dekRewrapError,
            perField: r.perField,
            totalErrors: r.totalErrors,
            jobRunId: r.jobRunId,
        },
    );
});

// ── tenant-dek-rotation (Epic F.2 follow-up) ────────────────────────

executorRegistry.register('tenant-dek-rotation', async (payload, ctx) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runTenantDekRotation } = await import('./tenant-dek-rotation');
    const r = await runTenantDekRotation({
        tenantId: payload.tenantId,
        initiatedByUserId: payload.initiatedByUserId,
        requestId: payload.requestId,
        batchSize: payload.batchSize,
        // GAP-22: forward the worker's progress callback so the GET
        // /admin/tenant-dek-rotation status endpoint sees live
        // counters mid-rotation, not just empty progress until the
        // job completes.
        onProgress: ctx?.updateProgress,
    });
    return makeResult(
        'tenant-dek-rotation',
        startedAt,
        startMs,
        r.totalScanned,
        r.totalRewritten,
        r.totalSkipped,
        {
            tenantId: r.tenantId,
            previousEncryptedDekCleared: r.previousEncryptedDekCleared,
            perField: r.perField,
            totalErrors: r.totalErrors,
            jobRunId: r.jobRunId,
        },
    );
});

// ── automation-event-dispatch ────────────────────────────────────────
//
// One job invocation per domain event. Loads matching rules, evaluates
// filters, claims an AutomationExecution row per match, advances to
// SUCCEEDED/FAILED. See `automation-event-dispatch.ts` for the full
// flow + scope boundaries.

executorRegistry.register('automation-event-dispatch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runAutomationEventDispatch } = await import(
        './automation-event-dispatch'
    );
    const r = await runAutomationEventDispatch(payload);
    return makeResult(
        'automation-event-dispatch',
        startedAt,
        startMs,
        r.rulesConsidered,
        r.executionsCreated,
        r.executionsSkippedDuplicate + r.executionsSkippedFilter,
        {
            tenantId: r.tenantId,
            event: r.event,
            rulesMatched: r.rulesMatched,
            executionsFailed: r.executionsFailed,
            jobRunId: r.jobRunId,
        }
    );
});

// ── evidence-import (Epic 43.3) ──────────────────────────────────────
//
// One job invocation per uploaded ZIP. The HTTP layer stages the
// archive under `temp/<tenantId>/...` and enqueues this job; the
// worker streams the archive, runs the safety guards, and creates
// individual evidence rows via `uploadEvidenceFile`. See
// `evidence-import.ts` for the full safety bound + cleanup flow.

executorRegistry.register('evidence-import', async (payload, ctx) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runEvidenceImport } = await import('./evidence-import');
    const r = await runEvidenceImport(payload, async (progress) => {
        // Forward live counters to the BullMQ progress channel so the
        // GET /evidence/imports/:jobId status endpoint can show
        // mid-flight progress instead of waiting for completion.
        if (ctx?.updateProgress) {
            await ctx.updateProgress(progress);
        }
    });
    return makeResult(
        'evidence-import',
        startedAt,
        startMs,
        r.totalEntries,
        r.extracted,
        r.skipped + r.errored,
        {
            tenantId: r.tenantId,
            extracted: r.extracted,
            skipped: r.skipped,
            errored: r.errored,
            evidenceIds: r.evidenceIds,
            skipReasons: r.skipReasons,
            firstError: r.firstError,
            jobRunId: r.jobRunId,
        },
    );
});

// SP-3 — SharePoint delta sync (one connection).
executorRegistry.register('sharepoint-delta-sync', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointDeltaSyncJob } = await import('./sharepoint-delta-sync');
    const r = await runSharePointDeltaSyncJob(payload);
    return makeResult('sharepoint-delta-sync', startedAt, startMs, r.drivesSynced, r.reimported, r.staled, {
        tenantId: payload.tenantId,
        connectionId: payload.connectionId,
        reimported: r.reimported,
        staled: r.staled,
    });
});

// SP-3 — daily fan-out across all enabled SharePoint connections.
executorRegistry.register('sharepoint-delta-sync-dispatch', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointDeltaSyncDispatch } = await import('./sharepoint-delta-sync');
    const r = await runSharePointDeltaSyncDispatch(payload);
    return makeResult('sharepoint-delta-sync-dispatch', startedAt, startMs, r.connections, r.dispatched, 0, {
        connections: r.connections,
        dispatched: r.dispatched,
    });
});

// SP-4 — pull a changed policy from SharePoint (webhook-enqueued).
executorRegistry.register('sharepoint-policy-pull', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointPolicyPull } = await import('./sharepoint-policy-jobs');
    const r = await runSharePointPolicyPull(payload);
    return makeResult('sharepoint-policy-pull', startedAt, startMs, 1, r.pulled ? 1 : 0, r.pulled ? 0 : 1, {
        tenantId: payload.tenantId,
        policyId: payload.policyId,
        pulled: r.pulled,
    });
});

// SP-4 — daily renewal of all active policy Graph subscriptions.
executorRegistry.register('sharepoint-subscription-renew', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runSharePointSubscriptionRenew } = await import('./sharepoint-policy-jobs');
    const r = await runSharePointSubscriptionRenew(payload);
    return makeResult('sharepoint-subscription-renew', startedAt, startMs, r.subscriptions, r.renewed, 0, {
        subscriptions: r.subscriptions,
        renewed: r.renewed,
    });
});

// ── spatial-import (parcel-boundary upload hardening) ────────────────
//
// One job invocation per staged shapefile/KML/GeoJSON. The HTTP layer
// enforces the per-format byte cap + stages the upload; the worker
// parses it off-thread under a 30s budget, enforces the parcel-
// complexity caps, validates every geometry's topology (ST_IsValid),
// and only then replaces the location's parcels. See `spatial-import.ts`
// for the full defence-layer flow.
executorRegistry.register('spatial-import', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runLocationSpatialImport } = await import('./spatial-import');
    const r = await runLocationSpatialImport(payload);
    return makeResult(
        'spatial-import', startedAt, startMs,
        r.parcelCount, r.parcelCount, r.skipped,
        {
            tenantId: r.tenantId,
            locationId: r.locationId,
            fileRecordId: r.fileRecordId,
            format: r.format,
            parcelCount: r.parcelCount,
            bounds: r.bounds,
            jobRunId: r.jobRunId,
        },
    );
});

// ── cadastre-import (КАИС OpenData import by identifier) ─────────────
//
// One job invocation per staged identifier list. Groups by ЕКАТТЕ, fetches
// each settlement's land-parcels archive from КАИС OpenData (cache-first via
// the global CadastreArchive row), parses + selects the requested features,
// strips owner-ish attributes, reprojects КС2005 → 4326, and appends them to
// the location. Reports not-found identifiers. See `cadastre-import.ts`.
executorRegistry.register('cadastre-import', async (payload) => {
    const startedAt = new Date().toISOString();
    const startMs = performance.now();
    const { runCadastreImport } = await import('./cadastre-import');
    const r = await runCadastreImport(payload);
    return makeResult(
        'cadastre-import', startedAt, startMs,
        r.requested, r.imported, r.notFound.length,
        {
            tenantId: r.tenantId,
            locationId: r.locationId,
            requested: r.requested,
            imported: r.imported,
            notFound: r.notFound,
            ekatteCached: r.ekatteCached,
            ekatteFetched: r.ekatteFetched,
            bounds: r.bounds,
            jobRunId: r.jobRunId,
        },
    );
});

// RQ-9 — daily cross-tenant risk + portfolio snapshot.

// БАБХ farm-record — regenerate a location's current-season ДНЕВНИК into its
// Farm-records register when a field task auto-resolves. Fail-open: the job
// never throws (task completion is unaffected). See ./farm-record-pdf.
executorRegistry.register('farm-record-pdf', async (payload) => {
    const { runFarmRecordPdf } = await import('./farm-record-pdf');
    const { result } = await runFarmRecordPdf({
        tenantId: payload.tenantId,
        taskId: payload.taskId,
    });
    return result;
});
