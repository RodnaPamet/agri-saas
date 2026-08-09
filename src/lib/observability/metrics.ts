/**
 * Observability Metrics — OpenTelemetry counters, histograms, and gauges.
 *
 * ── REQUEST METRICS ──
 *   api.request.count      — Counter   (method, route, status)
 *   api.request.duration   — Histogram (method, route, status) [ms]
 *   api.request.errors     — Counter   (method, route, errorCode)
 *
 * ── REPOSITORY METRICS (Epic OI-3) ──
 *   repo.method.duration     — Histogram (repo.method, outcome) [ms]
 *   repo.method.calls        — Counter   (repo.method, outcome)
 *   repo.method.errors       — Counter   (repo.method, error.type)
 *   repo.method.result_count — Histogram (repo.method)
 *
 *   tenant_id is intentionally NOT a metric label (would explode
 *   cardinality on multi-tenant deployments). It IS recorded as a
 *   span attribute (`repo.tenant_id`) so trace search can still
 *   pivot per-tenant.
 *
 * ── JOB METRICS ──
 *   job.execution.count    — Counter   (job_name, status: success|failure)
 *   job.execution.duration — Histogram (job_name, status) [ms]
 *   job.queue.depth        — Observable Gauge (queue_name, state)
 *
 * ── AUDIT-STREAM METRICS ──
 *   audit_stream.delivery.success  — Counter   (http.status_code)
 *   audit_stream.delivery.failures — Counter   (http.status_code)
 *   audit_stream.delivery.attempts — Histogram (outcome)
 *   audit_stream.delivery.duration — Histogram (outcome) [ms]
 *   audit_stream.buffer.overflow_dropped — Counter
 *   audit_stream.buffer.depth      — Observable Gauge
 *     One delivery-outcome record per batch (after the retry loop).
 *     success + failures give the delivery success ratio; attempts
 *     shows retry pressure; buffer.depth + overflow_dropped show
 *     downstream backpressure. Status 0 == network throw / timeout.
 *     Audit-stream failures deliberately do NOT gate /api/readyz —
 *     the path is out-of-band + fail-safe (the audit row is already
 *     committed); escalation is alert-based on these metrics.
 *
 * ── AUTH VERIFICATION-EMAIL METRICS ──
 *   auth.verification_email.sent   — Counter (outcome)
 *   auth.verification_email.failed — Counter (outcome)
 *     `issueEmailVerification` swallows SMTP errors so the register
 *     API stays 200 (enumeration safety: same response shape
 *     regardless of whether the address is registered). That
 *     swallow is invisible to the user — the operator only sees
 *     pino warns. These metrics surface the failure rate before a
 *     user-facing outage: if `AUTH_REQUIRE_EMAIL_VERIFICATION=1`
 *     is flipped on in a prod where the mailer is unreliable, a
 *     non-zero `.failed` rate gates verification end-to-end.
 *     `outcome` label is `register | resend` so the dashboard can
 *     pivot per-flow.
 *
 * ── ENTRA ID GROUP-RESOLUTION METRICS (EI-4) ──
 *   auth.entra.group_resolution    — Counter   (source, outcome)
 *   auth.entra.group_count         — Histogram (source)
 *   auth.entra.graph_fetch.duration— Histogram (outcome) [ms]
 *     One record per `microsoft-entra-id` sign-in (from
 *     `resolveEntraGroupClaims`). `source=token` vs `graph_overage`
 *     splits the in-token claim from the > ~200-group Graph fallback;
 *     `source=graph_overage, outcome=empty` is the Graph-outage alert
 *     signal (the Graph helper fails open to `[]`). graph_fetch.duration
 *     is recorded only on the overage path.
 *
 * ── SCIM AUTH METRICS (EI-4) ──
 *   scim.auth.count                — Counter   (outcome, reason)
 *     One record per `authenticateScimRequest` call. `reason` is a
 *     bounded 5-value enum (ok / missing_header / empty_token /
 *     not_found / revoked). A `not_found` spike is the brute-force /
 *     stale-connector signal; `revoked` rising means an IdP is still
 *     pushing with a rotated token.
 *
 * ── ENTRA ROLE-SYNC METRICS (EI-3) ──
 *   auth.entra.role_sync           — Counter   (outcome)
 *     One record per entra-id sign-in that reaches `syncEntraMembershipRole`.
 *     `outcome` ∈ synced / unchanged / gate_denied / no_membership /
 *     owner_immune / no_match / no_mappings. A `gate_denied` spike means a
 *     tenant's `enforceGroupGate` is locking users out (often a misconfigured
 *     mapping).
 *
 * CARDINALITY SAFETY:
 *   Route labels are normalized via `normalizeRoute()` to collapse dynamic
 *   segments (UUIDs, slugs) into placeholder tokens. This prevents
 *   unbounded label growth from entity-specific URLs.
 *
 * LAZY INITIALIZATION:
 *   All instruments are created on first access to give the global
 *   MeterProvider time to register. When OTel is not initialized,
 *   the noop meter produces zero-overhead noop instruments.
 *
 * These are recorded from:
 *   - `withApiErrorHandling` (request metrics)
 *   - `runJob` / `executorRegistry.execute` (job metrics)
 *   - `startQueueDepthReporting` (queue depth gauge)
 */

import { metrics } from '@opentelemetry/api';

const METER_NAME = 'inflect-compliance';

function getMeter() {
    return metrics.getMeter(METER_NAME);
}

// ════════════════════════════════════════════════════════════════════════
// ROUTE NORMALIZATION — Cardinality Safety
// ════════════════════════════════════════════════════════════════════════

/**
 * UUID v4 pattern — matches standard 36-char UUIDs.
 * Used to collapse entity IDs in URL paths.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * CUID / nanoid / opaque-id pattern — matches 20+ char alphanumeric segments.
 * Guards against non-UUID ID formats that would still cause cardinality explosion.
 */
const OPAQUE_ID_RE = /\/[a-z0-9]{20,}\b/gi;

/**
 * Normalize a raw request pathname to a route template safe for metric labels.
 *
 * Collapses:
 *   - UUIDs → :id
 *   - Tenant slugs in /t/[slug]/ → :tenantSlug
 *   - Long opaque IDs → :id
 *
 * Examples:
 *   /api/t/acme-corp/practices/550e8400-e29b-41d4-a716-446655440000
 *     → /api/t/:tenantSlug/practices/:id
 *
 *   /api/t/my-tenant/evidence/abc123def456
 *     → /api/t/:tenantSlug/evidence/abc123def456  (short IDs kept — low cardinality)
 *
 * @param pathname — raw URL pathname from req.nextUrl.pathname
 * @returns normalized route string, safe for OTel labels
 */
export function normalizeRoute(pathname: string): string {
    let route = pathname;

    // 1. Replace UUIDs with :id
    route = route.replace(UUID_RE, ':id');

    // 2. Replace tenant slug in /t/<slug>/ or /api/t/<slug>/
    //    Next.js dynamic segment: /t/[tenantSlug]/...
    route = route.replace(/\/t\/([^/]+)\//, '/t/:tenantSlug/');

    // 3. Replace remaining long opaque IDs
    route = route.replace(OPAQUE_ID_RE, '/:id');

    return route;
}

// ════════════════════════════════════════════════════════════════════════
// REQUEST METRICS — Instrument Singletons
// ════════════════════════════════════════════════════════════════════════

let _requestCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _requestDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _requestErrors: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

// Repository instruments — Epic OI-3.
// Cardinality safety: labels are { 'repo.method', 'outcome' } only.
// tenant_id, user_id are SPAN attributes (queryable in trace search)
// but NOT metric labels (where they'd explode cardinality).
let _repoDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _repoCalls: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _repoErrors: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _repoResultCount: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getRequestCount() {
    if (!_requestCount) {
        _requestCount = getMeter().createCounter('api.request.count', {
            description: 'Total number of API requests',
            unit: '1',
        });
    }
    return _requestCount;
}

function getRequestDuration() {
    if (!_requestDuration) {
        _requestDuration = getMeter().createHistogram('api.request.duration', {
            description: 'API request duration in milliseconds',
            unit: 'ms',
        });
    }
    return _requestDuration;
}

function getRequestErrors() {
    if (!_requestErrors) {
        _requestErrors = getMeter().createCounter('api.request.errors', {
            description: 'Total number of API request errors',
            unit: '1',
        });
    }
    return _requestErrors;
}

/**
 * Record a completed API request.
 *
 * Route is auto-normalized to prevent label cardinality explosion.
 * Called from `withApiErrorHandling` on every request completion.
 */
export function recordRequestMetrics(attrs: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
}): void {
    const normalizedRoute = normalizeRoute(attrs.route);

    const labels = {
        'http.method': attrs.method,
        'http.route': normalizedRoute,
        'http.status_code': attrs.status,
    };

    getRequestCount().add(1, labels);
    getRequestDuration().record(attrs.durationMs, labels);
}

/**
 * Record an API request error.
 *
 * Route is auto-normalized.
 */
export function recordRequestError(attrs: {
    method: string;
    route: string;
    errorCode: string;
}): void {
    getRequestErrors().add(1, {
        'http.method': attrs.method,
        'http.route': normalizeRoute(attrs.route),
        'error.code': attrs.errorCode,
    });
}

// ════════════════════════════════════════════════════════════════════════
// REPOSITORY METRICS — Epic OI-3
//
// Emitted by src/lib/observability/repository-tracing.ts::traceRepository.
// Labels are restricted to { 'repo.method', 'outcome' } to keep
// cardinality bounded. Use trace span attributes (tenant.id, user.id)
// for tenant-aware debugging — those don't explode metric storage.
// ════════════════════════════════════════════════════════════════════════

export function getRepositoryDurationHistogram() {
    if (!_repoDuration) {
        _repoDuration = getMeter().createHistogram('repo.method.duration', {
            description: 'Repository method execution duration in milliseconds',
            unit: 'ms',
        });
    }
    return _repoDuration;
}

export function getRepositoryCallCounter() {
    if (!_repoCalls) {
        _repoCalls = getMeter().createCounter('repo.method.calls', {
            description: 'Total number of repository method invocations',
            unit: '1',
        });
    }
    return _repoCalls;
}

export function getRepositoryErrorCounter() {
    if (!_repoErrors) {
        _repoErrors = getMeter().createCounter('repo.method.errors', {
            description: 'Total number of repository method errors',
            unit: '1',
        });
    }
    return _repoErrors;
}

export function getRepositoryResultCountHistogram() {
    if (!_repoResultCount) {
        _repoResultCount = getMeter().createHistogram('repo.method.result_count', {
            description: 'Distribution of result counts returned by repository methods',
            unit: '1',
        });
    }
    return _repoResultCount;
}

// ════════════════════════════════════════════════════════════════════════
// JOB METRICS — Instrument Singletons
// ════════════════════════════════════════════════════════════════════════

let _jobCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _jobDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getJobCount() {
    if (!_jobCount) {
        _jobCount = getMeter().createCounter('job.execution.count', {
            description: 'Total number of job executions',
            unit: '1',
        });
    }
    return _jobCount;
}

function getJobDuration() {
    if (!_jobDuration) {
        _jobDuration = getMeter().createHistogram('job.execution.duration', {
            description: 'Job execution duration in milliseconds',
            unit: 'ms',
        });
    }
    return _jobDuration;
}

/**
 * Record a completed job execution.
 *
 * @param attrs.jobName — the job name (bounded set from JobPayloadMap)
 * @param attrs.success — whether the job completed without error
 * @param attrs.durationMs — execution time in milliseconds
 */
export function recordJobMetrics(attrs: {
    jobName: string;
    success: boolean;
    durationMs: number;
}): void {
    const labels = {
        'job.name': attrs.jobName,
        'job.status': attrs.success ? 'success' : 'failure',
    };

    getJobCount().add(1, labels);
    getJobDuration().record(attrs.durationMs, labels);
}

// ════════════════════════════════════════════════════════════════════════
// AG FIELD-WORKFLOW METRICS — duration histogram for usecase SLOs
// ════════════════════════════════════════════════════════════════════════
//
// OTel span durations are NOT exported as metrics (spans → traces only), so
// an SLO like "ag.field-operation p95 < 1s" needs an explicit histogram.
// `traceAgUsecase` records this alongside the span. Labels are a bounded set
// (the operation name + success/failure) — never ids — so cardinality stays
// flat. Prometheus name: `ag_operation_duration_milliseconds_bucket`,
// labels `ag_operation` + `ag_outcome`.

let _agOpCount: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _agOpDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getAgOpCount() {
    if (!_agOpCount) {
        _agOpCount = getMeter().createCounter('ag.operation.count', {
            description: 'Total number of critical ag field-workflow operations',
            unit: '1',
        });
    }
    return _agOpCount;
}

function getAgOpDuration() {
    if (!_agOpDuration) {
        _agOpDuration = getMeter().createHistogram('ag.operation.duration', {
            description: 'Critical ag field-workflow operation duration in milliseconds',
            unit: 'ms',
        });
    }
    return _agOpDuration;
}

/**
 * Record a completed critical ag field-workflow operation.
 *
 * @param attrs.operation — dotted operation name (bounded; e.g.
 *   `field-operation.markOperationParcel`) — NOT an id.
 * @param attrs.success — whether the operation completed without throwing.
 * @param attrs.durationMs — wall-clock duration in milliseconds.
 */
export function recordAgOperationMetrics(attrs: {
    operation: string;
    success: boolean;
    durationMs: number;
}): void {
    const labels = {
        'ag.operation': attrs.operation,
        'ag.outcome': attrs.success ? 'success' : 'failure',
    };
    getAgOpCount().add(1, labels);
    getAgOpDuration().record(attrs.durationMs, labels);
}

// ════════════════════════════════════════════════════════════════════════
// AUDIT-STREAM METRICS — Instrument Singletons
//
// Delivery outcomes are recorded once per batch, after the retry loop in
// `deliverBatch` (src/app-layer/events/audit-stream.ts) settles. The set
// answers the operator questions:
//   - are batches landing?            success / failures counters
//   - what is the success ratio?      success / (success + failures)
//   - is the downstream flaky?        attempts histogram (1..3)
//   - how slow is delivery?           duration histogram [ms]
//   - is the buffer under pressure?   buffer.depth gauge + overflow counter
//
// Cardinality: only `http.status_code` (finite) and `outcome`
// (success|failure). tenantId is NEVER a label — tenant-level
// debugging uses the structured `logger.warn` in the same code path.
// ════════════════════════════════════════════════════════════════════════

let _auditStreamSuccess: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _auditStreamFailures: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _auditStreamAttempts: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _auditStreamDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _auditStreamOverflow: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getAuditStreamSuccess() {
    if (!_auditStreamSuccess) {
        _auditStreamSuccess = getMeter().createCounter('audit_stream.delivery.success', {
            description: 'Audit-stream batches delivered successfully (2xx on the final attempt)',
            unit: '1',
        });
    }
    return _auditStreamSuccess;
}

function getAuditStreamFailures() {
    if (!_auditStreamFailures) {
        _auditStreamFailures = getMeter().createCounter('audit_stream.delivery.failures', {
            description: 'Audit-stream batches whose final delivery attempt was not-ok (after retry)',
            unit: '1',
        });
    }
    return _auditStreamFailures;
}

function getAuditStreamAttempts() {
    if (!_auditStreamAttempts) {
        _auditStreamAttempts = getMeter().createHistogram('audit_stream.delivery.attempts', {
            description: 'Delivery attempts made per audit-stream batch (1 = no retry, up to 3)',
            unit: '1',
        });
    }
    return _auditStreamAttempts;
}

function getAuditStreamDuration() {
    if (!_auditStreamDuration) {
        _auditStreamDuration = getMeter().createHistogram('audit_stream.delivery.duration', {
            description: 'Wall-clock time to deliver an audit-stream batch, including retry backoff',
            unit: 'ms',
        });
    }
    return _auditStreamDuration;
}

function getAuditStreamOverflow() {
    if (!_auditStreamOverflow) {
        _auditStreamOverflow = getMeter().createCounter('audit_stream.buffer.overflow_dropped', {
            description: 'Audit-stream events dropped because a per-tenant buffer hit its hard cap',
            unit: '1',
        });
    }
    return _auditStreamOverflow;
}

/**
 * Record the outcome of an audit-stream batch delivery — called once
 * per batch by `deliverBatch` after the retry loop settles (NOT per
 * retry attempt).
 *
 * Emits, in one call:
 *   - `audit_stream.delivery.success` OR `.failures` (by outcome);
 *   - `audit_stream.delivery.attempts` (retry-pressure histogram);
 *   - `audit_stream.delivery.duration` (delivery latency).
 *
 * `status` is the final HTTP status (0 == network throw / timeout).
 * TenantId is deliberately NOT a label — tenant-level debugging
 * uses the structured `logger.warn` in the same code path.
 */
export function recordAuditStreamDelivery(attrs: {
    outcome: 'success' | 'failure';
    status: number;
    attempts: number;
    durationMs: number;
}): void {
    const statusLabel = { 'http.status_code': attrs.status };
    if (attrs.outcome === 'success') {
        getAuditStreamSuccess().add(1, statusLabel);
    } else {
        getAuditStreamFailures().add(1, statusLabel);
    }
    const outcomeLabel = { outcome: attrs.outcome };
    getAuditStreamAttempts().record(attrs.attempts, outcomeLabel);
    getAuditStreamDuration().record(attrs.durationMs, outcomeLabel);
}

/**
 * Record an audit-stream buffer overflow — one event dropped because
 * a per-tenant in-memory buffer hit `BUFFER_HARD_CAP`. A non-zero
 * rate here means the downstream SIEM is too slow to keep up with
 * audit volume and events are being shed.
 */
export function recordAuditStreamBufferOverflow(): void {
    getAuditStreamOverflow().add(1);
}

// ── Auth verification-email delivery counters ─────────────────────────

let _verificationEmailSent: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _verificationEmailFailed: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getVerificationEmailSent() {
    if (!_verificationEmailSent) {
        _verificationEmailSent = getMeter().createCounter('auth.verification_email.sent', {
            description: 'Verification emails successfully handed off to the mailer',
            unit: '1',
        });
    }
    return _verificationEmailSent;
}

function getVerificationEmailFailed() {
    if (!_verificationEmailFailed) {
        _verificationEmailFailed = getMeter().createCounter('auth.verification_email.failed', {
            description: 'Verification emails that the mailer rejected (operator-only signal — the register API still returns 200)',
            unit: '1',
        });
    }
    return _verificationEmailFailed;
}

/**
 * Record the outcome of a single verification-email send attempt.
 * Called from `issueEmailVerification` after the `sendEmail` try/catch
 * settles.
 *
 * `flow` labels the call-site:
 *   - `register` — first email at signup
 *   - `resend`   — `/api/auth/verify-email/resend` re-issue
 *
 * No email or userId on the label (PII + cardinality). Per-tenant
 * debugging uses the structured pino warn line in the same code path.
 *
 * Failures here are best-effort signal — the token is already stored
 * and the API returns 200 regardless. Operators alert on
 * `auth.verification_email.failed` (rate or absolute) to catch a
 * mailer outage BEFORE `AUTH_REQUIRE_EMAIL_VERIFICATION=1` locks
 * legitimate signups out of verification.
 */
export function recordVerificationEmailDelivery(attrs: {
    outcome: 'sent' | 'failed';
    flow: 'register' | 'resend';
}): void {
    const labels = { flow: attrs.flow };
    if (attrs.outcome === 'sent') {
        getVerificationEmailSent().add(1, labels);
    } else {
        getVerificationEmailFailed().add(1, labels);
    }
}

// ── Entra ID group-resolution metrics (EI-4) ──────────────────────────

let _entraGroupResolution: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
let _entraGroupCount: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;
let _entraGraphFetchDuration: ReturnType<ReturnType<typeof getMeter>['createHistogram']> | null = null;

function getEntraGroupResolution() {
    if (!_entraGroupResolution) {
        _entraGroupResolution = getMeter().createCounter('auth.entra.group_resolution', {
            description: 'Entra ID sign-ins by how the AAD group list was resolved',
            unit: '1',
        });
    }
    return _entraGroupResolution;
}

function getEntraGroupCount() {
    if (!_entraGroupCount) {
        _entraGroupCount = getMeter().createHistogram('auth.entra.group_count', {
            description: 'Number of AAD security groups resolved for a user at sign-in',
            unit: '1',
        });
    }
    return _entraGroupCount;
}

function getEntraGraphFetchDuration() {
    if (!_entraGraphFetchDuration) {
        _entraGraphFetchDuration = getMeter().createHistogram('auth.entra.graph_fetch.duration', {
            description: 'Latency of the Graph /me/memberOf overage fetch in milliseconds',
            unit: 'ms',
        });
    }
    return _entraGraphFetchDuration;
}

/**
 * Record one Entra ID group-claim resolution at sign-in — called once per
 * `microsoft-entra-id` sign-in by `resolveEntraGroupClaims`.
 *
 * `source`:
 *   - `token`         — the `groups` claim was present in the ID token (the
 *                       common case, ≤ ~200 groups).
 *   - `graph_overage` — the user is in > ~200 groups, so Entra omitted the
 *                       claim and we fetched the full list from Graph.
 * `outcome`:
 *   - `resolved`      — at least one group came back.
 *   - `empty`         — zero groups. On `token` that's a user genuinely in no
 *                       groups; on `graph_overage` it almost always means the
 *                       Graph call failed (the helper fails open to `[]`), so
 *                       `source=graph_overage, outcome=empty` is the operator's
 *                       alert signal for a Graph outage degrading group-driven
 *                       role assignment.
 *
 * No tenantId / userId label — group resolution is per-user but the metric is
 * a fleet-health signal; per-user debugging uses the structured log line in
 * the same code path.
 */
export function recordEntraGroupResolution(attrs: {
    source: 'token' | 'graph_overage';
    outcome: 'resolved' | 'empty';
    groupCount: number;
    graphFetchDurationMs?: number;
}): void {
    getEntraGroupResolution().add(1, { source: attrs.source, outcome: attrs.outcome });
    getEntraGroupCount().record(attrs.groupCount, { source: attrs.source });
    if (attrs.source === 'graph_overage' && attrs.graphFetchDurationMs !== undefined) {
        getEntraGraphFetchDuration().record(attrs.graphFetchDurationMs, {
            outcome: attrs.outcome,
        });
    }
}

// ── SCIM token-auth metrics (EI-4) ────────────────────────────────────

let _scimAuth: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getScimAuth() {
    if (!_scimAuth) {
        _scimAuth = getMeter().createCounter('scim.auth.count', {
            description: 'SCIM bearer-token authentication attempts by outcome',
            unit: '1',
        });
    }
    return _scimAuth;
}

/**
 * Record one SCIM bearer-token authentication attempt — called from
 * `authenticateScimRequest` at every terminal branch.
 *
 * `reason` is a bounded enum (5 values) so cardinality stays flat:
 *   - `ok`             — authenticated.
 *   - `missing_header` — no / malformed `Authorization: Bearer` header.
 *   - `empty_token`    — `Bearer` with an empty value.
 *   - `not_found`      — token hash matched no row.
 *   - `revoked`        — token row exists but is revoked.
 *
 * A spike in `not_found` is the brute-force / stale-connector signal;
 * `revoked` rising means an IdP is still pushing with a rotated token.
 * No tenantId label (the failing cases have no resolved tenant anyway).
 */
export function recordScimAuth(attrs: {
    outcome: 'success' | 'failure';
    reason: 'ok' | 'missing_header' | 'empty_token' | 'not_found' | 'revoked';
}): void {
    getScimAuth().add(1, { outcome: attrs.outcome, reason: attrs.reason });
}

// ── Entra group → role sync metrics (EI-3) ────────────────────────────

let _entraRoleSync: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;

function getEntraRoleSync() {
    if (!_entraRoleSync) {
        _entraRoleSync = getMeter().createCounter('auth.entra.role_sync', {
            description: 'Entra group → IC-role sync decisions at sign-in, by outcome',
            unit: '1',
        });
    }
    return _entraRoleSync;
}

/**
 * Record one Entra group → role sync decision — called once per
 * `microsoft-entra-id` sign-in that reaches `syncEntraMembershipRole`.
 *
 * `outcome`:
 *   - `synced`        — the member's role was changed to the mapped role.
 *   - `unchanged`     — a mapping matched but the role already matched.
 *   - `gate_denied`   — `enforceGroupGate` on + no mapped group → access denied.
 *   - `no_membership` — a role mapped but the user has no ACTIVE membership to
 *                       sync (membership creation stays on the Epic 1 paths).
 *   - `owner_immune`  — the member is an OWNER; sync + gate are skipped so a
 *                       misconfigured mapping can never demote / lock out an owner.
 *   - `no_match`      — mappings exist but none matched the user's groups (gate off).
 *   - `no_mappings`   — the tenant has no group mappings configured.
 *
 * A `gate_denied` spike means a tenant's gate is denying logins (often a
 * misconfigured mapping). No tenantId/userId label — fleet-health signal;
 * per-tenant detail lives in the audit row written on `synced`.
 */
export function recordEntraRoleSync(attrs: {
    outcome:
        | 'synced'
        | 'unchanged'
        | 'gate_denied'
        | 'no_membership'
        | 'owner_immune'
        | 'no_match'
        | 'no_mappings';
}): void {
    getEntraRoleSync().add(1, { outcome: attrs.outcome });
}

let _auditStreamBufferGaugeStarted = false;

/**
 * Register the observable gauge `audit_stream.buffer.depth` — the
 * total number of audit events buffered across all per-tenant
 * buffers, read at metric-scrape time. A sustained high depth means
 * delivery is not keeping up with ingestion.
 *
 * Idempotent. Called once from `audit-stream.ts` on module init.
 *
 * @param getDepthFn — returns the current total buffered event count.
 */
export function startAuditStreamBufferReporting(getDepthFn: () => number): void {
    if (_auditStreamBufferGaugeStarted) return;
    _auditStreamBufferGaugeStarted = true;

    const gauge = getMeter().createObservableGauge('audit_stream.buffer.depth', {
        description: 'Total audit events buffered across all per-tenant audit-stream buffers',
        unit: '1',
    });
    gauge.addCallback((result) => {
        try {
            result.observe(getDepthFn());
        } catch {
            // Buffer not available — noop; the gauge simply won't report.
        }
    });
}

/** Reset the buffer-gauge flag (testing only). @internal */
export function _resetAuditStreamBufferGaugeForTesting(): void {
    _auditStreamBufferGaugeStarted = false;
}

// ════════════════════════════════════════════════════════════════════════
// QUEUE DEPTH GAUGE — Observable (push-based)
// ════════════════════════════════════════════════════════════════════════

let _queueDepthStarted = false;

/**
 * Start periodic queue depth reporting.
 *
 * Uses OTel's ObservableGauge which is read by the metric reader
 * at export time. This avoids polling overhead — the gauge callback
 * is only invoked when the collector scrapes.
 *
 * Reports counts for: waiting, active, delayed, failed states.
 *
 * Call this once from the worker/scheduler entrypoint (not from
 * every request). Safe to call multiple times — only initializes once.
 *
 * @param getQueueFn — function that returns the BullMQ Queue instance
 */
export function startQueueDepthReporting(
    getQueueFn: () => { getJobCounts: () => Promise<Record<string, number>> },
): void {
    if (_queueDepthStarted) return;
    _queueDepthStarted = true;

    const gauge = getMeter().createObservableGauge('job.queue.depth', {
        description: 'Number of jobs in the queue by state',
        unit: '1',
    });

    gauge.addCallback(async (result) => {
        try {
            const counts = await getQueueFn().getJobCounts();

            // Only report meaningful states — avoid high-cardinality from
            // BullMQ's internal states like 'unknown' or 'paused'.
            const reportableStates = ['waiting', 'active', 'delayed', 'failed'];

            for (const state of reportableStates) {
                if (counts[state] !== undefined) {
                    result.observe(counts[state], {
                        'queue.name': 'inflect-jobs',
                        'queue.state': state,
                    });
                }
            }
        } catch {
            // Queue may not be available — noop. Gauge simply won't report.
        }
    });
}

/**
 * Reset queue depth reporting flag (for testing only).
 * @internal
 */
export function _resetQueueDepthForTesting(): void {
    _queueDepthStarted = false;
}
