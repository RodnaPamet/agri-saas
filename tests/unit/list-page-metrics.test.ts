/**
 * PR-6 — list-page row-count observability.
 *
 * Pins the contract of `recordListPageRowCount`:
 *
 *   - Always records the row count on the `list.page.row_count`
 *     histogram with `{ entity, truncated }` labels (no tenantId
 *     label — cardinality discipline mirrors `metrics.ts`).
 *   - Bumps the `list.page.truncation` counter only when truncated.
 *   - Attaches `list.*` attributes to the active span (when one
 *     exists) so trace search can pivot per-tenant.
 *
 * The helper is the only public surface in `list-page-metrics.ts` —
 * the OTel API mocks in this file mirror what every list-page API
 * GET will exercise on every read.
 */

import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const histogramRecord = jest.fn();
const counterAdd = jest.fn();
const spanSetAttributes = jest.fn();
let activeSpan: { setAttributes: typeof spanSetAttributes } | undefined;

jest.mock('@opentelemetry/api', () => {
    const noopHistogram = { record: (...args: unknown[]) => histogramRecord(...args) };
    const noopCounter = { add: (...args: unknown[]) => counterAdd(...args) };
    return {
        metrics: {
            getMeter: () => ({
                createHistogram: () => noopHistogram,
                createCounter: () => noopCounter,
            }),
        },
        trace: {
            getActiveSpan: () => activeSpan,
        },
    };
});

describe('recordListPageRowCount', () => {
    beforeEach(() => {
        histogramRecord.mockClear();
        counterAdd.mockClear();
        spanSetAttributes.mockClear();
        activeSpan = undefined;
    });

    test('records the row count with entity + truncated labels', () => {
        recordListPageRowCount({
            entity: 'practices',
            count: 47,
            truncated: false,
            tenantId: 't-1',
        });
        expect(histogramRecord).toHaveBeenCalledWith(47, {
            entity: 'practices',
            truncated: false,
        });
    });

    test('does NOT bump the truncation counter when truncated=false', () => {
        recordListPageRowCount({
            entity: 'risks',
            count: 100,
            truncated: false,
            tenantId: 't-1',
        });
        expect(counterAdd).not.toHaveBeenCalled();
    });

    test('bumps the truncation counter when truncated=true (entity label only)', () => {
        recordListPageRowCount({
            entity: 'evidence',
            count: 5000,
            truncated: true,
            tenantId: 't-1',
        });
        expect(counterAdd).toHaveBeenCalledWith(1, { entity: 'evidence' });
    });

    test('cardinality discipline — tenantId is NEVER a metric label', () => {
        recordListPageRowCount({
            entity: 'vendors',
            count: 10,
            truncated: true,
            tenantId: 'big-tenant-name-that-would-explode-cardinality',
        });
        // Probe both call surfaces. Neither should carry tenant_id.
        for (const call of histogramRecord.mock.calls) {
            const labels = call[1] as Record<string, unknown>;
            expect(labels).not.toHaveProperty('tenant_id');
            expect(labels).not.toHaveProperty('tenantId');
        }
        for (const call of counterAdd.mock.calls) {
            const labels = call[1] as Record<string, unknown>;
            expect(labels).not.toHaveProperty('tenant_id');
            expect(labels).not.toHaveProperty('tenantId');
        }
    });

    test('attaches list.* attributes (incl. tenant_id) to the active span', () => {
        activeSpan = { setAttributes: spanSetAttributes };
        recordListPageRowCount({
            entity: 'policies',
            count: 200,
            truncated: false,
            tenantId: 't-42',
        });
        expect(spanSetAttributes).toHaveBeenCalledWith({
            'list.entity': 'policies',
            'list.row_count': 200,
            'list.truncated': false,
            'list.tenant_id': 't-42',
        });
    });

    test('no-op on span side when there is no active span', () => {
        activeSpan = undefined;
        // Should not throw.
        recordListPageRowCount({
            entity: 'audits',
            count: 5,
            truncated: false,
            tenantId: 't-1',
        });
        expect(spanSetAttributes).not.toHaveBeenCalled();
    });
});
