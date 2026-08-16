/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/soft-delete-operations.ts` —
 * generic restore + purge for every soft-deletable entity.
 *
 * Wave-10 / stage-3h branch coverage. Both `restoreEntity` and
 * `purgeEntity` are ADMIN-gated decision-dense paths:
 *   - assertCanAdmin gate
 *   - record-not-found (no row)
 *   - record-not-deleted (deletedAt === null)
 *   - happy path → update with `{ deletedAt: null, deletedByUserId: null }`
 *     OR raw DELETE bypassing the soft-delete middleware
 *   - audit log emission on each path
 *
 * NOTE — a different test file at `tests/unit/soft-delete-operations.test.ts`
 * exercises a different module's behaviour; that file does NOT cover
 * THIS source file (`src/app-layer/usecases/soft-delete-operations.ts`).
 * Measured coverage of THIS module is 0% before this test.
 */

const policyCalls: string[] = [];
const auditCalls: any[] = [];
const execRawCalls: any[] = [];

jest.mock('@/app-layer/policies/common', () => ({
    assertCanAdmin: jest.fn((_ctx: any) => policyCalls.push('admin')),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: any, _ctx: any, evt: any) => {
        auditCalls.push(evt);
    }),
}));

// Provide a `withDeleted` that simply returns its arg — the source
// passes the args through to `findFirst`, and we match on `where`
// directly in our delegate stubs. Keep the other exports (used by
// other modules transitively imported by `runInTenantContext`) via
// `jest.requireActual` so the Prisma `$extends` setup still works.
jest.mock('@/lib/soft-delete', () => {
    const actual = jest.requireActual('@/lib/soft-delete');
    return {
        ...actual,
        withDeleted: (args: any) => args,
    };
});

const findFirstMock = jest.fn();
const updateMock = jest.fn();
const tenantDb: any = {
    // One stub per RestorableModel delegate. `risk` was here until the
    // risk uproot; `fileRecord` is the multi-word name that proves the
    // camelCase delegate transform.
    asset: { findFirst: findFirstMock, update: updateMock },
    evidence: { findFirst: findFirstMock, update: updateMock },
    fileRecord: { findFirst: findFirstMock, update: updateMock },
    task: { findFirst: findFirstMock, update: updateMock },
    $executeRawUnsafe: jest.fn(async (...args: any[]) => {
        execRawCalls.push(args);
        return 1;
    }),
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { restoreEntity, purgeEntity } from '@/app-layer/usecases/soft-delete-operations';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    auditCalls.length = 0;
    execRawCalls.length = 0;
    findFirstMock.mockReset();
    updateMock.mockReset();
    tenantDb.$executeRawUnsafe.mockClear();
});

const ctx = makeRequestContext('ADMIN');

describe('restoreEntity — guard rails', () => {
    it('invokes assertCanAdmin before any DB read', async () => {
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-01-01'),
        });
        updateMock.mockResolvedValue({ id: 'a-1' });
        await restoreEntity(ctx, 'Asset', 'a-1');
        expect(assertCanAdmin).toHaveBeenCalledWith(ctx);
        expect(policyCalls).toEqual(['admin']);
    });

    it('throws notFound when no row exists', async () => {
        findFirstMock.mockResolvedValue(null);
        await expect(restoreEntity(ctx, 'Asset', 'missing')).rejects.toThrow(/not found/);
        expect(updateMock).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('throws notFound when the row exists but is not deleted', async () => {
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
        await expect(restoreEntity(ctx, 'Asset', 'a-1')).rejects.toThrow(/is not deleted/);
        expect(updateMock).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });
});

describe('restoreEntity — happy path', () => {
    it('restores the row, nulls deletedByUserId, emits ENTITY_RESTORED audit', async () => {
        const previousDeletedAt = new Date('2026-01-01T00:00:00Z');
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: previousDeletedAt,
        });
        updateMock.mockResolvedValue({ id: 'a-1', deletedAt: null });
        const out = await restoreEntity(ctx, 'Asset', 'a-1');
        // Update was called with both null assignments.
        expect(updateMock).toHaveBeenCalledWith({
            where: { id: 'a-1' },
            data: { deletedAt: null, deletedByUserId: null },
        });
        // Audit log shape — uses ENTITY_RESTORED, carries the model
        // name + entity-lifecycle category + the previous timestamp.
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0]).toMatchObject({
            action: 'ENTITY_RESTORED',
            entityType: 'Asset',
            entityId: 'a-1',
        });
        expect(auditCalls[0].detailsJson.category).toBe('entity_lifecycle');
        expect(auditCalls[0].detailsJson.before.deletedAt).toBe(previousDeletedAt.toISOString());
        expect(auditCalls[0].metadata.previousDeletedAt).toBe(previousDeletedAt);
        expect(out).toEqual({ id: 'a-1', deletedAt: null });
    });

    it('lower-cases the model name for delegate lookup (FileRecord → db.fileRecord)', async () => {
        // Was `Risk → db.risk` until the risk uproot, and the name went
        // on being passed to `restoreEntity` long after the model died —
        // the call did not throw because the delegate stubs are shared,
        // so the test asserted the indirection against a model that no
        // longer existed. `FileRecord` is a live `RestorableModel` AND a
        // multi-word name, which exercises the transform properly:
        // `charAt(0).toLowerCase() + slice(1)` must give `fileRecord`,
        // not `filerecord`.
        findFirstMock.mockResolvedValue({
            id: 'f-1',
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-01-01'),
        });
        updateMock.mockResolvedValue({ id: 'f-1' });
        await restoreEntity(ctx, 'FileRecord', 'f-1');
        expect(findFirstMock).toHaveBeenCalled();
        expect(updateMock).toHaveBeenCalled();
    });
});

describe('purgeEntity — guard rails', () => {
    it('invokes assertCanAdmin before any DB read', async () => {
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-01-01'),
        });
        await purgeEntity(ctx, 'Asset', 'a-1');
        expect(assertCanAdmin).toHaveBeenCalledWith(ctx);
    });

    it('throws notFound when no row exists', async () => {
        findFirstMock.mockResolvedValue(null);
        await expect(purgeEntity(ctx, 'Asset', 'missing')).rejects.toThrow(/not found/);
        expect(tenantDb.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });

    it('refuses to purge a row that is not soft-deleted (compliance guard)', async () => {
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: null,
        });
        await expect(purgeEntity(ctx, 'Asset', 'a-1')).rejects.toThrow(
            /must be soft-deleted before purging/,
        );
        expect(tenantDb.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(auditCalls).toHaveLength(0);
    });
});

describe('purgeEntity — happy path', () => {
    it('bypasses the soft-delete middleware via $executeRawUnsafe', async () => {
        findFirstMock.mockResolvedValue({
            id: 'a-1',
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-01-01'),
        });
        const out = await purgeEntity(ctx, 'Asset', 'a-1');
        // Raw DELETE — bypassing the soft-delete extension is the
        // entire point of using $executeRawUnsafe here.
        expect(execRawCalls).toHaveLength(1);
        const [sql, ...params] = execRawCalls[0];
        expect(sql).toMatch(/DELETE FROM "Asset"/);
        expect(sql).toMatch(/WHERE "id" = \$1/);
        expect(sql).toMatch(/"tenantId" = \$2/);
        expect(params).toEqual(['a-1', 'tenant-1']);
        expect(out).toEqual({ success: true, purged: true });
    });

    it('emits ENTITY_PURGED audit with data_lifecycle category', async () => {
        findFirstMock.mockResolvedValue({
            id: 'p-1',
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-01-01'),
        });
        // `Task`, not `Evidence` — purging Evidence additionally runs
        // `purgeEvidenceBytes`, and this test is about the audit row,
        // not the byte-deletion side effect.
        await purgeEntity(ctx, 'Task', 'p-1');
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0]).toMatchObject({
            action: 'ENTITY_PURGED',
            entityType: 'Task',
            entityId: 'p-1',
        });
        expect(auditCalls[0].detailsJson.category).toBe('data_lifecycle');
        expect(auditCalls[0].detailsJson.operation).toBe('purged');
        expect(auditCalls[0].detailsJson.model).toBe('Task');
    });

    it('does NOT write an audit log when the early-out rejects fire', async () => {
        findFirstMock.mockResolvedValue(null);
        await expect(purgeEntity(ctx, 'Asset', 'missing')).rejects.toThrow();
        // The audit log MUST not record an attempted purge of a non-
        // existent row — the rejection is at the gate, not part of
        // the lifecycle.
        expect(auditCalls).toHaveLength(0);
    });
});
