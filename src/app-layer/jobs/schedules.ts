/**
 * Job Schedules — BullMQ Repeatable Job Definitions
 *
 * Defines the cron patterns and repeatable options for every scheduled job.
 * These are registered once by `scripts/scheduler.ts` and then BullMQ
 * automatically enqueues jobs at the specified cadence.
 *
 * Schedule semantics (preserved from legacy cron docs/comments):
 *   - automation-runner:       every 15 min (control check scheduling)
 *   - daily-evidence-expiry:   daily at 06:00 UTC (sweep + outbox)
 *   - data-lifecycle:          daily at 03:00 UTC (purge + retention)
 *   - policy-review-reminder:  daily at 08:00 UTC (overdue review audit)
 *   - task-due-notification:   daily at 08:00 local (NOTIFICATIONS_TZ) (in-app task deadline reminders)
 *   - retention-sweep:         daily at 04:00 UTC (evidence archival)
 *   - evidence-stale-review-sweep: daily at 04:30 UTC (APPROVED → NEEDS_REVIEW)
 *   - notification-dispatch:   daily at 07:00 UTC (single-pass: monitors + digest dispatch)
 *
 * IMPORTANT: deadline-monitor, evidence-expiry-monitor, and vendor-renewal-check
 * are NOT scheduled independently. They run as part of notification-dispatch
 * to prevent duplicate database scans. They remain registered in the executor
 * registry for ad-hoc/CLI/API use.
 *
 * Times are UTC unless the entry sets a `tz`. BullMQ uses standard
 * cron syntax and evaluates the `pattern` in `tz` when supplied.
 *
 * @module app-layer/jobs/schedules
 */
import type { JobName } from './types';
import { env } from '@/env';

export interface ScheduleDefinition {
    /** Job name — must match a key in JobPayloadMap */
    name: JobName;
    /** Cron pattern — evaluated in `tz` if set, otherwise UTC */
    pattern: string;
    /**
     * IANA timezone the cron `pattern` is evaluated in (DST-aware).
     * Omit for UTC. Passed straight into the BullMQ repeat options.
     */
    tz?: string;
    /** Human-readable description */
    description: string;
    /** Default payload for the repeatable job */
    defaultPayload: Record<string, unknown>;
    /** BullMQ repeat options */
    options?: {
        /** Timezone (default: UTC) */
        tz?: string;
        /** Max runs (undefined = forever) */
        limit?: number;
    };
}

/**
 * All scheduled jobs in the system.
 * Used by `scripts/scheduler.ts` to register repeatable jobs.
 */
export const SCHEDULED_JOBS: ScheduleDefinition[] = [
    {
        name: 'automation-runner',
        pattern: '*/15 * * * *',  // every 15 minutes
        description: 'Execute scheduled automation/integration checks for controls',
        defaultPayload: {},
    },
    {
        name: 'promotion-lead-retention',
        pattern: '30 3 * * *',    // daily at 03:30 UTC
        description:
            'Soft-delete promotion leads past the retention window, then purge those past the grace period',
        defaultPayload: {},
    },
    {
        name: 'sla-monitor',
        pattern: '*/5 * * * *',   // every 5 minutes
        description: 'Detect automation executions that breached their rule SLA window and fire the breach action',
        defaultPayload: {},
    },
    {
        name: 'sharepoint-delta-sync-dispatch',
        pattern: '0 */4 * * *',   // every 4 hours
        description: 'Fan out a SharePoint delta sync per enabled connection (auto-import changed evidence files)',
        defaultPayload: {},
    },
    {
        name: 'sharepoint-subscription-renew',
        pattern: '0 2 * * *',     // daily at 02:00 UTC
        description: 'Renew active SharePoint policy Graph change-notification subscriptions before they expire',
        defaultPayload: {},
    },
    {
        name: 'low-stock-monitor',
        pattern: '0 9 * * *',     // daily at 09:00 UTC
        description: 'Scan inventory items below reorderLevel and fire LOW_STOCK notifications to tenant OWNER/ADMIN members',
        defaultPayload: {},
    },
    {
        name: 'lease-expiry-sweep',
        pattern: '0 7 * * *',     // daily at 07:00 UTC
        description: 'Scan parcel leases (аренда/наем) ending within 30 days and fire LEASE_EXPIRING notifications to tenant OWNER/ADMIN members',
        defaultPayload: {},
    },
    {
        name: 'contract-delivery-window-sweep',
        pattern: '30 7 * * *',    // daily at 07:30 UTC
        description: 'Scan ACTIVE grain contracts whose delivery window closes within 14 days or has lapsed, and fire CONTRACT_DELIVERY_DUE notifications (carrying the outstanding tonnage) to tenant OWNER/ADMIN members',
        defaultPayload: {},
    },
    {
        name: 'reconcile-inventory-ledgers',
        pattern: '0 4 * * *',     // daily at 04:00 UTC
        description: 'Reconcile every tenant\'s stock ledger: hash-chain integrity + lot quantityOnHand vs SUM(transactions); log + alert on drift',
        defaultPayload: {},
    },
    {
        name: 'weather-pull',
        pattern: '0 6 * * *',     // daily at 06:00 UTC
        description: 'Pull daily weather (Open-Meteo) for every farm location, then evaluate spray-window + disease-risk agro-signals',
        defaultPayload: {},
    },
    {
        name: 'schedule-trigger-sweep',
        pattern: '0 7 * * *',     // daily at 07:00 UTC
        description: 'Fire SCHEDULE automation rules whose target entity is N days from its due date',
        defaultPayload: {},
    },
    {
        // One weekly all-sources run (schedule names must be unique — see
        // bullmq-scheduler.test.ts). Weekly suffices for every source: EC
        // cereal/oilseed prices publish weekly, the own-listings median is a
        // weekly index, and Alpha Vantage commodities are MONTHLY-granularity
        // (so 2 AV requests/week sits trivially inside the 25 req/day budget).
        // Manual/targeted single-source runs use the `source` payload field.
        name: 'market-prices-pull',
        pattern: '30 5 * * 1',     // weekly Monday at 05:30 UTC
        description: 'Pull market prices (EC AGRI-food + Alpha Vantage + own-listings median) into the global market-price cache',
        defaultPayload: {},
    },
    // Intraday Barchart pull for near-real-time (10-15 min delayed) MATIF
    // futures — registered ONLY when BARCHART_API_KEY is set, so no empty
    // cron runs on deployments without the (licensed) feed. Every 20 min,
    // 08:00-17:59 UTC, Mon-Fri (≈ Euronext Paris grain hours + delay). A
    // getQuote batches all symbols in one request → ~150 requests/week; check
    // this against the Barchart plan's request budget before enabling.
    ...(env.BARCHART_API_KEY
        ? [
              {
                  name: 'market-prices-barchart' as JobName,
                  pattern: '*/20 8-17 * * 1-5',
                  description: 'Intraday pull of delayed Euronext MATIF futures (Barchart) into the global market-price cache',
                  defaultPayload: {},
              },
          ]
        : []),
    {
        // Daily — agri news refreshes far more often than weekly prices. 05:50
        // UTC sits just after the weekly price pull, before European morning
        // traffic. The guidHash upsert makes a re-run idempotent; the job also
        // prunes items older than 60 days each run.
        name: 'market-news-pull',
        pattern: '50 5 * * *',     // daily at 05:50 UTC
        description: 'Aggregate free agri RSS/Atom feeds into the global market-news cache (Trends → News tab)',
        defaultPayload: {},
    },
    // Calendar roadmap PR 3 — daily AI extraction of subsidy/regulation
    // dates from the policy-category slice of the news cache above,
    // registered ONLY when ANTHROPIC_API_KEY is set, so a key-less
    // deployment never schedules an empty cron (mirrors the
    // market-prices-barchart / BARCHART_API_KEY carve-out above — and is
    // why 'news-event-extraction' is absent from the "exactly N scheduled
    // jobs" / "scheduled job names" assertions in
    // tests/regression/infrastructure-guards.test.ts, whose test env is
    // key-less). 06:15 UTC — 25 minutes after market-news-pull, so the
    // policy items it just aggregated are already in the cache.
    ...(env.ANTHROPIC_API_KEY
        ? [
              {
                  name: 'news-event-extraction' as JobName,
                  pattern: '15 6 * * *',     // daily at 06:15 UTC
                  description: 'Extract subsidy/regulation calendar-event proposals from policy news via Claude Haiku (proposed, never auto-published)',
                  defaultPayload: {},
              },
              {
                  // WEEKLY sibling: government SUPPORT SCHEMES (ДФЗ / МЗХ / EC
                  // measures a farm applies for) from the same policy slice.
                  // Weekly because an application window is announced weeks or
                  // months ahead — the daily job already covers the date-points
                  // that move. Monday 06:30 UTC, after both market-news-pull
                  // (05:50) and the daily extraction (06:15), so it reads a
                  // cache that is already current.
                  //
                  // Key-gated with its sibling: a key-less deployment must
                  // never schedule a cron that can only no-op.
                  name: 'support-scheme-extraction' as JobName,
                  pattern: '30 6 * * 1',    // weekly, Monday 06:30 UTC
                  description: 'Extract government support-scheme proposals (ДФЗ/МЗХ/EC) from policy news via Claude Haiku (proposed, never auto-published)',
                  defaultPayload: {},
              },
          ]
        : []),
    {
        name: 'daily-evidence-expiry',
        pattern: '0 6 * * *',     // daily at 06:00 UTC
        description: 'Sweep expiring evidence at 30/7/1 day thresholds + flush outbox',
        defaultPayload: {},
    },
    {
        name: 'data-lifecycle',
        pattern: '0 3 * * *',     // daily at 03:00 UTC
        description: 'Purge soft-deleted records, expired evidence, and run retention sweep',
        defaultPayload: { dryRun: false },
    },
    {
        name: 'policy-review-reminder',
        pattern: '0 8 * * *',     // daily at 08:00 UTC
        description: 'Find overdue policies and emit audit events / notifications',
        defaultPayload: {},
    },
    {
        name: 'task-due-notification',
        // Daily at 08:00 in the configured local zone (NOTIFICATIONS_TZ,
        // default Europe/London) — the start of the working day, and
        // the same zone the windows are classified in so a task due
        // near local midnight is bucketed by the local calendar day.
        // Creates one in-app TASK_DUE notification per task at each of
        // three reminder windows: one week before, one day before, and
        // on the day the task's `dueAt` falls. Idempotent by local-tz
        // day — re-running is safe (dedupeKey unique index absorbs
        // repeats).
        pattern: '0 8 * * *',
        tz: env.NOTIFICATIONS_TZ,
        description:
            'Create in-app TASK_DUE notifications for tasks one week before, one day before, and on their due date.',
        defaultPayload: {},
    },
    {
        name: 'access-review-reminder',
        // Daily at 04:00 UTC — chosen so reminders land at the start
        // of the European workday and a few hours before
        // policy-review-reminder so the dedupe outbox isn't competing
        // for the per-tenant rate-limit token bucket. Idempotent
        // by-day, so re-running this is safe.
        pattern: '0 4 * * *',
        description:
            'Nudge access-review reviewers when their campaign deadline is approaching and decisions are still pending.',
        defaultPayload: {},
    },
    {
        name: 'access-review-overdue-escalation',
        // Daily at 04:15 UTC — sits between G-4's 04:00 reviewer
        // reminder and the 04:30 exception monitor. Each campaign
        // already got its reviewer-targeted nudge fifteen minutes
        // earlier; this job adds the admin-fan-out for the subset
        // that's past the grace tail. Idempotent by-day via the
        // outbox dedupe key. (Audit Coherence S7, 2026-05-24)
        pattern: '15 4 * * *',
        description:
            'Escalate severely overdue access-review campaigns to tenant ADMIN/OWNERs so they can reassign, force-close, or chase.',
        defaultPayload: {},
    },
    {
        name: 'retention-sweep',
        pattern: '0 4 * * *',     // daily at 04:00 UTC
        description: 'Archive evidence with elapsed retention periods',
        defaultPayload: {},
    },
    {
        name: 'evidence-stale-review-sweep',
        // 04:30 UTC — after retention-sweep (04:00) so an archived row is
        // already out of scope, and before notification-dispatch (07:00) so
        // the same day's digest reports the rows this sweep just flipped.
        pattern: '30 4 * * *',
        description: 'Flip APPROVED evidence past its nextReviewDate to NEEDS_REVIEW',
        defaultPayload: {},
    },
    {
        name: 'notification-dispatch',
        pattern: '0 7 * * *',     // daily at 07:00 UTC (single-pass: runs monitors internally)
        description: 'Single-pass pipeline: run all monitors → group by owner → dispatch digest notifications. Replaces separate monitor+dispatch schedule to prevent duplicate DB scans.',
        defaultPayload: {},
    },
    {
        name: 'exchange-expiry-sweep',
        pattern: '0 5 * * *',     // daily at 05:00 UTC
        description:
            'Flip ACTIVE Exchange listings past their `expiresAt` to EXPIRED (+ one audit row per transition).',
        defaultPayload: {},
    },
    {
        name: 'compliance-snapshot',
        pattern: '0 5 * * *',     // daily at 05:00 UTC (before dashboard traffic)
        description: 'Generate daily ComplianceSnapshot for trend reporting. Idempotent — safe to re-run.',
        defaultPayload: {},
    },
    {
        name: 'compliance-digest',
        pattern: '0 8 * * 1',     // weekly Monday at 08:00 UTC
        description: 'Send weekly compliance digest email to tenant admins. Reuses snapshot data — no live aggregation.',
        defaultPayload: {},
    },
];

