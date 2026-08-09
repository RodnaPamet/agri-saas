/**
 * Unit Test: Epic A.1 RLS middleware module.
 *
 * Pins the contract of `src/lib/db/rls-middleware.ts`:
 *   - tenant-scoped model catalogue is generated from the Prisma
 *     DMMF at startup and covers every model with a `tenantId`
 *     column plus the hand-curated ownership-chained set.
 *   - `runWithoutRls` passes the raw prisma client to its callback
 *     (the docs-is-the-feature bypass helper).
 *   - `installRlsTripwire` is idempotent and logs — never throws —
 *     when a tenant-scoped query runs without a tenant context.
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {},
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('@/lib/audit-context', () => ({
    getAuditContext: jest.fn(),
}));

import {
    TENANT_SCOPED_MODELS,
    isTenantScopedModel,
    runWithoutRls,
    withRlsTripwireExtension,
} from '@/lib/db/rls-middleware';
import { getAuditContext } from '@/lib/audit-context';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';

describe('TENANT_SCOPED_MODELS catalogue', () => {
    it('includes every high-value tenant-scoped model', () => {
        // Spot-check critical names across the three classes.
        const mustInclude = [
            // Class A (direct tenantId)
            'Control', 'Asset', 'Policy', 'Evidence', 'AuditLog',
            'Task', 'Vendor', 'TenantMembership', 'TenantApiKey',
            'TenantSecuritySettings', 'UserMfaEnrollment',
            'IntegrationConnection', 'AutomationRule', 'AutomationExecution',
            // Class A (direct tenantId — migrated from ownership-chained)
            'EvidenceReview', 'PolicyApproval', 'AuditChecklistItem',
            'FindingEvidence', 'AuditorPackAccess', 'PolicyControlLink',
            // Class E (ownership-chained — no direct tenantId column)
            'PolicyAcknowledgement',
        ];
        for (const name of mustInclude) {
            expect(TENANT_SCOPED_MODELS.has(name)).toBe(true);
        }
    });

    it('excludes global / shared tables', () => {
        const mustExclude = [
            'Tenant', 'User', 'Account', 'AuthSession',
            'VerificationToken', 'Clause', 'ControlTemplate',
            'Framework', 'FrameworkRequirement', 'PolicyTemplate',
            'QuestionnaireTemplate',
        ];
        for (const name of mustExclude) {
            expect(TENANT_SCOPED_MODELS.has(name)).toBe(false);
        }
    });

    it('isTenantScopedModel handles undefined/unknown gracefully', () => {
        expect(isTenantScopedModel(undefined)).toBe(false);
        expect(isTenantScopedModel('NotAModel')).toBe(false);
        expect(isTenantScopedModel('Control')).toBe(true);
    });
});

describe('runWithoutRls', () => {
    it('passes the raw prisma client through to the callback', async () => {
        const received: unknown[] = [];
        const result = await runWithoutRls(
            { reason: 'test' },
            async (db) => {
                received.push(db);
                return 'ok';
            }
        );
        expect(result).toBe('ok');
        expect(received[0]).toBe(prisma);
    });

    it('propagates errors from the callback', async () => {
        await expect(
            runWithoutRls({ reason: 'test' }, async () => {
                throw new Error('bypass path blew up');
            })
        ).rejects.toThrow('bypass path blew up');
    });

    it('rejects an unknown reason at runtime', async () => {
        await expect(
            runWithoutRls(
                // Cast to bypass the compile-time exhaustive check so
                // we can verify the runtime validation too.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { reason: 'smuggled-reason' as any },
                async () => 'ok'
            )
        ).rejects.toThrow(/unknown reason/i);
    });

    it('logs every invocation with reason + caller fingerprint', async () => {
        (logger.info as jest.Mock).mockClear();
        await runWithoutRls({ reason: 'admin-script' }, async () => 'ok');
        expect(logger.info).toHaveBeenCalledWith(
            'rls-middleware.bypass_invoked',
            expect.objectContaining({
                reason: 'admin-script',
                caller: expect.any(String),
            })
        );
    });

    it('logged caller fingerprint points at the actual call site, not the helper itself', async () => {
        (logger.info as jest.Mock).mockClear();
        await runWithoutRls({ reason: 'admin-script' }, async () => 'ok');
        const [, fields] = (logger.info as jest.Mock).mock.calls[0];
        // The fingerprint should reference this test file (the caller),
        // not rls-middleware.ts itself.
        expect(fields.caller).not.toContain('rls-middleware');
    });
});

describe('withRlsTripwireExtension', () => {
    // Build a fake client whose `$extends` captures the registered
    // `$allOperations` handler so the tests can drive it directly,
    // mirroring how the equivalent v5 tests grabbed the `$use` callback.
    type Op = (p: {
        model: string;
        operation: string;
        args?: unknown;
        query: (a: unknown) => Promise<unknown>;
    }) => Promise<unknown>;

    function captureHandler(): { handler: Op } {
        const captured: { handler: Op } = {
            handler: (async ({ query, args }) => query(args)) as Op,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fake: any = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            $extends: (cfg: any) => {
                captured.handler = cfg.query.$allModels.$allOperations as Op;
                return fake;
            },
        };
        withRlsTripwireExtension(fake);
        return captured;
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes through queries to non-tenant-scoped models without logging', async () => {
        (getAuditContext as jest.Mock).mockReturnValue(undefined);
        const { handler } = captureHandler();
        const query = jest.fn().mockResolvedValue('result');

        await handler({ model: 'Framework', operation: 'findMany', args: undefined, query });

        expect(query).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it('passes through tenant-scoped query with a tenant context', async () => {
        (getAuditContext as jest.Mock).mockReturnValue({
            tenantId: 'tenant-A',
            source: 'api',
        });
        const { handler } = captureHandler();
        const query = jest.fn().mockResolvedValue('result');

        await handler({ model: 'Control', operation: 'findMany', args: undefined, query });

        expect(query).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it.each(['seed', 'job', 'system'])(
        'passes through without logging when source=%s (bypass path)',
        async (source) => {
            (getAuditContext as jest.Mock).mockReturnValue({ source });
            const { handler } = captureHandler();
            const query = jest.fn().mockResolvedValue('result');

            await handler({ model: 'Control', operation: 'create', args: undefined, query });

            expect(query).toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalled();
        }
    );

    it('warns (not throws) on WRITE to tenant-scoped model without context', async () => {
        (getAuditContext as jest.Mock).mockReturnValue(undefined);
        const { handler } = captureHandler();
        const query = jest.fn().mockResolvedValue('result');

        const result = await handler({ model: 'Control', operation: 'update', args: undefined, query });

        expect(result).toBe('result');
        expect(query).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'rls-middleware.missing_tenant_context',
            expect.objectContaining({
                model: 'Control',
                action: 'update',
            })
        );
    });

    it('logs at debug (not warn) on READ to tenant-scoped model without context', async () => {
        (getAuditContext as jest.Mock).mockReturnValue(undefined);
        const { handler } = captureHandler();
        const query = jest.fn().mockResolvedValue([]);

        await handler({ model: 'Control', operation: 'findMany', args: undefined, query });

        expect(logger.debug).toHaveBeenCalledWith(
            'rls-middleware.missing_tenant_context',
            expect.objectContaining({ model: 'Control', action: 'findMany' })
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not leak query args/payloads into the log', async () => {
        (getAuditContext as jest.Mock).mockReturnValue(undefined);
        const { handler } = captureHandler();
        const query = jest.fn().mockResolvedValue('result');

        await handler({
            model: 'Control',
            operation: 'update',
            args: { where: { id: 'secret-id' }, data: { title: 'PII here' } },
            query,
        });

        const loggedFields = (logger.warn as jest.Mock).mock.calls[0][1];
        expect(JSON.stringify(loggedFields)).not.toContain('secret-id');
        expect(JSON.stringify(loggedFields)).not.toContain('PII here');
    });

    it('surfaces the original error when `query` throws', async () => {
        (getAuditContext as jest.Mock).mockReturnValue({
            tenantId: 'tenant-A',
            source: 'api',
        });
        const { handler } = captureHandler();
        const query = jest.fn().mockRejectedValue(new Error('db down'));

        await expect(
            handler({ model: 'Control', operation: 'findMany', args: undefined, query }),
        ).rejects.toThrow('db down');
    });
});
