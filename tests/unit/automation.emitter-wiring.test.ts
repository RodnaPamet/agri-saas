/**
 * Unit Test: existing audit-event emitters publish to the automation bus.
 *
 * Proves the usecase-layer wiring: calling `emitRiskCreated(...)` (as
 * every risk usecase already does) fans out to both the audit log and
 * the automation bus without the usecase knowing either consumer.
 */

// appendAuditEntry talks to a real DB — mock at the edge so these
// tests stay unit-level.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import {
    emitRiskCreated,
    emitRiskStatusChanged,
} from '@/app-layer/events/risk.events';
import { emitOnboardingFinished } from '@/app-layer/events/onboarding.events';
import {
    getAutomationBus,
    resetAutomationBus,
    type AutomationDomainEvent,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-wiring',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}


const fakeDb = {} as PrismaTx;

describe('Domain-event wiring — audit emitters publish to automation bus', () => {
    beforeEach(() => {
        resetAutomationBus();
    });

    it('emitRiskCreated publishes RISK_CREATED with payload', async () => {
        const received: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('RISK_CREATED', (e) => {
            received.push(e);
        });

        await emitRiskCreated(fakeDb, makeCtx(), {
            id: 'risk-1',
            title: 'SQLi exposure',
            score: 15,
            category: 'SECURITY',
        });

        expect(received).toHaveLength(1);
        const evt = received[0];
        expect(evt.event).toBe('RISK_CREATED');
        expect(evt.tenantId).toBe('tenant-A');
        expect(evt.entityId).toBe('risk-1');
        if (evt.event === 'RISK_CREATED') {
            expect(evt.data).toEqual({
                title: 'SQLi exposure',
                score: 15,
                category: 'SECURITY',
            });
        }
    });

    it('emitRiskStatusChanged publishes RISK_STATUS_CHANGED with from/to', async () => {
        const received: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('RISK_STATUS_CHANGED', (e) => {
            received.push(e);
        });

        await emitRiskStatusChanged(
            fakeDb,
            makeCtx(),
            'risk-1',
            'OPEN',
            'MITIGATING'
        );

        expect(received).toHaveLength(1);
        const evt = received[0];
        if (evt.event === 'RISK_STATUS_CHANGED') {
            expect(evt.data.fromStatus).toBe('OPEN');
            expect(evt.data.toStatus).toBe('MITIGATING');
        }
    });


    it('emitOnboardingFinished publishes ONBOARDING_FINISHED keyed to tenant', async () => {
        const received: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('ONBOARDING_FINISHED', (e) => {
            received.push(e);
        });

        await emitOnboardingFinished(fakeDb, makeCtx());

        expect(received).toHaveLength(1);
        expect(received[0].entityType).toBe('TenantOnboarding');
        expect(received[0].entityId).toBe('tenant-A');
    });

    it('a wildcard subscriber sees all fan-outs across emitters', async () => {
        const all: string[] = [];
        getAutomationBus().subscribe('*', (e) => {
            all.push(e.event);
        });

        await emitRiskCreated(fakeDb, makeCtx(), {
            id: 'risk-1',
            title: 't',
            score: 5,
        });
        await emitOnboardingFinished(fakeDb, makeCtx());

        expect(all).toEqual(['RISK_CREATED', 'ONBOARDING_FINISHED']);
    });
});
