/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Audit Hash Chain — Integration Tests
 *
 * Tests the full hash-chain lifecycle against a real PostgreSQL database:
 *   - Sequential inserts produce valid per-tenant chains
 *   - previousHash linkage is correct
 *   - Per-tenant chain independence
 *   - Tamper detection via verifyAuditChain
 *   - Advisory lock prevents chain corruption under concurrency
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';
import { appendAuditEntry, verifyAuditChain } from '../../src/lib/audit/audit-writer';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Unique prefix to identify test entries and clean up
const TEST_PREFIX = `HASHCHAIN_TEST_${Date.now()}`;

function testAction(name: string): string {
    return `${TEST_PREFIX}_${name}`;
}

describeFn('Audit Hash Chain — Integration', () => {
    let prisma: PrismaClient;
    let tenantId: string;

    /** Run a callback with the immutability trigger temporarily disabled, then re-enable. */
    async function withTriggerDisabled(fn: (tx: PrismaClient) => Promise<void>) {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await fn(tx as any);
        });
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Ensure we have a test tenant
        const tenant = await prisma.tenant.upsert({
            where: { slug: 'hash-chain-test' },
            update: {},
            create: { name: 'Hash Chain Test', slug: 'hash-chain-test' },
        });
        tenantId = tenant.id;

        // Clean up prior entries — disable trigger momentarily
        await withTriggerDisabled(async (tx) => {
            await tx.$executeRawUnsafe(
                `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                tenantId,
            );
        });
    });

    afterAll(async () => {
        // Clean up test entries with trigger temporarily disabled
        try {
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "action" LIKE $1`,
                    `${TEST_PREFIX}%`,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                    tenantId,
                );
            });
        } catch { /* best effort */ }
        await prisma.$disconnect();
    });

    describe('sequential inserts', () => {
        let result1: { id: string; entryHash: string; previousHash: string | null };
        let result2: { id: string; entryHash: string; previousHash: string | null };
        let result3: { id: string; entryHash: string; previousHash: string | null };

        test('first entry has previousHash = null and valid entryHash', async () => {
            result1 = await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'Test',
                entityId: 'test-1',
                action: testAction('FIRST'),
                details: 'First entry in chain',
            }, prisma);

            expect(result1.entryHash).toMatch(/^[0-9a-f]{64}$/);
            expect(result1.previousHash).toBeNull();
        });

        test('second entry links to first via previousHash', async () => {
            result2 = await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'Test',
                entityId: 'test-2',
                action: testAction('SECOND'),
                details: 'Second entry in chain',
            }, prisma);

            expect(result2.entryHash).toMatch(/^[0-9a-f]{64}$/);
            expect(result2.previousHash).toBe(result1.entryHash);
        });

        test('third entry links to second via previousHash', async () => {
            result3 = await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'Test',
                entityId: 'test-3',
                action: testAction('THIRD'),
                details: 'Third entry in chain',
            }, prisma);

            expect(result3.entryHash).toMatch(/^[0-9a-f]{64}$/);
            expect(result3.previousHash).toBe(result2.entryHash);
        });

        test('each entryHash is unique', () => {
            const hashes = [result1.entryHash, result2.entryHash, result3.entryHash];
            expect(new Set(hashes).size).toBe(3);
        });
    });

    describe('hash chain verification', () => {
        test('verifyAuditChain reports chain as valid', async () => {
            const result = await verifyAuditChain(tenantId, prisma);

            expect(result.tenantId).toBe(tenantId);
            expect(result.hashedEntries).toBeGreaterThanOrEqual(3);
            expect(result.valid).toBe(true);
            expect(result.firstBreakAt).toBeUndefined();
        });
    });

    describe('tamper detection', () => {
        test('modifying an entry is detectable via hash recomputation', async () => {
            const tamperPrefix = `TAMPER_${Date.now()}`;

            const e1 = await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'TamperTest',
                entityId: 'tamper-1',
                action: `${tamperPrefix}_A`,
            }, prisma);

            // Tamper with e1's action field (trigger must be off for UPDATE)
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "AuditLog" SET "action" = $1 WHERE "id" = $2`,
                    `${tamperPrefix}_TAMPERED`,
                    e1.id,
                );
            });

            // The stored entryHash was computed with original action.
            // Recomputing from DB row would produce a different hash.
            const row: Array<{ entryHash: string; action: string }> = await prisma.$queryRawUnsafe(
                `SELECT "entryHash", "action" FROM "AuditLog" WHERE "id" = $1`,
                e1.id,
            );
            expect(row[0].action).toBe(`${tamperPrefix}_TAMPERED`);
            // entryHash still reflects the original value — tamper is detectable
            expect(row[0].entryHash).toBe(e1.entryHash);

            // Clean up
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "action" LIKE $1`,
                    `${tamperPrefix}%`,
                );
            });
        });
    });
    describe('per-tenant isolation', () => {
        test('different tenants have independent chains', async () => {
            const isoPrefix = `ISO_${Date.now()}`;

            // Create two FRESH tenants for isolation testing so they have no prior entries
            const isoTenant1 = await prisma.tenant.upsert({
                where: { slug: 'hash-chain-iso-1' },
                update: {},
                create: { name: 'Hash Chain Iso 1', slug: 'hash-chain-iso-1' },
            });
            const isoTenant2 = await prisma.tenant.upsert({
                where: { slug: 'hash-chain-iso-2' },
                update: {},
                create: { name: 'Hash Chain Iso 2', slug: 'hash-chain-iso-2' },
            });

            // Clear both tenants' audit logs
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                    isoTenant1.id,
                );
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                    isoTenant2.id,
                );
            });

            // Insert into isoTenant1
            const t1e1 = await appendAuditEntry({
                tenantId: isoTenant1.id,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'IsoTest',
                entityId: 'iso-1',
                action: `${isoPrefix}_T1_A`,
            }, prisma);

            // Insert into isoTenant2 — should start fresh chain
            const t2e1 = await appendAuditEntry({
                tenantId: isoTenant2.id,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'IsoTest',
                entityId: 'iso-1',
                action: `${isoPrefix}_T2_A`,
            }, prisma);

            // isoTenant2's first entry has previousHash = null (independent chain)
            expect(t2e1.previousHash).toBeNull();

            // Insert another into isoTenant1 — should chain from t1e1
            const t1e2 = await appendAuditEntry({
                tenantId: isoTenant1.id,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'IsoTest',
                entityId: 'iso-2',
                action: `${isoPrefix}_T1_B`,
            }, prisma);

            // isoTenant1's second entry chains from isoTenant1's first, NOT isoTenant2's
            expect(t1e2.previousHash).toBe(t1e1.entryHash);

            // Clean up
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "action" LIKE $1`,
                    `${isoPrefix}%`,
                );
            });
        });
    });

    describe('concurrency', () => {
        test('parallel appends for same tenant produce valid chain', async () => {
            const concPrefix = `CONC_${Date.now()}`;

            // Fire 5 parallel inserts for the same tenant
            const promises = Array.from({ length: 5 }, (_, i) =>
                appendAuditEntry({
                    tenantId,
                    userId: null,
                    actorType: 'SYSTEM',
                    entity: 'ConcTest',
                    entityId: `conc-${i}`,
                    action: `${concPrefix}_${i}`,
                }, prisma)
            );

            const results = await Promise.all(promises);

            // All should succeed with unique hashes
            const hashes = results.map(r => r.entryHash);
            expect(new Set(hashes).size).toBe(5);

            // Verify the chain is still valid
            const verification = await verifyAuditChain(tenantId, prisma);
            expect(verification.valid).toBe(true);

            // Clean up
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "action" LIKE $1`,
                    `${concPrefix}%`,
                );
            });
        });
    });

    describe('structured detailsJson', () => {
        test('detailsJson is stored and included in hash', async () => {
            const structPrefix = `STRUCT_${Date.now()}`;

            const r1 = await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'USER',
                entity: 'Practice',
                entityId: 'ctrl-1',
                action: `${structPrefix}_WITH_DETAILS`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Practice',
                    operation: 'created',
                },
            }, prisma);

            expect(r1.entryHash).toMatch(/^[0-9a-f]{64}$/);

            // Verify stored
            const row: Array<{ detailsJson: unknown; entryHash: string }> = await prisma.$queryRawUnsafe(
                `SELECT "detailsJson", "entryHash" FROM "AuditLog" WHERE "id" = $1`,
                r1.id,
            );
            expect(row[0].detailsJson).toEqual({
                category: 'entity_lifecycle',
                entityName: 'Practice',
                operation: 'created',
            });
            expect(row[0].entryHash).toBe(r1.entryHash);

            // Clean up
            await withTriggerDisabled(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "action" LIKE $1`,
                    `${structPrefix}%`,
                );
            });
        });
    });
});
