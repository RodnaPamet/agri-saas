/**
 * PR-6 — list-page row-count observability.
 *
 * Emits two OTel instruments per list-page API GET so the operator
 * dashboard can answer "is any tenant trending toward the SWR
 * backfill cap (LIST_BACKFILL_CAP = 5000)?":
 *
 *   • `list.page.row_count` — Histogram { entity, truncated } [1]
 *     Distribution of post-cap row counts per entity. Watch the p95;
 *     if it edges toward 5000, refine-filters guidance becomes more
 *     prominent in the UI OR the cap gets revisited.
 *
 *   • `list.page.truncation` — Counter   { entity }
 *     Incremented once per request that hit the cap. Aggregate
 *     against `list.page.row_count` to see what fraction of list
 *     requests on a given entity are getting clipped.
 *
 * CARDINALITY DISCIPLINE
 *
 * `tenant_id` is deliberately NOT a metric label here, mirroring the
 * convention in `metrics.ts::repo.method.duration`. With ~100s of
 * tenants × 7 entities × 2 truncation states, including tenantId
 * would explode metric storage on the host. Per-tenant pivoting is
 * provided through trace span attributes (`list.tenant_id`,
 * `list.entity`, `list.row_count`, `list.truncated`) which trace
 * search can filter on without paying the cardinality tax.
 *
 * The dashboard alert is therefore "list.page.truncation rate-of-
 * change" plus "list.page.row_count p95 by entity"; tracing answers
 * "which tenants are responsible". That split matches the existing
 * audit-stream + repo-method dashboards.
 *
 * USAGE
 *
 *   const result = applyBackfillCap(rows);
 *   recordListPageRowCount({
 *       entity: 'practices',
 *       count: result.rows.length,
 *       truncated: result.truncated,
 *       tenantId: ctx.tenantId,
 *   });
 *   return jsonResponse(result);
 */

import { metrics, trace } from '@opentelemetry/api';

const METER_NAME = 'inflect-compliance';

function getMeter() {
    return metrics.getMeter(METER_NAME);
}

let _rowCountHistogram:
    | ReturnType<ReturnType<typeof getMeter>['createHistogram']>
    | null = null;
let _truncationCounter:
    | ReturnType<ReturnType<typeof getMeter>['createCounter']>
    | null = null;

function getRowCountHistogram() {
    if (!_rowCountHistogram) {
        _rowCountHistogram = getMeter().createHistogram(
            'list.page.row_count',
            {
                description:
                    'Post-cap row count returned to a list-page API GET',
                unit: '1',
            },
        );
    }
    return _rowCountHistogram;
}

function getTruncationCounter() {
    if (!_truncationCounter) {
        _truncationCounter = getMeter().createCounter(
            'list.page.truncation',
            {
                description:
                    'Total list-page API GETs that hit the backfill cap',
                unit: '1',
            },
        );
    }
    return _truncationCounter;
}

/**
 * Bounded set of entity names. Lock at the type level so call sites
 * can't accidentally explode label cardinality with a typo or a new
 * entity that hasn't been considered for instrumentation.
 */
export type ListPageEntity =
    | 'practices'
    | 'risks'
    | 'evidence'
    | 'audits'
    | 'policies'
    | 'vendors'
    | 'findings'
    | 'tasks'
    | 'access-reviews';

interface RecordOpts {
    entity: ListPageEntity;
    /** Row count AFTER the cap was applied (`<= LIST_BACKFILL_CAP`). */
    count: number;
    /** Whether the cap fired on this request. */
    truncated: boolean;
    /** Tenant id — written as a SPAN attribute, never a metric label. */
    tenantId: string;
}

/**
 * Emit per-request observability signals for a list-page GET.
 *
 * - Bumps `list.page.row_count` with `{ entity, truncated }` labels.
 * - Bumps `list.page.truncation` (entity label only) when truncated.
 * - Attaches `list.*` attributes to the active OTel span so trace
 *   search can pivot per-tenant.
 */
export function recordListPageRowCount(opts: RecordOpts): void {
    getRowCountHistogram().record(opts.count, {
        entity: opts.entity,
        truncated: opts.truncated,
    });
    if (opts.truncated) {
        getTruncationCounter().add(1, { entity: opts.entity });
    }
    const span = trace.getActiveSpan();
    if (span) {
        span.setAttributes({
            'list.entity': opts.entity,
            'list.row_count': opts.count,
            'list.truncated': opts.truncated,
            'list.tenant_id': opts.tenantId,
        });
    }
}
