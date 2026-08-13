/**
 * Notification Dispatch Job — Unified Monitor → Digest Pipeline
 *
 * Single-pass orchestration job that:
 *   1. Runs each monitor ONCE (or accepts pre-computed DueItems)
 *   2. Dispatches grouped digest notifications
 *   3. Returns a unified JobRunResult
 *
 * ARCHITECTURE (single-run pipeline):
 *   ┌──────────────────┐     ┌────────────────┐     ┌─────────────┐
 *   │ deadline-monitor  │────▶│                │     │             │
 *   │ evidence-expiry   │────▶│  DueItem[]     │────▶│   digest    │
 *   │ vendor-renewal    │────▶│  (computed     │     │  dispatcher │
 *   │                   │     │   ONCE)        │     │             │
 *   └──────────────────┘     └────────────────┘     └─────────────┘
 *
 * The monitors are run internally by this job. They do NOT need
 * to be scheduled separately. This eliminates duplicate DB scans.
 *
 * INVARIANT — ONE-PASS DETECTION:
 *   Detection happens ONCE per dispatch run. The digest-dispatcher
 *   consumes the generated DueItem[] findings — it must NEVER rescan
 *   source entity tables (practice, policy, evidence, vendor, etc.).
 *   If you need to add a new entity monitor, add it HERE and pass
 *   its DueItem[] to dispatchDigest(). Do NOT schedule it separately.
 *   Regression guard: tests/unit/notification-pipeline-regression.test.ts
 *
 * Schedule: daily at 07:00 UTC (replaces individual monitor schedules)
 *
 * @module app-layer/jobs/notification-dispatch
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import type { DueItem, JobRunResult } from './types';
import type { DispatchDigestResult } from '../notifications/digest-dispatcher';

export interface NotificationDispatchPayload {
    tenantId?: string;
    /** Which categories to dispatch. Default: all */
    categories?: ('DEADLINE_DIGEST' | 'EVIDENCE_EXPIRY_DIGEST')[];
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
    /**
     * Pre-computed DueItems from an upstream pipeline stage.
     * When provided, the dispatch skips the corresponding monitor scan.
     * This is the primary mechanism for eliminating duplicate DB reads.
     */
    precomputed?: {
        deadlineItems?: DueItem[];
        evidenceItems?: DueItem[];
        vendorItems?: DueItem[];
    };
}

export interface NotificationDispatchResult {
    deadlines: DispatchDigestResult | null;
    evidenceExpiry: DispatchDigestResult | null;
    totalEnqueued: number;
    totalSkipped: number;
    /** Indicates which monitors were reused vs freshly scanned */
    scanSource: {
        deadlines: 'precomputed' | 'scanned' | 'skipped';
        evidence: 'precomputed' | 'scanned' | 'skipped';
        vendors: 'precomputed' | 'scanned' | 'skipped';
    };
}

export async function runNotificationDispatch(
    payload: NotificationDispatchPayload = {},
): Promise<{ result: JobRunResult; dispatch: NotificationDispatchResult }> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob('notification-dispatch', async () => {
        const categories = payload.categories ?? [
            'DEADLINE_DIGEST',
            'EVIDENCE_EXPIRY_DIGEST',
        ];

        let deadlines: DispatchDigestResult | null = null;
        let evidenceExpiry: DispatchDigestResult | null = null;

        const scanSource: NotificationDispatchResult['scanSource'] = {
            deadlines: 'skipped',
            evidence: 'skipped',
            vendors: 'skipped',
        };

        // Lazy imports to avoid loading heavy modules at boot
        const { dispatchDigest } = await import('../notifications/digest-dispatcher');

        // 1. Deadline digests
        if (categories.includes('DEADLINE_DIGEST')) {
            let items: DueItem[];

            if (payload.precomputed?.deadlineItems) {
                items = payload.precomputed.deadlineItems;
                scanSource.deadlines = 'precomputed';
                logger.info('deadline items: using precomputed results', {
                    component: 'notification-dispatch',
                    itemCount: items.length,
                });
            } else {
                // The base deadline-monitor covers
                // Practice/Policy/Task/Risk/TestPlan. Epic 49 adds the
                // GRC teardown phase 2: the calendar-deadlines monitor
                // scanned AuditCycle / VendorDocument / Finding — all three
                // KILL — so it went with them. runDeadlineMonitor is the
                // surviving scanner and the DEADLINE_DIGEST stream (and its
                // per-day per-recipient dedupe) is unchanged.
                const { runDeadlineMonitor } = await import('./deadline-monitor');
                const base = await runDeadlineMonitor({
                    tenantId: payload.tenantId,
                    windows: payload.windows,
                });
                items = base.items;
                scanSource.deadlines = 'scanned';
            }

            deadlines = await dispatchDigest({
                category: 'DEADLINE_DIGEST',
                items,
            });
            logger.info('deadline digests dispatched', {
                component: 'notification-dispatch',
                source: scanSource.deadlines,
                items: items.length,
                enqueued: deadlines.enqueued,
                skipped: deadlines.skipped,
            });
        }

        // 2. Evidence expiry digests
        if (categories.includes('EVIDENCE_EXPIRY_DIGEST')) {
            let items: DueItem[];

            if (payload.precomputed?.evidenceItems) {
                items = payload.precomputed.evidenceItems;
                scanSource.evidence = 'precomputed';
                logger.info('evidence items: using precomputed results', {
                    component: 'notification-dispatch',
                    itemCount: items.length,
                });
            } else {
                const { runEvidenceExpiryMonitor } = await import('./evidence-expiry-monitor');
                const monitor = await runEvidenceExpiryMonitor({
                    tenantId: payload.tenantId,
                    windows: payload.windows,
                });
                items = monitor.items;
                scanSource.evidence = 'scanned';
            }

            evidenceExpiry = await dispatchDigest({
                category: 'EVIDENCE_EXPIRY_DIGEST',
                items,
            });
            logger.info('evidence expiry digests dispatched', {
                component: 'notification-dispatch',
                source: scanSource.evidence,
                items: items.length,
                enqueued: evidenceExpiry.enqueued,
                skipped: evidenceExpiry.skipped,
            });
        }

        const totalEnqueued = (deadlines?.enqueued ?? 0) + (evidenceExpiry?.enqueued ?? 0);
        const totalSkipped = (deadlines?.skipped ?? 0) + (evidenceExpiry?.skipped ?? 0);
        const totalItems = (deadlines?.totalItems ?? 0) + (evidenceExpiry?.totalItems ?? 0);
        const durationMs = Math.round(performance.now() - startMs);

        const dispatch: NotificationDispatchResult = {
            deadlines,
            evidenceExpiry,
            totalEnqueued,
            totalSkipped,
            scanSource,
        };

        const result: JobRunResult = {
            jobName: 'notification-dispatch',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            itemsScanned: totalItems,
            itemsActioned: totalEnqueued,
            itemsSkipped: totalSkipped,
            details: {
                scanSource,
                deadlines: deadlines ? { enqueued: deadlines.enqueued, skipped: deadlines.skipped } : null,
                evidenceExpiry: evidenceExpiry ? { enqueued: evidenceExpiry.enqueued, skipped: evidenceExpiry.skipped } : null,
            },
        };

        return { result, dispatch };
    }, { tenantId: payload.tenantId });
}
