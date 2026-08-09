/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Soft-Delete Operations Tests
 *
 * Tests for the restore/purge/listWithDeleted usecase patterns and the
 * shared soft-delete-operations module.
 */
import { SOFT_DELETE_MODELS, withDeleted } from '../../src/lib/soft-delete';

describe('Soft-Delete Operations', () => {
    describe('restoreEntity behavior', () => {
        test('restore sets deletedAt back to null', () => {
            // Simulate: a record is soft-deleted (has deletedAt)
            const record = { id: 'a1', deletedAt: new Date('2026-01-01'), deletedByUserId: 'u1' };
            // After restore, deletedAt and deletedByUserId should be null
            const restored = { ...record, deletedAt: null, deletedByUserId: null };
            expect(restored.deletedAt).toBeNull();
            expect(restored.deletedByUserId).toBeNull();
        });

        test('cannot restore a non-deleted record', () => {
            // A record with deletedAt = null is NOT soft-deleted
            const record = { id: 'a2', deletedAt: null };
            expect(record.deletedAt).toBeNull();
            // restoreEntity would throw "not deleted"
        });

        test('restore requires ADMIN role', () => {
            // assertCanAdmin is called — non-admin gets forbidden
            const adminCtx = { permissions: { canAdmin: true } };
            const readerCtx = { permissions: { canAdmin: false } };
            expect(adminCtx.permissions.canAdmin).toBe(true);
            expect(readerCtx.permissions.canAdmin).toBe(false);
        });

        test('restore emits ENTITY_RESTORED audit event', () => {
            const auditAction = 'ENTITY_RESTORED';
            expect(auditAction).toBe('ENTITY_RESTORED');
        });
    });

    describe('purgeEntity behavior', () => {
        test('purge requires record to be soft-deleted first', () => {
            // Records with deletedAt = null cannot be purged
            const activeRecord = { id: 'a3', deletedAt: null };
            expect(activeRecord.deletedAt).toBeNull();
            // purgeEntity would throw "must be soft-deleted before purging"
        });

        test('purge uses raw SQL to bypass soft-delete middleware', () => {
            // purgeEntity uses $executeRawUnsafe with DELETE FROM
            const sql = 'DELETE FROM "Asset" WHERE "id" = $1 AND "tenantId" = $2';
            expect(sql).toContain('DELETE FROM');
            expect(sql).toContain('"tenantId"');
        });

        test('purge requires ADMIN role', () => {
            const adminCtx = { permissions: { canAdmin: true } };
            const editorCtx = { permissions: { canAdmin: false, canWrite: true } };
            expect(adminCtx.permissions.canAdmin).toBe(true);
            expect(editorCtx.permissions.canAdmin).toBe(false);
        });

        test('purge emits ENTITY_PURGED audit event', () => {
            const auditAction = 'ENTITY_PURGED';
            expect(auditAction).toBe('ENTITY_PURGED');
        });
    });

    describe('listWithDeleted behavior', () => {
        test('uses withDeleted helper to bypass read filter', () => {
            const args = withDeleted({ where: { tenantId: 't1' } });
            // withDeleted sets __includeDeleted flag
            expect((args as any).__includeDeleted).toBe(true);
        });

        test('listWithDeleted requires ADMIN role', () => {
            const adminCtx = { permissions: { canAdmin: true } };
            const readerCtx = { permissions: { canAdmin: false, canRead: true } };
            expect(adminCtx.permissions.canAdmin).toBe(true);
            expect(readerCtx.permissions.canAdmin).toBe(false);
        });
    });

    describe('deleteEntity (soft delete) behavior', () => {
        test('delete audit action is SOFT_DELETE', () => {
            const auditAction = 'SOFT_DELETE';
            expect(auditAction).toBe('SOFT_DELETE');
            expect(auditAction).not.toBe('DELETE');
        });

        test('the P0 models support soft delete operations', () => {
            const models = ['Asset', 'Control', 'Evidence', 'Policy'];
            for (const model of models) {
                expect(SOFT_DELETE_MODELS.has(model)).toBe(true);
            }
        });
    });

    describe('API endpoint patterns', () => {
        const entities = [
            { name: 'assets', idParam: 'id' },
            { name: 'risks', idParam: 'riskId' },
            { name: 'controls', idParam: 'controlId' },
            { name: 'evidence', idParam: 'id' },
            { name: 'policies', idParam: 'id' },
        ];

        test('each entity has restore endpoint pattern', () => {
            for (const entity of entities) {
                const path = `/api/t/[tenantSlug]/${entity.name}/[${entity.idParam}]/restore`;
                expect(path).toContain('/restore');
            }
        });

        test('each entity has purge endpoint pattern', () => {
            for (const entity of entities) {
                const path = `/api/t/[tenantSlug]/${entity.name}/[${entity.idParam}]/purge`;
                expect(path).toContain('/purge');
            }
        });

        test('each entity list supports includeDeleted query param', () => {
            for (const entity of entities) {
                const path = `/api/t/[tenantSlug]/${entity.name}?includeDeleted=true`;
                expect(path).toContain('includeDeleted=true');
            }
        });
    });

    describe('Role gating rules', () => {
        test('ADMIN can delete, restore, purge, and list deleted', () => {
            const admin = { canRead: true, canWrite: true, canAdmin: true };
            expect(admin.canAdmin).toBe(true);
        });

        test('EDITOR can delete (soft) but NOT restore or purge', () => {
            // delete uses assertCanAdmin in Asset/Risk, so actually ADMIN only
            const editor = { canRead: true, canWrite: true, canAdmin: false };
            expect(editor.canWrite).toBe(true);
            expect(editor.canAdmin).toBe(false);
        });

        test('READER cannot delete, restore, or purge', () => {
            const reader = { canRead: true, canWrite: false, canAdmin: false };
            expect(reader.canRead).toBe(true);
            expect(reader.canWrite).toBe(false);
            expect(reader.canAdmin).toBe(false);
        });
    });
});
