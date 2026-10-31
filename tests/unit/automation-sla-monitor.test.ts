/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for the SLA monitor sweep (Automation Epic 5).
 *
 * Covers: breached RUNNING executions are completed FAILED + audited; not-yet-
 * breached executions are skipped; a NOTIFY_USER breach action creates
 * notifications.
 */

const mockDb = {
    automationExecution: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
    // The breach notification is written in each RECIPIENT's language, and
    // this runs in a tenant context — `User` carries no `tenantId`, so the
    // locale is read through the membership (#2511).
    tenantMembership: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_tid: string, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/automation', () => ({
    AutomationExecutionRepository: { recordCompletion: jest.fn() },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/permissions', () => ({ getPermissionsForRole: () => ({}) }));

import { sweepTenant } from '@/app-layer/jobs/sla-monitor';
import { AutomationExecutionRepository } from '@/app-layer/automation';
import { logEvent } from '@/app-layer/events/audit';

const repo = AutomationExecutionRepository as jest.Mocked<typeof AutomationExecutionRepository>;

beforeEach(() => {
    jest.clearAllMocks();
    // Default: both configured recipients are Bulgarian, the production
    // majority (7 of 8 users).
    mockDb.tenantMembership.findMany.mockResolvedValue([
        { userId: 'u1', user: { uiLanguage: 'bg' } },
        { userId: 'u2', user: { uiLanguage: 'bg' } },
    ]);
});

const NOW = new Date('2026-06-08T12:00:00.000Z');
const twoHoursAgo = new Date('2026-06-08T10:00:00.000Z');
const tenMinAgo = new Date('2026-06-08T11:50:00.000Z');

describe('sla-monitor sweepTenant', () => {
    it('completes a breached execution as FAILED and audits the breach', async () => {
        mockDb.automationExecution.findMany.mockResolvedValue([
            {
                id: 'exec-1',
                ruleId: 'rule-1',
                startedAt: twoHoursAgo,
                createdAt: twoHoursAgo,
                rule: { slaWindowMinutes: 60, slaBreachActionType: null, slaBreachConfigJson: null },
            },
        ]);

        const count = await sweepTenant('tenant-1', NOW);

        expect(count).toBe(1);
        expect(repo.recordCompletion).toHaveBeenCalledWith(
            mockDb,
            expect.objectContaining({ tenantId: 'tenant-1' }),
            'exec-1',
            expect.objectContaining({
                status: 'FAILED',
                outcome: expect.objectContaining({ slaBreached: true }),
            }),
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            expect.anything(),
            expect.objectContaining({ action: 'AUTOMATION_SLA_BREACHED', entityId: 'exec-1' }),
        );
    });

    it('skips an execution still within its SLA window', async () => {
        mockDb.automationExecution.findMany.mockResolvedValue([
            {
                id: 'exec-2',
                ruleId: 'rule-2',
                startedAt: tenMinAgo,
                createdAt: tenMinAgo,
                rule: { slaWindowMinutes: 60, slaBreachActionType: null, slaBreachConfigJson: null },
            },
        ]);

        const count = await sweepTenant('tenant-1', NOW);

        expect(count).toBe(0);
        expect(repo.recordCompletion).not.toHaveBeenCalled();
    });

    it('fires a NOTIFY_USER breach action as notifications', async () => {
        mockDb.automationExecution.findMany.mockResolvedValue([
            {
                id: 'exec-3',
                ruleId: 'rule-3',
                startedAt: twoHoursAgo,
                createdAt: twoHoursAgo,
                rule: {
                    slaWindowMinutes: 30,
                    slaBreachActionType: 'NOTIFY_USER',
                    slaBreachConfigJson: { userIds: ['u1', 'u2'], message: 'Breached!' },
                },
            },
        ]);

        await sweepTenant('tenant-1', NOW);

        expect(mockDb.notification.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ userId: 'u1', tenantId: 'tenant-1' }),
                expect.objectContaining({ userId: 'u2', tenantId: 'tenant-1' }),
            ],
        });
    });

    it("passes the operator's own breach message through untranslated", async () => {
        // `cfg.message` is typed into the rule builder by the tenant. It is
        // their copy, not ours, and translating a farm's own wording would be
        // rewriting it. Only the FALLBACK is ours to localise.
        mockDb.automationExecution.findMany.mockResolvedValue([
            {
                id: 'exec-4',
                ruleId: 'rule-4',
                startedAt: twoHoursAgo,
                createdAt: twoHoursAgo,
                rule: {
                    slaWindowMinutes: 30,
                    slaBreachActionType: 'NOTIFY_USER',
                    slaBreachConfigJson: { userIds: ['u1'], message: 'Breached!' },
                },
            },
        ]);

        await sweepTenant('tenant-1', NOW);

        const rows = mockDb.notification.createMany.mock.calls[0][0].data;
        expect(rows[0].message).toBe('Breached!');
        // The TITLE is ours, so it is localised even when the body is not.
        expect(rows[0].title).toMatch(/[Ѐ-ӿ]/);
        expect(rows[0].title).not.toContain('notifications.');
    });

    it('localises the fallback body per recipient when no message is configured', async () => {
        mockDb.tenantMembership.findMany.mockResolvedValue([
            { userId: 'u1', user: { uiLanguage: 'bg' } },
            { userId: 'u2', user: { uiLanguage: 'en' } },
        ]);
        mockDb.automationExecution.findMany.mockResolvedValue([
            {
                id: 'exec-5',
                ruleId: 'rule-5',
                startedAt: twoHoursAgo,
                createdAt: twoHoursAgo,
                rule: {
                    slaWindowMinutes: 30,
                    slaBreachActionType: 'NOTIFY_USER',
                    slaBreachConfigJson: { userIds: ['u1', 'u2'] },
                },
            },
        ]);

        await sweepTenant('tenant-1', NOW);

        const rows = mockDb.notification.createMany.mock.calls[0][0].data;
        const bg = rows.find((r: { userId: string }) => r.userId === 'u1');
        const en = rows.find((r: { userId: string }) => r.userId === 'u2');
        expect(bg.message).toMatch(/[Ѐ-ӿ]/);
        expect(en.message).not.toMatch(/[Ѐ-ӿ]/);
        // The window is interpolated, not left as a placeholder.
        expect(bg.message).toContain('30');
        expect(en.message).toContain('30');
        expect(bg.message).not.toContain('{minutes}');
    });
});
