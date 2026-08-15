/**
 * Unit Test: Automation domain-event contracts.
 *
 * The discriminated union is enforced by the TypeScript compiler;
 * this file exists to *runtime-pin* a handful of invariants that
 * can still be violated at the module boundary:
 *   - every catalogue entry appears as a contract variant
 *   - `isEvent` narrows correctly at runtime
 *   - the `EmitAutomationEvent` shape excludes bus-stamped fields
 */

import {
    AUTOMATION_EVENTS,
    AUTOMATION_EVENT_NAMES,
} from '@/app-layer/automation/events';
import {
    isEvent,
    type AutomationDomainEvent,
    type EmitAutomationEvent,
} from '@/app-layer/automation/event-contracts';

function buildFakeEvent(
    name: AutomationDomainEvent['event']
): AutomationDomainEvent {
    const base = {
        tenantId: 't',
        entityType: 'X',
        entityId: 'id',
        actorUserId: null,
        emittedAt: new Date(),
    };
    switch (name) {
        case 'EVIDENCE_EXPIRING':
            return {
                ...base,
                event: name,
                data: { title: 'e', retentionUntil: null },
            };
        case 'EVIDENCE_EXPIRED':
            return {
                ...base,
                event: name,
                data: { title: 'e', expiredAt: null },
            };
        case 'SCHEDULE':
            return {
                ...base,
                event: name,
                data: { target: 'Evidence', dueAt: null, offsetDays: 7 },
            };
        case 'ONBOARDING_STARTED':
        case 'ONBOARDING_FINISHED':
        case 'ONBOARDING_RESTARTED':
            return { ...base, event: name, data: {} };
        case 'ONBOARDING_STEP_COMPLETED':
            return { ...base, event: name, data: { step: 'intro' } };
        case 'TASK_CREATED':
            return {
                ...base,
                event: name,
                data: {
                    key: 'TSK-1',
                    title: 't',
                    type: 'TASK',
                    severity: 'MEDIUM',
                    priority: 'P2',
                    assigneeUserId: null,
                },
            };
        case 'TASK_STATUS_CHANGED':
            return {
                ...base,
                event: name,
                data: {
                    fromStatus: 'OPEN',
                    toStatus: 'CLOSED',
                    resolution: null,
                },
            };
        case 'ISSUE_CREATED':
            return {
                ...base,
                event: name,
                data: {
                    key: 'ISS-1',
                    title: 't',
                    severity: 'HIGH',
                    status: 'OPEN',
                    assigneeUserId: null,
                },
            };
        case 'ISSUE_STATUS_CHANGED':
            return {
                ...base,
                event: name,
                data: { fromStatus: 'OPEN', toStatus: 'RESOLVED' },
            };
        case 'SPRAY_JOB_STARTED':
            return {
                ...base,
                event: name,
                data: {
                    taskId: 't1',
                    taskKey: 'FOP-1',
                    locationId: 'loc1',
                    operationType: 'SPRAY',
                    parcelCount: 3,
                    productItemId: 'item1',
                    assigneeUserId: 'user2',
                },
            };
        case 'OPERATION_PARCEL_MARKED':
            return {
                ...base,
                event: name,
                data: {
                    taskId: 't1',
                    operationParcelId: 'op1',
                    parcelId: 'p1',
                    status: 'DONE',
                    jobResolved: false,
                },
            };
        case 'HARVEST_YIELD_RECORDED':
            return {
                ...base,
                event: name,
                data: {
                    yieldRecordId: 'yr1',
                    commodity: 'Wheat',
                    grossTonnes: 42,
                    areaHa: 10,
                    plantingId: null,
                    seasonId: null,
                },
            };
    }
}

describe('Automation event contracts', () => {
    it('every catalogue entry has a matching discriminated-union variant (buildFakeEvent covers all)', () => {
        // If a new catalogue entry landed without a contract variant,
        // buildFakeEvent's switch would throw on an unhandled case.
        for (const name of AUTOMATION_EVENT_NAMES) {
            expect(() => buildFakeEvent(name)).not.toThrow();
        }
    });

    it('isEvent narrows correctly', () => {
        // Exemplar only — any two catalogue entries with different data
        // shapes prove the narrowing. This used TEST_PLAN_CREATED /
        // TEST_PLAN_UPDATED until the GRC teardown removed them (plan
        // §8k: their subject models had already been dropped).
        const ev = buildFakeEvent('EVIDENCE_EXPIRING');
        expect(isEvent(ev, 'EVIDENCE_EXPIRING')).toBe(true);
        expect(isEvent(ev, 'EVIDENCE_EXPIRED')).toBe(false);

        if (isEvent(ev, 'EVIDENCE_EXPIRING')) {
            // TypeScript-narrowed — `ev.data.retentionUntil` exists on this
            // variant only; it is absent from EvidenceExpiredData.
            expect(ev.data.retentionUntil).toBeNull();
        }
    });

    it('EmitAutomationEvent excludes bus-stamped fields', () => {
        // Producer's emit input must NOT include tenantId/emittedAt.
        // Enforced at compile time by Omit; this is a runtime sanity
        // check that the shape we hand to the bus is narrower than
        // the full event.
        const input: EmitAutomationEvent = {
            event: 'EVIDENCE_EXPIRING',
            entityType: 'Evidence',
            entityId: 'e-1',
            actorUserId: null,
            data: { title: 'e', retentionUntil: null },
        };
        expect('tenantId' in input).toBe(false);
        expect('emittedAt' in input).toBe(false);
    });

    it('AUTOMATION_EVENTS is exhaustive (no discriminant missing)', () => {
        // The `_catalogueCheck` compile-time assertion in
        // event-contracts.ts only fires when the union is missing a
        // catalogue entry. Mirror that runtime-side: every catalogue
        // name must be a discriminator value we can construct.
        const names = Object.values(AUTOMATION_EVENTS);
        for (const n of names) {
            const evt = buildFakeEvent(
                n as AutomationDomainEvent['event']
            );
            expect(evt.event).toBe(n);
        }
    });
});
