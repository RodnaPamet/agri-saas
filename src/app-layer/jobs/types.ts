/**
 * Job Types — Typed Payload Contracts
 *
 * Every async job in the system is defined here with a unique name,
 * a serialization-safe payload interface, and default queue options.
 *
 * Rules:
 *   1. Job names are string literals (no enums — easier to grep/trace)
 *   2. Payloads MUST be JSON-serializable (no Date objects, no functions, no classes)
 *   3. Each job name maps to exactly one payload type via JobPayloadMap
 *   4. Add new jobs by extending JobPayloadMap + registering a processor
 *
 * TENANT ISOLATION (CRITICAL):
 *   5. Every tenant-scoped payload MUST include `tenantId?: string`
 *   6. Executors MUST pass payload.tenantId to the service layer
 *   7. Services MUST apply tenantId to ALL Prisma where clauses
 *   8. NEVER use `_payload` (unused parameter) in executors — this silently
 *      drops tenantId and causes all-tenant scans
 *   9. Regression tests in `tests/unit/job-tenant-isolation-regression.test.ts`
 *      enforce these rules automatically
 *
 * @module app-layer/jobs/types
 */

// ─── Unified Job Run Result ───

/**
 * Universal result contract returned by every scheduled job executor.
 * Provides a consistent shape for observability, logging, and
 * downstream consumers (dashboards, audit logs, alerting).
 *
 * All fields are JSON-serializable.
 */
export interface JobRunResult {
    /** The job name that produced this result */
    jobName: string;
    /** Unique identifier for this particular execution */
    jobRunId: string;
    /** Whether the job completed without throwing */
    success: boolean;
    /** ISO timestamp of when execution started */
    startedAt: string;
    /** ISO timestamp of when execution finished */
    completedAt: string;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Number of items scanned/inspected during the run */
    itemsScanned: number;
    /** Number of items that triggered an action (e.g. notified, archived, purged) */
    itemsActioned: number;
    /** Number of items skipped (duplicate, already processed, etc.) */
    itemsSkipped: number;
    /** Optional error message if success=false */
    errorMessage?: string;
    /** Optional structured details (job-specific payload) */
    details?: Record<string, unknown>;
}

// ─── Normalized Due Item Output ───

/**
 * Entity types that can have due/expiring items.
 * Used for downstream notification grouping.
 */
export type MonitoredEntityType =
    | 'CONTROL'
    | 'EVIDENCE'
    | 'POLICY'
    | 'VENDOR'
    | 'TASK'
    | 'RISK'
    | 'TEST_PLAN'
    // Epic G-7 — treatment-plan target dates + milestone due dates
    // both flow through the deadline monitor so the digest pipeline
    // groups them by owner alongside other deadlines.
    | 'TREATMENT_PLAN'
    | 'TREATMENT_MILESTONE';

/**
 * Urgency classification for due items.
 *   OVERDUE  — already past its deadline
 *   URGENT   — within 7 days
 *   UPCOMING — within 30 days
 */
export type DueItemUrgency = 'OVERDUE' | 'URGENT' | 'UPCOMING';

/**
 * Normalized due/expiring item — the universal output of all monitors.
 *
 * Designed for downstream consumption:
 *   - Group by tenantId + ownerUserId → per-user digest
 *   - Group by entityType → summary dashboards
 *   - All fields are JSON-serializable
 */
export interface DueItem {
    /** Entity type being monitored */
    entityType: MonitoredEntityType;
    /** Database ID of the entity */
    entityId: string;
    /** Tenant that owns this entity */
    tenantId: string;
    /** Human-readable name/title */
    name: string;
    /** Specific reason this item is flagged */
    reason: string;
    /** Urgency classification */
    urgency: DueItemUrgency;
    /** The date that drives this due item (ISO string) */
    dueDate: string;
    /** Days remaining (negative = overdue) */
    daysRemaining: number;
    /** Owner user ID (for notification routing), if known */
    ownerUserId?: string;
}

// ─── Job Payload Definitions ───

/** Health check / smoke test job */
export interface HealthCheckPayload {
    /** ISO timestamp of when the job was enqueued */
    enqueuedAt: string;
    /** Optional message for testing */
    message?: string;
}

/** Automation runner — executes scheduled control checks */
export interface AutomationRunnerPayload {
    tenantId?: string;
    dryRun?: boolean;
}

/**
 * Evidence stale-review sweep — flips APPROVED rows whose `nextReviewDate`
 * has passed to NEEDS_REVIEW.
 *
 * The usecase was written in 2026-05 and never registered, so it had zero
 * callers: evidence aged past its review date while still reading APPROVED,
 * and readiness went on counting it as fresh. Registering it is what makes
 * `nextReviewDate` mean anything.
 */
export interface EvidenceStaleReviewSweepPayload {
    /** Scope to one tenant. Omit to sweep all. */
    tenantId?: string;
}

/** Daily evidence expiry — sweeps and notifies */
export interface DailyEvidenceExpiryPayload {
    tenantId?: string;
    skipOutbox?: boolean;
}

/** Data lifecycle — retention sweep and purge */
export interface DataLifecyclePayload {
    tenantId?: string;
    dryRun?: boolean;
}

/** Policy review reminder */
export interface AccessReviewReminderPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide nightly scan. */
    tenantId?: string;
}

export interface PolicyReviewReminderPayload {
    tenantId?: string;
}

/**
 * Audit Coherence S7 (2026-05-24) — access review overdue
 * escalation. Sister job to `access-review-reminder` — same payload
 * shape (tenant-scope opt-in), separate job because the fan-out
 * recipients are tenant admins, not the campaign reviewer.
 */
export interface AccessReviewOverdueEscalationPayload {
    tenantId?: string;
}

/** Task-due notification — in-app deadline reminders (7d / 1d / due day) */
export interface TaskDueNotificationPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide nightly scan. */
    tenantId?: string;
}

/** Evidence retention sweep */
export interface RetentionSweepPayload {
    tenantId?: string;
    dryRun?: boolean;
}

/**
 * Promotion-lead retention sweep. No tenantId: leads span every tenant and the
 * sweep decides purely from timestamps, so it runs globally in one pass.
 */
export interface PromotionLeadRetentionPayload {
    dryRun?: boolean;
}

/** Vendor renewal/review deadline monitor */
export interface VendorRenewalCheckPayload {
    tenantId?: string;
}

/** Deadline monitor — controls, policies, tasks, risks, test plans */
export interface DeadlineMonitorPayload {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/** Evidence expiry monitor — expiring/expired evidence detection */
export interface EvidenceExpiryMonitorPayload {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/** Notification dispatch — monitor → grouped digest → outbox pipeline */
export interface NotificationDispatchPayload {
    tenantId?: string;
    /** Which categories to dispatch. Default: all */
    categories?: ('DEADLINE_DIGEST' | 'EVIDENCE_EXPIRY_DIGEST' | 'VENDOR_RENEWAL_DIGEST')[];
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/** Daily compliance snapshot — KPI trend storage */
export interface ComplianceSnapshotPayload {
    tenantId?: string;
    /** Override snapshot date (ISO string). Default: today UTC */
    date?: string;
}

/** Automation Epic 5 — SLA breach sweep over RUNNING executions. */
export interface SlaMonitorPayload {
    /** Limit the sweep to one tenant (default: all). */
    tenantId?: string;
}

/** Automation Epic 7 — fire the next rule in a chain. */
export interface RuleChainDispatchPayload {
    tenantId: string;
    /** The next rule to run. */
    ruleId: string;
    /** The execution that triggered this chain step (lineage). */
    parentExecutionId: string;
    triggerEvent: string;
    data: Record<string, unknown>;
    /** Chain depth — a runtime cycle backstop (capped in the job). */
    depth: number;
}

/** VR-7 — sub-flow invocation: run a sub-flow group's entry rule, linked to
 * the invoking execution via parentExecutionId. */
export interface SubflowDispatchPayload {
    tenantId: string;
    /** The enclosing sub-flow group's ProcessNode.nodeKey (rules carry it as subFlowGroupId). */
    targetGroupId: string;
    /** The execution that invoked the sub-flow (lineage). */
    parentExecutionId: string;
    triggerEvent: string;
    data: Record<string, unknown>;
}

/** PR-E — global cron sweep that fires SCHEDULE rules whose target entity is
 * due. No payload (scans every tenant's enabled SCHEDULE rules). */
export type ScheduleTriggerSweepPayload = Record<string, never>;

/** Weekly compliance digest — executive summary email */
export interface ComplianceDigestPayload {
    tenantId?: string;
    /** Override recipient emails (default: tenant ADMIN/OWNER members) */
    recipientOverrides?: string[];
    /** Number of days to include in trend summary (default: 7) */
    trendDays?: number;
}

/**
 * Epic B.3 — Master-KEK rotation, per-tenant scope.
 *
 * Enqueued by the tenant admin API after an operator has staged
 * `DATA_ENCRYPTION_KEY_PREVIOUS` alongside the new
 * `DATA_ENCRYPTION_KEY`. The job:
 *   1. Re-wraps the tenant's `encryptedDek` under the primary KEK.
 *   2. Re-encrypts every v1 ciphertext belonging to this tenant
 *      under the primary KEK.
 *
 * Idempotent — the dual-KEK fallback transparently decrypts whatever
 * state the row is in, so a re-run after a crash continues from
 * wherever the last batch stopped.
 */
export interface KeyRotationPayload {
    tenantId: string;
    /** User who initiated — attribution on audit-log entries. */
    initiatedByUserId: string;
    /** Upstream request id for log correlation. */
    requestId?: string;
}

/**
 * Per-tenant DEK rotation re-encrypt sweep.
 *
 * Enqueued by `rotateTenantDek` after the atomic DEK swap. The job:
 *   1. Walks every (model, field) in the encrypted-fields manifest
 *      that has a `tenantId` column.
 *   2. For each row carrying a v2 ciphertext, decrypts under the
 *      previous DEK and re-encrypts under the new primary DEK.
 *   3. On completion, clears `Tenant.previousEncryptedDek` to NULL
 *      and invalidates the previous-DEK cache for that tenant.
 *
 * Idempotent — the dual-DEK fallback in the encryption middleware
 * means rows already rewritten under the new primary stay readable
 * if the job re-runs after a crash. The job's own decrypt path uses
 * the previous DEK directly (not the fallback) because rows that
 * primary-decrypt successfully are by definition NOT what we're
 * sweeping for.
 *
 * Mid-flight reads remain correct via the middleware's
 * `decryptWithKeyOrPrevious` fallback (the previous DEK stays
 * resolvable until the final UPDATE clears `previousEncryptedDek`).
 */
export interface TenantDekRotationPayload {
    tenantId: string;
    /** User who initiated — attribution on audit-log entries. */
    initiatedByUserId: string;
    /** Upstream request id for log correlation. */
    requestId?: string;
    /** Override SELECT batch size per (model, field). Default 500. */
    batchSize?: number;
}

/**
 * Automation event dispatch — one job per emitted domain event.
 *
 * The bus stamps `tenantId` and `emittedAt` on the event; the
 * dispatcher serializes the event through this payload to Redis.
 * Dates are ISO strings because BullMQ payloads are JSON-only.
 *
 * The worker (see `jobs/automation-event-dispatch.ts`):
 *   1. Loads enabled rules for `event.tenantId + event.event`.
 *   2. For each rule whose filter matches `event.data`, inserts a
 *      PENDING `AutomationExecution` row. The unique
 *      (tenantId, idempotencyKey) index is the dedupe lock — retries
 *      that compute the same key collide and the runner skips.
 *   3. Advances each claimed execution through RUNNING →
 *      SUCCEEDED / FAILED. Action handlers are out of scope for
 *      Epic 60 foundation; the outcome records what *would* have
 *      fired so the next epic can plug handlers in.
 */
export interface AutomationEventDispatchPayload {
    /** Required for tenant-safe rule lookup and RLS set_config. */
    tenantId: string;
    event: {
        event: string;
        tenantId: string;
        entityType: string;
        entityId: string;
        actorUserId: string | null;
        /** ISO string — bus Date serialized for Redis. */
        emittedAt: string;
        stableKey?: string;
        data: Record<string, unknown>;
    };
    /**
     * Epic 6 — manual re-trigger of a SINGLE rule. When set, only this rule
     * is considered (instead of every rule matching the event), and the
     * execution row records the given `triggeredBy` (default 'event').
     */
    targetRuleId?: string;
    triggeredBy?: string;
}

/**
 * Bulk-import evidence from a tenant-scoped staged ZIP archive.
 *
 * The HTTP layer stages the upload to storage (domain
 * `evidence-import-staging`) and enqueues this job; the worker
 * extracts, validates each entry against the safety bounds, and
 * funnels accepted entries through the canonical
 * `uploadEvidenceFile` usecase so business rules (MIME allowlist,
 * size cap, dedup, audit trail) stay identical to the single-file
 * upload path.
 *
 * Payload is JSON-serialisable per the JobPayloadMap rule — no Date
 * objects, no Buffers, no functions. The actual ZIP bytes live in
 * storage at `stagingPathKey`; the worker streams them back.
 */
export interface EvidenceImportPayload {
    /** Tenant whose evidence will be enriched. Required for isolation. */
    tenantId: string;
    /** User who uploaded the bundle — used for actor attribution + perm gate. */
    initiatedByUserId: string;
    /** Storage key of the staged ZIP (under `evidence-import-staging`). */
    stagingPathKey: string;
    /** Storage `FileRecord.id` of the staging upload, deleted on success. */
    stagingFileRecordId: string;
    /** Optional control to attach every extracted evidence to. */
    controlId?: string | null;
    /** Optional retention date applied to every extracted evidence. */
    retentionUntilIso?: string | null;
    /** Optional category tag applied to every extracted evidence. */
    category?: string | null;
    /** Optional log-correlation id from the upstream HTTP request. */
    requestId?: string;
}

/** Webhook-driven sync pull */
export interface SyncPullPayload {
    ctx: {
        tenantId: string;
        userId: string;
        requestId: string;
        role: string;
        permissions: {
            canRead: boolean;
            canWrite: boolean;
            canAdmin: boolean;
            canAudit: boolean;
            canExport: boolean;
        };
    };
    mappingKey: {
        tenantId: string;
        provider: string;
        connectionId?: string;
        localEntityType: string;
        localEntityId: string;
        remoteEntityType: string;
        remoteEntityId: string;
    };
    remoteData: Record<string, unknown>;
    remoteUpdatedAtIso: string;
}

// ─── Job Name → Payload Map ───

/**
 * Central registry of all job names and their corresponding payload types.
 * This is the single source of truth for job typing across the system.
 *
 * To add a new job:
 *   1. Define a payload interface above
 *   2. Add an entry to this map
 *   3. Register a processor in the worker
 */
/** SP-3 — delta sync for one SharePoint connection. */
export interface SharePointDeltaSyncPayload {
    tenantId: string;
    connectionId: string;
    /** Member to attribute the re-imports to (an admin of the tenant). */
    actorUserId: string;
    triggeredBy: 'scheduled' | 'manual';
    requestId?: string;
}

/** SP-3 — fan-out cron: enqueue a delta sync per enabled SharePoint connection. */
export interface SharePointDeltaSyncDispatchPayload {
    requestId?: string;
}

/** SP-4 — pull a changed policy from SharePoint (enqueued by the Graph webhook). */
export interface SharePointPolicyPullPayload {
    tenantId: string;
    policyId: string;
    requestId?: string;
}

/** SP-4 — daily cron: renew every active policy Graph subscription (cross-tenant). */
export interface SharePointSubscriptionRenewPayload {
    requestId?: string;
}

/** Inventory Phase 1 — daily cross-tenant low-stock sweep + LOW_STOCK alerts. */
export interface LowStockMonitorPayload {
    tenantId?: string;
}

/** Land admin — daily cross-tenant lease-expiry sweep + LEASE_EXPIRING alerts. */
export interface LeaseExpirySweepPayload {
    tenantId?: string;
    withinDays?: number;
}

/** Grain fulfilment — daily cross-tenant sweep of ACTIVE contracts whose
 *  delivery window is closing or lapsed + CONTRACT_DELIVERY_DUE alerts. */
export interface ContractDeliveryWindowSweepPayload {
    tenantId?: string;
    withinDays?: number;
}

/** Data-integrity — daily cross-tenant stock-ledger reconciliation (chain + balances). */
export interface ReconcileInventoryLedgersPayload {
    tenantId?: string;
}

/** AI — on-demand agronomy-copilot explanation for a fired AgroSignal. */
export interface AgronomyCopilotPayload {
    tenantId: string;
    locationId: string;
    kind: 'SPRAY_WINDOW' | 'DISEASE_RISK';
    signalDateIso: string;
}

/**
 * AI vision (feat/ai-vision) — async leaf/crop photo → likely pest/disease
 * + grounded recommendation. Enqueued from the LogEntry photo-upload path;
 * the worker reads the image bytes, runs the vision orchestrator
 * (on-device ONNX → Claude fallback), gates low confidence, grounds the
 * recommendation via the RAG knowledge base, and writes the advisory
 * result under `LogEntry.attributesJson.pestId`. Never mutates the entry.
 */
export interface ClassifyPhotoPayload {
    tenantId: string;
    logEntryId: string;
    fileId: string;
}

/**
 * Agro-intel — daily cross-tenant weather pull (Open-Meteo) + agro-signal
 * evaluation. Scoped to one tenant when `tenantId` is set, else every
 * tenant that owns a Location.
 */
export interface WeatherPullPayload {
    tenantId?: string;
}

/**
 * Market-price trends — weekly/daily pull of the three price sources into
 * the GLOBAL MarketPriceSeries/Point cache. `source` scopes the run to one
 * source ('ec' EC AGRI-food weekly, 'av' Alpha Vantage daily, 'listings'
 * k-anonymised own-listings median); omit to run all three.
 */
export interface MarketPricesPullPayload {
    source?: 'ec' | 'av' | 'barchart' | 'listings';
}

/**
 * Market-news trends — daily aggregation of free agricultural RSS/Atom feeds
 * into the GLOBAL MarketNewsItem cache (no tenantId, like MarketPriceSeries).
 * `feedSlug` scopes the run to one configured feed; omit to pull every feed.
 */
export interface MarketNewsPullPayload {
    feedSlug?: string;
}

/**
 * News-derived calendar events (calendar roadmap PR 3) — daily extraction
 * of subsidy/regulation dates from GLOBAL policy-category MarketNewsItem
 * headlines via Claude Haiku, written as PROPOSED `NewsDerivedEvent` rows.
 * `lookbackHours` overrides the default rolling window (see
 * `src/app-layer/jobs/news-event-extraction.ts` for why this is a window,
 * not a persisted cursor) — mainly for manual/backfill runs.
 */
export interface NewsEventExtractionPayload {
    lookbackHours?: number;
}

/**
 * WEEKLY extraction of government SUPPORT SCHEMES (ДФЗ / МЗХ / EC measures a
 * farm applies for) from the same policy-category news slice, written as
 * PROPOSED `SupportScheme` rows.
 *
 * Weekly rather than daily because an application window is announced weeks or
 * months ahead — the subject does not change between Tuesday and Wednesday,
 * and the daily news-event job already covers the date-points that do.
 * `lookbackHours` overrides the rolling window, mainly for backfill runs.
 */
export interface SupportSchemeExtractionPayload {
    lookbackHours?: number;
}

/**
 * Spatial-upload abuse hardening — off-thread parcel-boundary import.
 *
 * The HTTP layer stages the uploaded shapefile/KML/GeoJSON to storage
 * (domain `spatial`, after the per-format byte cap), records a
 * FileRecord, and enqueues this job. The worker streams the bytes back,
 * parses them under a 30s wall-clock budget OFF the request thread,
 * enforces the parcel-complexity caps, validates every geometry's
 * topology (`ST_IsValid`) pre-persist, and only then replaces the
 * location's parcels. A hostile 200 MB shapefile or a million-vertex
 * polygon can therefore never pin the Next.js runtime.
 *
 * Payload is JSON-serialisable (no Buffers) — the bytes live in storage
 * at `stagingPathKey`; the worker reads them back.
 */
export interface SpatialImportJobPayload {
    /** Tenant whose location is being imported into. Required for isolation. */
    tenantId: string;
    /** Member who uploaded — actor attribution + write-permission gate. */
    initiatedByUserId: string;
    /** Target Location to replace parcels on. */
    locationId: string;
    /** Storage key of the staged upload (under `spatial`). */
    stagingPathKey: string;
    /** FileRecord.id of the staged upload — stamped onto Location.spatialFileId. */
    stagingFileRecordId: string;
    /** Original filename — drives parser format detection + the audit message. */
    filename: string;
    /** Upload MIME type, when the browser supplied one. */
    mimeType?: string;
    /** Default crop stamped on every imported parcel (#7); omitted = "mixed". */
    cropType?: string;
    /** Upstream request id for log correlation. */
    requestId?: string;
}

/**
 * RAG (feat/ai-rag) — embed KnowledgeChunk rows that have a NULL
 * embedding. Scoped to one tenant when `tenantId` is set; the GLOBAL
 * catalog (tenantId NULL) is embedded by the ingestion script directly
 * (which runs under the superuser bypass). `batchSize` bounds both the
 * findMany `take` and the per-call embed batch.
 */
export interface EmbedChunksPayload {
    tenantId?: string;
    /** Max chunks to embed per run (bounded findMany take). Default 128. */
    batchSize?: number;
}

/**
 * KB agronomy structure PR — keep `KnowledgeChunk` in sync with a
 * `KnowledgeArticle`'s publish lifecycle. Enqueued by `publishArticle` /
 * `archiveArticle` / `unarchiveArticle` (never scheduled — purely
 * event-triggered, same shape as `classify-photo` / `soil-fetch`). The
 * executor re-reads the article's CURRENT state: PUBLISHED with content →
 * paragraph-chunk + replace; anything else → remove the article's chunks
 * (archive must make its SOP stop being retrievable). See
 * `jobs/reindex-knowledge-article.ts`.
 */
export interface ReindexKnowledgeArticlePayload {
    tenantId: string;
    articleId: string;
}

/**
 * БАБХ farm-record — regenerate a location's current-season ДНЕВНИК into its
 * Farm-records register when a field task auto-resolves. Enqueued
 * fire-and-forget (jobId `farm-record:<taskId>` for dedup); the worker
 * resolves the task's location, generates the diary (season start → now),
 * and persists it as a FileRecord (domain 'reports'). Fail-open — a failed
 * generation never affects task completion.
 */
export interface FarmRecordPdfPayload {
    tenantId: string;
    taskId: string;
}

/**
 * Exchange EXPIRED sweep — flip ACTIVE listings past their `expiresAt` to
 * EXPIRED. System-wide (Exchange tables are global, no tenant axis).
 */
export interface ExchangeExpirySweepPayload {
    /** Optional cap on rows flipped per run. */
    batchSize?: number;
}

/**
 * soil-fetch — populate modelled soil (SoilGrids) for a batch of parcels.
 * Enqueued on parcel import / create / geometry edit; runs on the dedicated
 * soil queue with a 5/min Worker limiter (SoilGrids fair-use).
 */
export interface SoilFetchPayload {
    tenantId: string;
    /** The user whose membership authorises the tenant-scoped writes. */
    initiatedByUserId: string;
    /** Parcels to (re)fetch soil for. */
    parcelIds: string[];
    requestId?: string;
}

/**
 * КАИС cadastre OpenData import (feat/cadastre-opendata-import).
 *
 * Enqueued by `stageLocationCadastreImport` from a list of cadastral
 * identifiers (ЕКАТТЕ.масив.номер). The worker groups by ЕКАТТЕ, fetches each
 * settlement's land-parcels archive from КАИС OpenData (cache-first via the
 * global `CadastreArchive` row), parses the shapefile ZIP, selects the features
 * whose identifier matches a requested id, strips owner-ish attributes, and
 * appends them to the location via `ParcelRepository.addParcelsForLocation`
 * (КС2005 metres → PostGIS reprojection via Part A's probe). Not-found
 * identifiers are reported in the job result.
 *
 * Payload is JSON-serialisable — the archive bytes live in storage, never here.
 */
export interface CadastreImportJobPayload {
    /** Tenant whose location is imported into. Required for isolation. */
    tenantId: string;
    /** Member who requested the import — actor attribution + write gate. */
    initiatedByUserId: string;
    /** Target Location to append parcels to. */
    locationId: string;
    /** Cadastral identifiers to import (validated, normalized). */
    identifiers: string[];
    /** Upstream request id for log correlation. */
    requestId?: string;
}

export interface JobPayloadMap {
    'health-check': HealthCheckPayload;
    'embed-chunks': EmbedChunksPayload;
    'reindex-knowledge-article': ReindexKnowledgeArticlePayload;
    'automation-runner': AutomationRunnerPayload;
    'daily-evidence-expiry': DailyEvidenceExpiryPayload;
    'data-lifecycle': DataLifecyclePayload;
    'policy-review-reminder': PolicyReviewReminderPayload;
    'retention-sweep': RetentionSweepPayload;
    'promotion-lead-retention': PromotionLeadRetentionPayload;
    'vendor-renewal-check': VendorRenewalCheckPayload;
    'deadline-monitor': DeadlineMonitorPayload;
    'evidence-expiry-monitor': EvidenceExpiryMonitorPayload;
    'evidence-stale-review-sweep': EvidenceStaleReviewSweepPayload;
    'notification-dispatch': NotificationDispatchPayload;
    'sync-pull': SyncPullPayload;
    'compliance-snapshot': ComplianceSnapshotPayload;
    'sla-monitor': SlaMonitorPayload;
    'rule-chain-dispatch': RuleChainDispatchPayload;
    'subflow-dispatch': SubflowDispatchPayload;
    'schedule-trigger-sweep': ScheduleTriggerSweepPayload;
    'compliance-digest': ComplianceDigestPayload;
    'automation-event-dispatch': AutomationEventDispatchPayload;
    'key-rotation': KeyRotationPayload;
    'tenant-dek-rotation': TenantDekRotationPayload;
    'evidence-import': EvidenceImportPayload;
    'access-review-reminder': AccessReviewReminderPayload;
    'access-review-overdue-escalation': AccessReviewOverdueEscalationPayload;
    'task-due-notification': TaskDueNotificationPayload;
    'sharepoint-delta-sync': SharePointDeltaSyncPayload;
    'sharepoint-delta-sync-dispatch': SharePointDeltaSyncDispatchPayload;
    'sharepoint-policy-pull': SharePointPolicyPullPayload;
    'sharepoint-subscription-renew': SharePointSubscriptionRenewPayload;
    'low-stock-monitor': LowStockMonitorPayload;
    'lease-expiry-sweep': LeaseExpirySweepPayload;
    'contract-delivery-window-sweep': ContractDeliveryWindowSweepPayload;
    'reconcile-inventory-ledgers': ReconcileInventoryLedgersPayload;
    'agronomy-copilot': AgronomyCopilotPayload;
    'classify-photo': ClassifyPhotoPayload;
    'weather-pull': WeatherPullPayload;
    'spatial-import': SpatialImportJobPayload;
    'cadastre-import': CadastreImportJobPayload;
    'farm-record-pdf': FarmRecordPdfPayload;
    'exchange-expiry-sweep': ExchangeExpirySweepPayload;
    'soil-fetch': SoilFetchPayload;
    'market-prices-pull': MarketPricesPullPayload;
    // Intraday Barchart-only pull (delayed MATIF futures). Same payload shape;
    // the executor forces source='barchart'. Scheduled every ~20 min on
    // weekdays ONLY when BARCHART_API_KEY is set (see schedules.ts).
    'market-prices-barchart': MarketPricesPullPayload;
    'market-news-pull': MarketNewsPullPayload;
    // Calendar roadmap PR 3 — daily AI extraction of subsidy/regulation
    // dates from the global policy-news cache. Scheduled ONLY when
    // ANTHROPIC_API_KEY is set (see schedules.ts).
    'news-event-extraction': NewsEventExtractionPayload;
    'support-scheme-extraction': SupportSchemeExtractionPayload;
}

/** Union of all valid job names */
export type JobName = keyof JobPayloadMap;

/** Extract the payload type for a given job name */
export type JobPayload<T extends JobName> = JobPayloadMap[T];

// ─── Default Queue Options ───

/** Default retry/backoff settings per job */
export const JOB_DEFAULTS: Record<JobName, {
    attempts: number;
    backoff: { type: 'exponential' | 'fixed'; delay: number };
    removeOnComplete: number | boolean;
    removeOnFail: number | boolean;
}> = {
    'health-check': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'embed-chunks': {
        // Embedding is idempotent (only NULL-embedding rows are picked
        // up; a re-run re-embeds whatever's still NULL). One retry on a
        // transient AI/DB blip; the next run catches any remainder.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'reindex-knowledge-article': {
        // Idempotent (delete-then-insert / delete-only), so a retry on a
        // transient DB blip is safe. Re-publishing (or re-archiving) the
        // same article re-enqueues anyway, so a lost job is self-healing
        // on the next lifecycle transition — modest retry budget.
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'automation-runner': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'sla-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'rule-chain-dispatch': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'subflow-dispatch': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'schedule-trigger-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'daily-evidence-expiry': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'data-lifecycle': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'policy-review-reminder': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'access-review-reminder': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'access-review-overdue-escalation': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'task-due-notification': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-delta-sync': {
        // One retry on a transient Graph/storage blip; delta tokens make a
        // re-run idempotent (already-imported eTags are skipped).
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-delta-sync-dispatch': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'sharepoint-policy-pull': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-subscription-renew': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'low-stock-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'lease-expiry-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'contract-delivery-window-sweep': {
        // Notification sweep; one retry on a transient DB blip.
        // Idempotent — the dedupeKey means a re-run sends nothing twice.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'reconcile-inventory-ledgers': {
        // Read-only integrity sweep; one retry on a transient DB blip.
        // Fully idempotent (re-running re-verifies, never mutates).
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'agronomy-copilot': {
        // On-demand AI enrichment; one retry. Idempotent — re-running
        // re-generates and overwrites detailsJson.copilot; the
        // notification dedupeKey prevents a double-notify.
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'classify-photo': {
        // Async vision classification; one retry. Idempotent — overwrites
        // attributesJson.pestId on a re-run. A transient inference / RAG /
        // DB blip retries once; beyond that the photo + entry stand
        // untouched (the suggestion is advisory, never load-bearing).
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'weather-pull': {
        // Daily Open-Meteo pull + signal eval. One retry on a transient
        // network/DB blip; the WeatherObservation upsert + AgroSignal
        // unique-claim make a re-run fully idempotent.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'market-prices-pull': {
        // Weekly/daily market-price pull. One retry on a transient network/DB
        // blip; the Series/Point upserts are keyed on their natural unique
        // constraints so a re-run is fully idempotent.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'market-prices-barchart': {
        // Intraday Barchart pull (every ~20 min). One quick retry on a blip;
        // upserts are idempotent on (seriesId, date) so a same-day re-run just
        // refreshes today's point. Keep history light — it fires often.
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: 20,
        removeOnFail: 50,
    },
    'market-news-pull': {
        // Daily agri-news aggregation. One retry on a transient network/DB blip;
        // items upsert on their natural `guidHash` unique key so a re-run is
        // fully idempotent.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'news-event-extraction': {
        // Daily AI extraction over the policy-news slice. One retry on a
        // transient network/DB/Anthropic blip; writes claim via
        // createMany({ skipDuplicates }) on the (sourceNewsItemId, kind)
        // unique key, so a re-run is fully idempotent.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'support-scheme-extraction': {
        // WEEKLY AI extraction over the same policy-news slice. Same retry
        // posture: writes claim via createMany({ skipDuplicates }) on the
        // (sourceNewsItemId, measureCode) unique key, so a re-run is fully
        // idempotent. JOB_DEFAULTS is exhaustive over JobName — omitting this
        // entry does not "default", it fails to compile, which is exactly the
        // trap calendar-deadlines fell into and left unreachable dead code.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'retention-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    // Same shape as retention-sweep: idempotent, so a retry is safe — expiry
    // only touches rows still live and purge only rows already past the grace.
    'promotion-lead-retention': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'vendor-renewal-check': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'deadline-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'evidence-expiry-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'evidence-stale-review-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'notification-dispatch': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sync-pull': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100, // Important for dedupe: allow same id after completion
        removeOnFail: 500,
    },
    'compliance-snapshot': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'compliance-digest': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'automation-event-dispatch': {
        // Fire-and-forget per event: a failed dispatch tries a couple
        // of times (transient DB/Redis blips) before landing on the
        // dead-letter list. Aggressive removeOnComplete keeps the
        // queue from filling up under event-heavy tenants.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
    },
    'key-rotation': {
        // Do NOT auto-retry: a partial rotation needs operator review.
        // The job is idempotent, so the operator can re-enqueue after
        // investigating; we'd rather they see "this one failed" in the
        // completed-with-errors state than have the queue silently
        // retry and potentially compound the problem.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'tenant-dek-rotation': {
        // Same posture as key-rotation: a partial sweep means
        // `Tenant.previousEncryptedDek` is still populated and reads
        // continue working via the dual-DEK fallback. The operator
        // re-enqueues manually after investigating any failure;
        // silent auto-retry could compound a partial-progress bug.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'evidence-import': {
        // No auto-retry: an import that hits a safety-bound (zip-bomb,
        // path-traversal, oversize) is a hard reject — auto-retrying
        // would just hammer the same archive against the same checks.
        // Transient failures (storage flakes) leave the staged ZIP
        // intact for the operator to re-enqueue manually after
        // investigating.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 1000,
    },
    'spatial-import': {
        // No auto-retry: a parse failure, a complexity-cap breach, a
        // self-intersecting polygon, or a blown 30s parse budget is a
        // HARD reject — re-running would just burn the same CPU on the
        // same hostile file. A transient storage flake leaves the staged
        // upload intact for the operator to re-trigger manually. Keep
        // the failed job around (removeOnFail) so the GET status route
        // can surface `failedReason` to the upload modal.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 1000,
    },
    'cadastre-import': {
        // No auto-retry: a walk-budget breach, a not-found ЕКАТТЕ, or a bad
        // shapefile is a hard reject — re-running would re-walk the whole КАИС
        // tree. A transient network flake leaves the request for the operator
        // to re-trigger. Keep the failed job (removeOnFail) so the GET status
        // route can surface failedReason to the import modal. Cache reuse
        // (CadastreArchive) makes a manual re-trigger cheap regardless.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 1000,
    },
    'farm-record-pdf': {
        // Regenerating the register diary is idempotent (a fresh FileRecord),
        // so retry a transient storage/render flake a couple of times. The
        // job never throws into the completion path regardless.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'exchange-expiry-sweep': {
        // Idempotent — the atomic prior-state predicate means a re-run only
        // flips rows still ACTIVE-past-expiry. One retry on a transient DB blip;
        // the daily cadence catches any remainder.
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'soil-fetch': {
        // Idempotent per parcel (cache-first; a re-run just refreshes from
        // cache). Retry a provider rate-limit / outage a few times with a
        // long backoff — the SoilGrids beta REST API is throttled, so give it
        // room before giving up and leaving the parcel "soil pending".
        attempts: 5,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
};

/** The single queue name used for all jobs (BullMQ supports named jobs within a queue) */
export const QUEUE_NAME = 'inflect-jobs';

/**
 * Dedicated queue for the soil-fetch job. Separate from the main queue so
 * its Worker can carry an independent `limiter` (5/min) matching the
 * SoilGrids beta REST fair-use budget without throttling every other job.
 */
export const SOIL_QUEUE_NAME = 'inflect-soil';

/** Job names that run on the dedicated soil queue (rate-limited Worker). */
export const SOIL_QUEUE_JOBS: ReadonlySet<JobName> = new Set(['soil-fetch']);
