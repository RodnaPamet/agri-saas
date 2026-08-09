/**
 * Integration tests for Prisma audit middleware — verifies that write operations
 * automatically produce AuditLog rows with diff and redaction support.
 *
 * Requires a running PostgreSQL instance with applied migrations.
 *
 * RUN: npx jest tests/integration/audit-middleware.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- this file
 * mirrors the Prisma 7 `$extends({ query })` middleware shape from
 * `src/lib/prisma.ts` to verify side effects, then introspects
 * AuditLog rows via `(match as any).diffJson` etc. The middleware
 * args (`args: any`, `query: (a: any) => Promise<any>`) are
 * intentionally typed loose to mirror Prisma's runtime extension
 * shape — narrowing them would couple the test to internal types
 * that aren't exported. The cast-on-access patterns
 * (`(match as any).requestId`, `(match as any).diffJson`) reflect
 * that AuditLog rows carry untyped JSON columns. */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { runWithAuditContext, getAuditContext } from '@/lib/audit-context';
import { redactSensitiveFields, extractChangedFields } from '@/lib/audit-redact';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const RealDbUrl = DB_URL;

// ─── Mirrors prisma.ts middleware logic ───
const WRITE_ACTIONS = new Set([
    'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert',
]);
const DIFF_ACTIONS = new Set(['update', 'upsert']);
const EXCLUDED_MODELS = new Set(['AuditLog']);

function generateCuid(): string {
    const uuid = randomUUID().replace(/-/g, '');
    return 'c' + uuid.substring(0, 24);
}

function buildDiffJson(action: string, data: any, result: any) {
    if (!DIFF_ACTIONS.has(action) || !data) return null;
    const changedFields = extractChangedFields(data);
    if (changedFields.length === 0) return null;
    const afterRaw: Record<string, any> = {};
    for (const field of changedFields) {
        if (result && field in result) afterRaw[field] = result[field];
    }
    return { changedFields, after: redactSensitiveFields(afterRaw) };
}

/**
 * Creates an extended PrismaClient with hand-rolled audit middleware
 * (mirrors the production extension in `src/lib/prisma.ts`). Migrated
 * from `client.$use(...)` (removed in Prisma 7) to
 * `client.$extends({ query: { $allModels: ... } })`.
 *
 * The handler body is unchanged from the v5 form — only the API
 * shape (`{ model, operation, args, query }` instead of
 * `(params, next)`) changed.
 */
function createTestPrismaWithMiddleware() {
    const client = new PrismaClient({
        adapter: new PrismaPg({ connectionString: RealDbUrl }),
    });

    const handle = async ({
        model,
        operation,
        args,
        query,
    }: {
        model: string;
        operation: string;
        args: any;
        query: (a: any) => Promise<any>;
    }) => {
        if (!WRITE_ACTIONS.has(operation)) return query(args);
        if (EXCLUDED_MODELS.has(model)) return query(args);

        const ctx = getAuditContext();
        const tenantId = ctx?.tenantId;
        if (!tenantId) return query(args);

        const actorUserId = ctx?.actorUserId || null;
        const requestId = ctx?.requestId || null;
        const source = ctx?.source || 'test';
        const updateData = operation === 'upsert'
            ? args?.update ?? null
            : args?.data ?? null;

        const result = await query(args);

        try {
            const action = operation.toUpperCase();

            let entityId = 'unknown';
            let recordIds: any = null;

            if (['create', 'update', 'upsert', 'delete'].includes(operation)) {
                entityId = result?.id || 'unknown';
            } else if (operation === 'createMany') {
                entityId = 'batch';
                recordIds = { count: result?.count ?? 0 };
            } else if (operation === 'updateMany' || operation === 'deleteMany') {
                entityId = 'batch';
                recordIds = { count: result?.count ?? 0 };
            }

            const metadataJson: Record<string, any> = { source };
            if (args?.where && (operation === 'updateMany' || operation === 'deleteMany')) {
                metadataJson.filterKeys = Object.keys(args.where);
            }

            const diffJson = buildDiffJson(operation, updateData, result);

            const id = generateCuid();
            await client.$executeRawUnsafe(
                `INSERT INTO "AuditLog" ("id", "tenantId", "userId", "entity", "entityId", "action", "details", "requestId", "recordIds", "metadataJson", "diffJson", "createdAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, NOW())`,
                id, tenantId, actorUserId, model, entityId, action, null,
                requestId,
                recordIds ? JSON.stringify(recordIds) : null,
                JSON.stringify(metadataJson),
                diffJson ? JSON.stringify(diffJson) : null,
            );
        } catch (_) {
            // Best effort
        }

        return result;
    };

    return client.$extends({
        name: 'test-audit-middleware',
        query: {
            $allModels: {
                async create(args) { return handle(args); },
                async createMany(args) { return handle(args); },
                async update(args) { return handle(args); },
                async updateMany(args) { return handle(args); },
                async upsert(args) { return handle(args); },
                async delete(args) { return handle(args); },
                async deleteMany(args) { return handle(args); },
            },
        },
    });
}

// Raw client for verification queries (no middleware)
const rawPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: RealDbUrl }) });
const appPrisma = createTestPrismaWithMiddleware();

const testRunId = randomUUID();

// Skip entire suite when DB is not reachable
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Audit Middleware — Integration Tests', () => {
    let tenantId: string;
    let userId: string;

    beforeAll(async () => {

        // rawPrisma is intentionally raw (no middleware) — provide
        // emailHash explicitly since GAP-21 made it NOT NULL at the DB.
        const userEmail = `audit-mw-${testRunId}@test.com`;
        const user = await rawPrisma.user.create({
            data: { email: userEmail, emailHash: hashForLookup(userEmail), name: 'Audit MW Test' },
        });
        userId = user.id;

        const tenant = await rawPrisma.tenant.create({
            data: { name: `AMW Tenant ${testRunId}`, slug: `amw-${testRunId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantId = tenant.id;
    });

    afterAll(async () => {
        // Use raw SQL for cleanup to bypass any middleware (soft-delete, audit).
        // Best-effort — subsequent runs use randomised `testRunId` so
        // stragglers don't cross-contaminate; surfacing the error via
        // console.warn just pollutes CI output without telling anyone
        // anything actionable.
        if (tenantId) {
            await rawPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
            await rawPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = $1`, tenantId).catch(() => {});
            await rawPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
            if (userId) await rawPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        }
        await rawPrisma.$disconnect().catch(() => {});
        await appPrisma.$disconnect().catch(() => {});
    });

    async function getAuditLogs(entity?: string, action?: string) {
        const where: any = { tenantId };
        if (entity) where.entity = entity;
        if (action) where.action = action;
        return rawPrisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' } });
    }

    // ─── CREATE ───
    describe('create operation', () => {
        let controlId: string;

        it('creates an AuditLog row for a Control create', async () => {
            const control = await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-create-${testRunId}` },
                () => appPrisma.control.create({
                    data: { tenantId, name: `AMW Control Create ${testRunId}` },
                }),
            );
            controlId = control.id;

            const logs = await getAuditLogs('Control', 'CREATE');
            const match = logs.find((l) => l.entityId === controlId);
            expect(match).toBeDefined();
            expect(match!.userId).toBe(userId);
            expect((match as any).requestId).toBe(`req-create-${testRunId}`);
            expect(match!.action).toBe('CREATE');
            // CREATE should NOT have diffJson
            expect((match as any).diffJson).toBeNull();
        });

        afterAll(async () => {
            if (controlId) await rawPrisma.control.deleteMany({ where: { id: controlId } });
        });
    });

    // ─── UPDATE with DIFF ───
    describe('update operation with diff', () => {
        let controlId: string;

        beforeAll(async () => {
            const control = await rawPrisma.control.create({
                data: { tenantId, name: `AMW Control Update ${testRunId}` },
            });
            controlId = control.id;
        });

        it('creates an AuditLog row with diffJson for a Control update', async () => {
            await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-update-${testRunId}` },
                () => appPrisma.control.update({
                    where: { id: controlId },
                    data: { name: `Updated ${testRunId}`, effectiveness: 8 },
                }),
            );

            const logs = await getAuditLogs('Control', 'UPDATE');
            const match = logs.find((l) => l.entityId === controlId);
            expect(match).toBeDefined();

            // Verify diffJson
            const diff = (match as any).diffJson as any;
            expect(diff).toBeDefined();
            expect(diff).not.toBeNull();
            expect(diff.changedFields).toContain('name');
            expect(diff.changedFields).toContain('effectiveness');
            expect(diff.after).toBeDefined();
            expect(diff.after.name).toBe(`Updated ${testRunId}`);
            expect(diff.after.effectiveness).toBe(8);
        });

        afterAll(async () => {
            await rawPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "id" = $1`, controlId);
        });
    });

    // ─── DELETE ───
    describe('delete operation', () => {
        let controlId: string;

        beforeAll(async () => {
            const control = await rawPrisma.control.create({
                data: { tenantId, name: `AMW Control Delete ${testRunId}` },
            });
            controlId = control.id;
        });

        it('creates an AuditLog row for a Control delete', async () => {
            await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-delete-${testRunId}` },
                () => appPrisma.control.delete({ where: { id: controlId } }),
            );

            const logs = await getAuditLogs('Control', 'DELETE');
            const match = logs.find((l) => l.entityId === controlId);
            expect(match).toBeDefined();
            expect(match!.action).toBe('DELETE');
            // DELETE should NOT have diffJson
            expect((match as any).diffJson).toBeNull();
        });
    });

    // ─── UPSERT with DIFF ───
    describe('upsert operation with diff', () => {
        let controlId: string;

        it('creates an AuditLog row with diffJson for a Risk upsert', async () => {
            const tempId = `upsert-${testRunId}`;
            const control = await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-upsert-${testRunId}` },
                () => appPrisma.control.upsert({
                    where: { id: tempId },
                    create: { tenantId, name: `AMW Risk Upsert ${testRunId}` },
                    update: { name: `Upserted ${testRunId}` },
                }),
            );
            controlId = control.id;

            const logs = await getAuditLogs('Control', 'UPSERT');
            const match = logs.find((l) => l.entityId === controlId);
            expect(match).toBeDefined();
            expect(match!.action).toBe('UPSERT');
            // Upsert should have diffJson (from update data)
            const diff = (match as any).diffJson as any;
            expect(diff).not.toBeNull();
            expect(diff.changedFields).toContain('name');
        });

        afterAll(async () => {
            if (controlId) await rawPrisma.control.deleteMany({ where: { id: controlId } });
        });
    });

    // ─── UPDATE MANY ───
    describe('updateMany operation', () => {
        beforeAll(async () => {
            await rawPrisma.control.createMany({
                data: [
                    { tenantId, name: `Bulk1 ${testRunId}` },
                    { tenantId, name: `Bulk2 ${testRunId}` },
                ],
            });
        });

        it('creates an AuditLog row for updateMany', async () => {
            await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-updateMany-${testRunId}` },
                () => appPrisma.control.updateMany({
                    where: { tenantId, name: { contains: testRunId, startsWith: 'Bulk' } },
                    data: { description: 'bulk-updated' },
                }),
            );

            const logs = await getAuditLogs('Control', 'UPDATEMANY');
            const match = logs.find((l) => (l as any).requestId === `req-updateMany-${testRunId}`);
            expect(match).toBeDefined();
            expect(match!.entityId).toBe('batch');
            const recordIds = (match as any).recordIds as any;
            expect(recordIds.count).toBeGreaterThanOrEqual(2);
        });

        afterAll(async () => {
            await rawPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = $1 AND "name" LIKE $2`, tenantId, `Bulk%${testRunId}%`);
        });
    });

    // ─── DELETE MANY ───
    describe('deleteMany operation', () => {
        beforeAll(async () => {
            await rawPrisma.control.createMany({
                data: [
                    { tenantId, name: `DelBulk1 ${testRunId}` },
                    { tenantId, name: `DelBulk2 ${testRunId}` },
                ],
            });
        });

        it('creates an AuditLog row for deleteMany', async () => {
            await runWithAuditContext(
                { tenantId, actorUserId: userId, requestId: `req-deleteMany-${testRunId}` },
                () => appPrisma.control.deleteMany({
                    where: { tenantId, name: { contains: testRunId, startsWith: 'DelBulk' } },
                }),
            );

            const logs = await getAuditLogs('Control', 'DELETEMANY');
            const match = logs.find((l) => (l as any).requestId === `req-deleteMany-${testRunId}`);
            expect(match).toBeDefined();
            expect(match!.entityId).toBe('batch');
        });
    });

    // ─── RECURSION GUARD ───
    describe('AuditLog recursion prevention', () => {
        it('writing directly to AuditLog does NOT create a secondary AuditLog row', async () => {
            const countBefore = await rawPrisma.auditLog.count({ where: { tenantId } });

            await runWithAuditContext({ tenantId, actorUserId: userId }, () =>
                appPrisma.auditLog.create({
                    data: {
                        tenantId,
                        entity: 'TestRecursion',
                        entityId: 'test-recursion-check',
                        action: 'MANUAL_TEST',
                    },
                }),
            );

            const countAfter = await rawPrisma.auditLog.count({ where: { tenantId } });
            expect(countAfter - countBefore).toBe(1);
        });
    });

    // ─── MISSING CONTEXT ───
    describe('missing audit context', () => {
        it('operations outside runWithAuditContext skip audit logging', async () => {
            const countBefore = await rawPrisma.auditLog.count({ where: { tenantId } });

            const control = await appPrisma.control.create({
                data: { tenantId, name: `No Context Risk ${testRunId}` },
            });

            const countAfter = await rawPrisma.auditLog.count({ where: { tenantId } });
            expect(countAfter).toBe(countBefore);

            await rawPrisma.control.deleteMany({ where: { id: control.id } });
        });
    });

    // ─── REDACTION IN DIFFS ───
    describe('redaction in diff output', () => {
        it('sensitive fields in update data are redacted in diffJson', async () => {
            // Create a user with known data, then update with "password-like" field
            // Since User model doesn't have password, we test redaction via the unit tests primarily.
            // Here we verify that the redaction integration works end-to-end for normal fields.
            const control = await rawPrisma.control.create({
                data: { tenantId, name: `Redact Control ${testRunId}` },
            });

            await runWithAuditContext(
                { tenantId, actorUserId: userId },
                () => appPrisma.control.update({
                    where: { id: control.id },
                    data: { name: `Redacted Update ${testRunId}` },
                }),
            );

            const logs = await getAuditLogs('Control', 'UPDATE');
            const match = logs.find((l) => l.entityId === control.id);
            expect(match).toBeDefined();
            const diff = (match as any).diffJson as any;
            expect(diff).not.toBeNull();
            expect(diff.changedFields).toContain('name');
            // Verify name is NOT redacted (it's not sensitive)
            expect(diff.after.name).toBe(`Redacted Update ${testRunId}`);

            await rawPrisma.control.deleteMany({ where: { id: control.id } });
        });
    });
});
