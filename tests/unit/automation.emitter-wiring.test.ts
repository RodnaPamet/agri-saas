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

