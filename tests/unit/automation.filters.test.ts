/**
 * Unit Test: triggerFilterJson evaluation.
 *
 * `matchesFilter` is the single gate between "rule subscribed to this
 * event" and "this specific payload instance fires it". The contract
 * here is deliberately strict — richer matching should land as a
 * versioned DSL, not as a looser implementation of this function.
 */

import { matchesFilter } from '@/app-layer/automation/filters';
import type { AutomationDomainEvent } from '@/app-layer/automation/event-contracts';

/**
 * The filter DSL is deliberately schema-agnostic: `matchesFilter`
 * casts `event.data` to `Record<string, unknown>` and walks whatever
 * keys a persisted rule names. That is the behaviour under test, so
 * the fixture carries a synthetic three-key bag rather than any one
 * event's real payload — the `AutomationDomainEvent` union constrains
 * EMIT sites, not what a stored filter may probe.
 *
 * (This built a RISK_CREATED event until the risk register was
 * removed; every assertion below is unchanged.)
 */
function probeEvent(
    data: { title: string; score: number; category: string | null }
): AutomationDomainEvent {
    return {
        event: 'ISSUE_CREATED',
        tenantId: 't',
        entityType: 'Issue',
        entityId: 'i-1',
        actorUserId: null,
        emittedAt: new Date(),
        data,
    } as unknown as AutomationDomainEvent;
}

describe('matchesFilter', () => {
    it('null filter matches any event', () => {
        const evt = probeEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, null)).toBe(true);
        expect(matchesFilter(evt, undefined)).toBe(true);
    });

    it('empty filter matches any event', () => {
        const evt = probeEvent({ title: 't', score: 10, category: null });
        expect(matchesFilter(evt, {})).toBe(true);
    });

    it('single-key equality match', () => {
        const evt = probeEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { category: 'SEC' })).toBe(true);
        expect(matchesFilter(evt, { category: 'COMP' })).toBe(false);
    });

    it('multi-key match is AND', () => {
        const evt = probeEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { category: 'SEC', score: 10 })).toBe(true);
        expect(matchesFilter(evt, { category: 'SEC', score: 9 })).toBe(false);
    });

    it('unknown filter key fails closed', () => {
        const evt = probeEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { nope: 'x' })).toBe(false);
    });

    it('only looks at event.data, not metadata', () => {
        const evt = probeEvent({ title: 't', score: 10, category: 'SEC' });
        // tenantId is metadata, not filter-addressable
        expect(matchesFilter(evt, { tenantId: 't' })).toBe(false);
    });

    it('boolean + number equality', () => {
        const evt: AutomationDomainEvent = {
            event: 'TEST_RUN_COMPLETED',
            tenantId: 't',
            entityType: 'ControlTestRun',
            entityId: 'r-1',
            actorUserId: null,
            emittedAt: new Date(),
            data: { testPlanId: 'p', result: 'PASS' },
        };
        expect(matchesFilter(evt, { result: 'PASS' })).toBe(true);
        expect(matchesFilter(evt, { result: 'FAIL' })).toBe(false);
    });
});

// ─── DSL v2 (Epic 4) — FilterGroup ─────────────────────────────────────
describe('matchesFilter — FilterGroup DSL v2', () => {
    const evt = probeEvent({ title: 'Breach', score: 18, category: 'SEC' });

    it('AND passes only when every condition matches', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'SEC' },
                    { field: 'score', operator: 'gt', value: 10 },
                ],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'SEC' },
                    { field: 'score', operator: 'gt', value: 20 },
                ],
            }),
        ).toBe(false);
    });

    it('OR passes when any condition matches', () => {
        expect(
            matchesFilter(evt, {
                logic: 'OR',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'NOPE' },
                    { field: 'score', operator: 'gt', value: 10 },
                ],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'OR',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'NOPE' },
                    { field: 'score', operator: 'lt', value: 5 },
                ],
            }),
        ).toBe(false);
    });

    it('in / not_in operate on a value set', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'category', operator: 'in', value: ['SEC', 'COMP'] }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'category', operator: 'not_in', value: ['SEC'] }],
            }),
        ).toBe(false);
    });

    it('gt / lt are numeric; contains is substring', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'lt', value: 20 }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'title', operator: 'contains', value: 'reach' }],
            }),
        ).toBe(true);
    });

    it('nested groups compose (AND of an OR)', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'score', operator: 'gt', value: 10 },
                    {
                        logic: 'OR',
                        conditions: [
                            { field: 'category', operator: 'eq', value: 'COMP' },
                            { field: 'category', operator: 'eq', value: 'SEC' },
                        ],
                    },
                ],
            }),
        ).toBe(true);
    });

    it('unknown field fails closed inside a group', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'ghost', operator: 'eq', value: 'x' }],
            }),
        ).toBe(false);
    });

    it('empty conditions array matches (no constraints)', () => {
        expect(matchesFilter(evt, { logic: 'AND', conditions: [] })).toBe(true);
    });
});
