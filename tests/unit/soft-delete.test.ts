/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Soft-Delete Middleware Tests
 *
 * Tests the middleware behavior using mock Prisma middleware params.
 * Verifies:
 * 1. delete becomes soft delete (update with deletedAt)
 * 2. deleteMany becomes updateMany with deletedAt
 * 3. findMany adds deletedAt:null filter by default
 * 4. withDeleted opt-out returns all records (skips filter)
 * 5. Explicit deletedAt filter is not overridden
 * 6. Non-allowlisted models are not affected
 */
import { SOFT_DELETE_MODELS, withDeleted } from '../../src/lib/soft-delete';

// ─── Middleware simulation ───
// We test the middleware logic by simulating the $use callback behavior

describe('Soft-Delete Middleware', () => {
    // Simulate the middleware logic extracted from registerSoftDeleteMiddleware
    function simulateMiddleware(
        model: string,
        action: string,
        args: any,
        _auditContext?: { actorUserId?: string },
    ): { action: string; args: any; passedThrough: boolean } {
        const READ_ACTIONS = new Set(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy']);
        const DELETE_ACTIONS = new Set(['delete', 'deleteMany']);
        const INCLUDE_DELETED_KEY = '__includeDeleted';

        const params = { model, action, args: JSON.parse(JSON.stringify(args || {})) };

        // Not in allowlist → pass through unchanged
        if (!SOFT_DELETE_MODELS.has(model)) {
            return { action: params.action, args: params.args, passedThrough: true };
        }

        // Delete interception
        if (DELETE_ACTIONS.has(params.action)) {
            if (params.action === 'delete') {
                params.action = 'update';
                params.args.data = { deletedAt: expect.any(Date), deletedByUserId: null };
            } else if (params.action === 'deleteMany') {
                params.action = 'updateMany';
                params.args.data = { deletedAt: expect.any(Date), deletedByUserId: null };
            }
            return { action: params.action, args: params.args, passedThrough: false };
        }

        // Read filtering
        if (READ_ACTIONS.has(params.action)) {
            if (params.args?.[INCLUDE_DELETED_KEY]) {
                delete params.args[INCLUDE_DELETED_KEY];
                return { action: params.action, args: params.args, passedThrough: false };
            }
            if (params.args?.where?.deletedAt !== undefined) {
                return { action: params.action, args: params.args, passedThrough: false };
            }
            if (!params.args) params.args = {};
            if (!params.args.where) params.args.where = {};
            params.args.where.deletedAt = null;
            return { action: params.action, args: params.args, passedThrough: false };
        }

        return { action: params.action, args: params.args, passedThrough: true };
    }

    describe('Delete interception', () => {
        test('delete on Asset becomes update with deletedAt', () => {
            const result = simulateMiddleware('Asset', 'delete', { where: { id: 'a1' } });
            expect(result.action).toBe('update');
            expect(result.args.data).toBeDefined();
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('delete on Control becomes update with deletedAt', () => {
            const result = simulateMiddleware('Control', 'delete', { where: { id: 'r1' } });
            expect(result.action).toBe('update');
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('delete on Control becomes update with deletedAt', () => {
            const result = simulateMiddleware('Control', 'delete', { where: { id: 'c1' } });
            expect(result.action).toBe('update');
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('delete on Evidence becomes update with deletedAt', () => {
            const result = simulateMiddleware('Evidence', 'delete', { where: { id: 'e1' } });
            expect(result.action).toBe('update');
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('delete on Policy becomes update with deletedAt', () => {
            const result = simulateMiddleware('Policy', 'delete', { where: { id: 'p1' } });
            expect(result.action).toBe('update');
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('deleteMany on Asset becomes updateMany with deletedAt', () => {
            const result = simulateMiddleware('Asset', 'deleteMany', { where: { tenantId: 't1' } });
            expect(result.action).toBe('updateMany');
            expect(result.args.data.deletedAt).toBeDefined();
        });

        test('deleteMany on Control becomes updateMany with deletedAt', () => {
            const result = simulateMiddleware('Control', 'deleteMany', { where: { tenantId: 't1' } });
            expect(result.action).toBe('updateMany');
            expect(result.args.data.deletedAt).toBeDefined();
        });
    });

    describe('Read filtering', () => {
        test('findMany on Asset adds deletedAt:null filter', () => {
            const result = simulateMiddleware('Asset', 'findMany', { where: { tenantId: 't1' } });
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('findFirst on Risk adds deletedAt:null filter', () => {
            const result = simulateMiddleware('Control', 'findFirst', { where: { id: 'r1' } });
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('findUnique on Control adds deletedAt:null filter', () => {
            const result = simulateMiddleware('Control', 'findUnique', { where: { id: 'c1' } });
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('count on Evidence adds deletedAt:null filter', () => {
            const result = simulateMiddleware('Evidence', 'count', { where: { tenantId: 't1' } });
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('groupBy on Policy adds deletedAt:null filter', () => {
            const result = simulateMiddleware('Policy', 'groupBy', { where: { tenantId: 't1' } });
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('findMany with no args gets deletedAt:null filter', () => {
            const result = simulateMiddleware('Asset', 'findMany', {});
            expect(result.args.where.deletedAt).toBeNull();
        });

        test('findMany with null args gets deletedAt:null filter', () => {
            const result = simulateMiddleware('Asset', 'findMany', null);
            expect(result.args.where.deletedAt).toBeNull();
        });
    });

    describe('withDeleted opt-out', () => {
        test('withDeleted sets __includeDeleted flag', () => {
            const args = withDeleted({ where: { tenantId: 't1' } });
            expect((args as any).__includeDeleted).toBe(true);
        });

        test('findMany with __includeDeleted does NOT add deletedAt filter', () => {
            const args = withDeleted({ where: { tenantId: 't1' } });
            const result = simulateMiddleware('Asset', 'findMany', args);
            expect(result.args.where.deletedAt).toBeUndefined();
            expect(result.args.__includeDeleted).toBeUndefined(); // flag stripped
        });

        test('explicit deletedAt filter is not overridden', () => {
            const result = simulateMiddleware('Asset', 'findMany', {
                where: { tenantId: 't1', deletedAt: { not: null } },
            });
            // Should preserve the explicit filter
            expect(result.args.where.deletedAt).toEqual({ not: null });
        });
    });

    describe('Non-allowlisted models are unaffected', () => {
        test('delete on AuditLog passes through unchanged', () => {
            const result = simulateMiddleware('AuditLog', 'delete', { where: { id: 'a1' } });
            expect(result.action).toBe('delete');
            expect(result.passedThrough).toBe(true);
        });

        test('delete on User passes through unchanged', () => {
            const result = simulateMiddleware('User', 'delete', { where: { id: 'u1' } });
            expect(result.action).toBe('delete');
            expect(result.passedThrough).toBe(true);
        });

        test('findMany on Tenant passes through without filter', () => {
            const result = simulateMiddleware('Tenant', 'findMany', { where: {} });
            expect(result.args.where.deletedAt).toBeUndefined();
            expect(result.passedThrough).toBe(true);
        });

        test('delete on AuthSession passes through (ephemeral model)', () => {
            const result = simulateMiddleware('AuthSession', 'delete', { where: { id: 's1' } });
            expect(result.action).toBe('delete');
            expect(result.passedThrough).toBe(true);
        });
    });

    describe('SOFT_DELETE_MODELS allowlist', () => {
        test('contains exactly the expected models', () => {
            // P0 models
            expect(SOFT_DELETE_MODELS.has('Asset')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('Control')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('Evidence')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('Policy')).toBe(true);
            // P1 models
            expect(SOFT_DELETE_MODELS.has('Vendor')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('FileRecord')).toBe(true);
            // P2 models
            expect(SOFT_DELETE_MODELS.has('Task')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('Finding')).toBe(true);
            // P3 models
            expect(SOFT_DELETE_MODELS.has('Audit')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('AuditCycle')).toBe(true);
            expect(SOFT_DELETE_MODELS.has('AuditPack')).toBe(true);
            // Grain (2026-07-25) — Contract already carried the full
            // soft-delete trio and its usecase soft-deletes, but it was
            // registered in neither this set nor the retention sweep, so
            // `retentionUntil` was written by nothing and read by
            // nothing.
            expect(SOFT_DELETE_MODELS.has('Contract')).toBe(true);
            expect(SOFT_DELETE_MODELS.size).toBe(12);
        });

        test('does NOT include ephemeral models', () => {
            expect(SOFT_DELETE_MODELS.has('AuditLog')).toBe(false);
            expect(SOFT_DELETE_MODELS.has('AuthSession')).toBe(false);
            expect(SOFT_DELETE_MODELS.has('VerificationToken')).toBe(false);
            expect(SOFT_DELETE_MODELS.has('Notification')).toBe(false);
            expect(SOFT_DELETE_MODELS.has('Account')).toBe(false);
        });
    });

    describe('Update/Create actions are not intercepted', () => {
        test('create on Asset passes through unchanged', () => {
            const result = simulateMiddleware('Asset', 'create', { data: { name: 'test' } });
            expect(result.action).toBe('create');
        });

        test('update on Asset passes through unchanged', () => {
            const result = simulateMiddleware('Asset', 'update', { where: { id: 'a1' }, data: { name: 'new' } });
            expect(result.action).toBe('update');
        });
    });
});
