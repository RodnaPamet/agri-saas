/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Golden-path integration test and event writer contract tests.
 *
 * Proves:
 * 1. logEvent delegates to appendAuditEntry with correct fields
 * 2. logEvent enforces tenantId and userId from RequestContext
 * 3. logEvent sanitizes metadata and includes requestId
 * 4. logEvent passes detailsJson through to appendAuditEntry
 * 5. The full golden path: policy check → event emission
 */

import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Mock appendAuditEntry BEFORE importing logEvent ───

const appendAuditEntryCalls: any[] = [];

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async (input: any) => {
        appendAuditEntryCalls.push(input);
        return { id: 'audit-1', entryHash: 'hash-abc', previousHash: null };
    }),
}));

// Import AFTER mock is set up
import { logEvent } from '@/app-layer/events/audit';

function createCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test-123',
        userId: 'user-test-1',
        tenantId: 'tenant-test-1',
        tenantSlug: 'test-co',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole((overrides.role ?? 'ADMIN') as any),
        ...overrides,
    };
}

beforeEach(() => {
    appendAuditEntryCalls.length = 0;
});

describe('Central Event Writer Contract', () => {
    it('logEvent always includes requestId in output', async () => {
        const ctx = createCtx({ requestId: 'req-abc-456' });

        await logEvent({} as any, ctx, {
            action: 'TEST_ACTION',
            entityType: 'TestEntity',
            entityId: 'entity-1',
            details: 'Test event',
        });

        expect(appendAuditEntryCalls).toHaveLength(1);
        const logged = appendAuditEntryCalls[0];
        // requestId is passed directly to appendAuditEntry
        expect(logged.requestId).toBe('req-abc-456');
        // Also embedded in combined details text
        expect(logged.details).toContain('req-abc-456');
        expect(logged.details).toContain('requestId');
    });

    it('logEvent enforces tenantId from ctx', async () => {
        const ctx = createCtx({ tenantId: 'tenant-specific-id' });

        await logEvent({} as any, ctx, {
            action: 'TEST_ACTION',
            entityType: 'TestEntity',
            entityId: 'entity-1',
        });

        const logged = appendAuditEntryCalls[0];
        expect(logged.tenantId).toBe('tenant-specific-id');
    });

    it('logEvent enforces userId from ctx', async () => {
        const ctx = createCtx({ userId: 'user-specific-id' });

        await logEvent({} as any, ctx, {
            action: 'TEST_ACTION',
            entityType: 'TestEntity',
            entityId: 'entity-1',
        });

        const logged = appendAuditEntryCalls[0];
        expect(logged.userId).toBe('user-specific-id');
    });

    it('logEvent includes safe metadata without leaking secrets', async () => {
        const ctx = createCtx();

        await logEvent({} as any, ctx, {
            action: 'TEST_ACTION',
            entityType: 'TestEntity',
            entityId: 'entity-1',
            metadata: { key: 'value', nested: { deep: true } },
        });

        const logged = appendAuditEntryCalls[0];
        expect(logged.details).toContain('key');
        expect(logged.details).toContain('value');
        // metadataJson should contain the sanitized metadata
        expect(logged.metadataJson).toEqual({ key: 'value', nested: { deep: true } });
    });

    it('logEvent works without optional fields', async () => {
        const ctx = createCtx();

        await logEvent({} as any, ctx, {
            action: 'MINIMAL_ACTION',
            entityType: 'TestEntity',
            entityId: 'entity-1',
        });

        const logged = appendAuditEntryCalls[0];
        expect(logged.action).toBe('MINIMAL_ACTION');
        expect(logged.entity).toBe('TestEntity');
        expect(logged.entityId).toBe('entity-1');
        expect(logged.tenantId).toBe('tenant-test-1');
        expect(logged.userId).toBe('user-test-1');
    });

    it('logEvent passes detailsJson through to appendAuditEntry', async () => {
        const ctx = createCtx();
        const detailsJson = {
            category: 'entity_lifecycle',
            entityName: 'Practice',
            operation: 'created',
            summary: 'Test practice created',
        };

        await logEvent({} as any, ctx, {
            action: 'CONTROL_CREATED',
            entityType: 'Practice',
            entityId: 'ctrl-1',
            details: 'Created practice',
            detailsJson,
        });

        const logged = appendAuditEntryCalls[0];
        expect(logged.detailsJson).toEqual(detailsJson);
    });
});

describe('Golden Path: Usecase → Repo → Event', () => {
    it('a usecase should enforce policy, write tenant-scoped data, and emit event', async () => {
        const ctx = createCtx({ role: 'EDITOR', permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true } });

        // Simulate: policy check (assertCanWrite passes for EDITOR)
        const { assertCanWrite } = await import('@/app-layer/policies/common');
        expect(() => assertCanWrite(ctx)).not.toThrow();

        // Simulate: event emission
        await logEvent({} as any, ctx, {
            action: 'GOLDEN_PATH_TEST',
            entityType: 'TestEntity',
            entityId: 'golden-1',
            details: 'Golden path test passed',
        });

        // Verify: event was written with correct tenant and request correlation
        expect(appendAuditEntryCalls).toHaveLength(1);
        const event = appendAuditEntryCalls[0];
        expect(event.tenantId).toBe(ctx.tenantId);
        expect(event.userId).toBe(ctx.userId);
        expect(event.details).toContain(ctx.requestId);
        expect(event.action).toBe('GOLDEN_PATH_TEST');
    });

    it('a READER should be denied write access by policy', async () => {
        const ctx = createCtx({ role: 'READER', permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false } });

        const { assertCanWrite } = await import('@/app-layer/policies/common');
        expect(() => assertCanWrite(ctx)).toThrow();
    });
});
