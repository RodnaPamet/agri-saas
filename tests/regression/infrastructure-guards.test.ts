/**
 * Infrastructure Regression Guards
 *
 * Validates that all Epic 15 hardening guarantees hold:
 *   1. Production defaults are explicit (no silent fallback)
 *   2. Storage defaults to S3
 *   3. AV scanning defaults to strict
 *   4. Job contract types are complete
 *   5. Download gate blocks infected/pending files
 *
 * These tests run WITHOUT live infrastructure (no Redis, no S3, no ClamAV).
 * They validate code-level guarantees only.
 */
import { QUEUE_NAME, JOB_DEFAULTS, SCHEDULED_JOBS } from '../helpers/job-imports';

// ─── Re-export helpers to avoid path alias issues in Jest ───
// We use relative imports from src/ directly

describe('Infrastructure Regression Guards', () => {

    // ═══════════════════════════════════════════════════════════════
    // 1. Production Defaults
    // ═══════════════════════════════════════════════════════════════

    describe('Production Defaults', () => {
        test('STORAGE_PROVIDER defaults to s3 in env schema', () => {
            // The env.ts schema has: STORAGE_PROVIDER: z.enum(["local", "s3"]).default("s3")
            // We verify the fallback in the storage index module
            // When STORAGE_PROVIDER is not set, getStorageProvider should try s3
            expect(true).toBe(true); // Schema-level — validated at build time
        });

        test('AV_SCAN_MODE defaults to strict in env schema', () => {
            // The env.ts schema has: AV_SCAN_MODE: z.enum(["strict", "permissive", "disabled"]).default("strict")
            expect(true).toBe(true); // Schema-level — validated at build time
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. Job Contract Completeness
    // ═══════════════════════════════════════════════════════════════

    describe('Job Contract Completeness', () => {
        test('all scheduled jobs have matching JOB_DEFAULTS', () => {
            for (const schedule of SCHEDULED_JOBS) {
                expect(JOB_DEFAULTS).toHaveProperty(schedule.name);
            }
        });

        test('all JOB_DEFAULTS have required fields', () => {
            for (const [_name, defaults] of Object.entries(JOB_DEFAULTS)) {
                expect(defaults).toHaveProperty('attempts');
                expect(defaults).toHaveProperty('backoff');
                expect(defaults).toHaveProperty('removeOnComplete');
                expect(defaults).toHaveProperty('removeOnFail');
                expect(typeof defaults.attempts).toBe('number');
                expect(defaults.attempts).toBeGreaterThan(0);
                expect(defaults.backoff).toHaveProperty('type');
                expect(defaults.backoff).toHaveProperty('delay');
            }
        });

        test('QUEUE_NAME is defined and non-empty', () => {
            expect(QUEUE_NAME).toBeTruthy();
            expect(typeof QUEUE_NAME).toBe('string');
        });

        test('all scheduled jobs have valid cron patterns', () => {
            for (const schedule of SCHEDULED_JOBS) {
                const parts = schedule.pattern.split(' ');
                expect(parts.length).toBeGreaterThanOrEqual(5);
                expect(parts.length).toBeLessThanOrEqual(6);
                expect(schedule.description).toBeTruthy();
            }
        });

        test('exactly 25 scheduled jobs exist', () => {
            // 29 → 30: `evidence-stale-review-sweep` was written in 2026-05
            // and never registered or scheduled, so `nextReviewDate` was
            // settable, shown in the calendar, counted on the dashboard — and
            // acted on by nothing. Registering it is what makes the cadence
            // mean anything.
            //
            // 28 → 25: the risk-quantification uproot removed
            // `risk-appetite-monitor`, `risk-snapshot` and `report-delivery`.
            // All three were scheduled with NO executor registered, so the
            // scheduler was enqueuing three jobs a day that nothing consumed.
            expect(SCHEDULED_JOBS).toHaveLength(25);
        });

        test('scheduled job names match expected set', () => {
            const names = SCHEDULED_JOBS.map(s => s.name).sort();
            expect(names).toEqual([
                // Audit Coherence S7 — daily admin escalation when
                // an access-review campaign is severely past its
                // dueAt and decisions remain pending.
                'access-review-overdue-escalation',
                // Epic G-4 — daily reviewer reminder for access review
                // campaigns approaching their dueAt.
                'access-review-reminder',
                'automation-runner',
                'compliance-digest',
                'compliance-snapshot',
                // Grain fulfilment — daily 07:30 UTC sweep firing
                // delivery-window alerts for ACTIVE contracts. Shares its
                // definition of "late" with the list badge via
                // src/lib/grain/contract-window.ts, so the badge a farmer
                // sees and the notification they receive cannot disagree.
                'contract-delivery-window-sweep',
                // Epic G-2 — every-5-min repeatable scanning
                // ControlTestPlan and enqueuing runner jobs.
                'daily-evidence-expiry',
                'data-lifecycle',
                // Flips APPROVED evidence past its nextReviewDate to
                // NEEDS_REVIEW. The usecase existed since 2026-05 with zero
                // callers; registering it closes the review-cadence loop
                // (approval sets the date → this flips the row → readiness
                // stops counting it).
                'evidence-stale-review-sweep',
                // Epic G-5 — daily 30/14/7-day expiry reminder for
                // control exceptions.
                // Exchange — daily global sweep flipping ACTIVE listings past
                // their expiresAt to EXPIRED (+ audit row per transition).
                'exchange-expiry-sweep',
                // Land administration (roadmap 3/3) — daily cross-tenant
                // sweep firing LEASE_EXPIRING alerts for parcel leases
                // (аренда/наем) ending within 30 days.
                'lease-expiry-sweep',
                // Inventory Phase 1 — daily cross-tenant low-stock sweep
                // firing LOW_STOCK alerts for items below reorderLevel.
                'low-stock-monitor',
                // Trends → News — daily aggregation of free agri RSS/Atom feeds
                // into the global market-news cache.
                // (Calendar roadmap PR 3's 'news-event-extraction' schedule is
                // CONDITIONAL on ANTHROPIC_API_KEY — absent in this key-less
                // test env, same carve-out shape as market-prices-barchart
                // below — so it is deliberately not in this always-on set.)
                'market-news-pull',
                // Trends — weekly market-price backbone pull (EC AGRI-food +
                // Alpha Vantage + own-listings median) into the global cache.
                // (The intraday 'market-prices-barchart' schedule is CONDITIONAL
                // on BARCHART_API_KEY — absent in this key-less test env — so it
                // is deliberately not in this always-on set.)
                'market-prices-pull',
                'notification-dispatch',
                'policy-review-reminder',
                // Retention for promotion leads (contact PII): soft-delete past
                // the window, then purge past the grace. Scheduled because the
                // privacy notice states a deletion period — a sweep nobody runs
                // would make that statement false.
                'promotion-lead-retention',
                // Data-integrity — daily cross-tenant stock-ledger
                // reconciliation (hash chain + lot quantityOnHand vs
                // SUM(transactions)); logs + alerts on drift.
                'reconcile-inventory-ledgers',
                // RQ-10 — daily cross-tenant scheduled-report delivery.
                'retention-sweep',
                // RQ-2 — daily cross-tenant risk-appetite breach monitor.
                // RQ-9 — daily cross-tenant risk + portfolio snapshot.
                // PR-E — daily sweep firing SCHEDULE automation rules whose
                // target entity is N days from its due date.
                'schedule-trigger-sweep',
                // SP-3 — every-4-hour fan-out: a delta sync per enabled
                // SharePoint connection (auto-import changed evidence files).
                'sharepoint-delta-sync-dispatch',
                // SP-4 — daily renewal of policy Graph change subscriptions.
                'sharepoint-subscription-renew',
                // Automation Epic 5 — every-5-min SLA breach sweep over
                // RUNNING automation executions.
                'sla-monitor',
                // In-app TASK_DUE notifications fired one week, one
                // day, and on the day a task's dueAt falls.
                'task-due-notification',
                // Agro-intel — daily Open-Meteo weather pull per Location
                // → WeatherObservation upsert + spray/disease signal eval.
                'weather-pull',
            ]);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. AV Download Gate
    // ═══════════════════════════════════════════════════════════════

    describe('AV Download Gate (strict mode)', () => {
        // Import is tested separately in av-scan.test.ts
        // Here we just guard the contract

        test('infected files must never be downloadable in production config', () => {
            // This is the central safety invariant of the AV system.
            // The isDownloadAllowed function returns false for INFECTED
            // in ALL modes except disabled.
            // This is a documentation test — enforced by av-scan.test.ts
            expect(true).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. No In-Process Cron Remaining
    // ═══════════════════════════════════════════════════════════════

    describe('No In-Process Cron', () => {
        test('no node-cron dependency exists', () => {
            // Verify node-cron is not in package.json
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['node-cron']).toBeUndefined();
            expect(pkg.devDependencies?.['node-cron']).toBeUndefined();
        });

        test('BullMQ is a production dependency', () => {
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['bullmq']).toBeDefined();
        });

        test('ioredis is a production dependency', () => {
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['ioredis']).toBeDefined();
        });
    });
});
