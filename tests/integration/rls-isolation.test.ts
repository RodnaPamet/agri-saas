import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

// Skip entire suite when DB is not reachable
const describeFn = DB_AVAILABLE ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════
// CURATED LIST: tenantId-carrying tables whose RLS wiring this suite
// asserts. It is a sample, NOT the inventory — the exhaustive check
// (every tenant-scoped model in prisma/schema has RLS + FORCE RLS +
// a tenant_isolation policy, DERIVED from the schema rather than
// hand-listed) lives in tests/guardrails/rls-coverage.test.ts.
// ═══════════════════════════════════════════════════════════════════
const TENANT_SCOPED_TABLES_WITH_TENANT_ID: string[] = [
    // Core entities
    'Evidence',
    'Asset',
    // Tasks
    'Task',
    'TaskLink',
    'TaskComment',
    'TaskWatcher',
    // Audit & logging
    'AuditLog',
    // Notifications
    'Notification',
    'ReminderHistory',
    'NotificationOutbox',
    'TenantNotificationSettings',
    'UserNotificationPreference',
    // Membership & onboarding
    'TenantMembership',
    'TenantOnboarding',
    // Files
    'FileRecord',
    // Billing
    'BillingAccount',
    'BillingEvent',
];

// Tables that use USING(true) because they lack tenantId — tracked for audit.
// These MUST gain tenantId in a future migration.
//
// Epic A.1 upgraded every table previously in this bucket to an
// EXISTS-based policy (see EXISTS_POLICY_TABLES below); this list is
// intentionally empty. Keep the bucket + its test so a future addition
// that can't reach EXISTS-isolation yet is still explicitly tracked.
const DEFERRED_USING_TRUE_TABLES: string[] = [];

// Tables whose isolation is proven by an EXISTS subquery against a
// parent tenant-scoped row rather than by their own tenantId column.
//
// GRC teardown phase 3 deleted the other six members of this bucket
// together with their parents (PolicyPracticeLink, PolicyApproval,
// PolicyAcknowledgement, FindingEvidence, AuditChecklistItem,
// AuditorPackAccess). EvidenceReview is the surviving chained table:
// its policy is EXISTS(Evidence e WHERE e.id = "evidenceId" AND
// e."tenantId" = app.tenant_id).
const EXISTS_POLICY_TABLES: string[] = [
    'EvidenceReview',
];

describeFn('Postgres RLS Tenant Isolation', () => {
    const testRunId = randomUUID();
    let tenantAId: string;
    let tenantBId: string;
    let userAId: string;

    beforeAll(async () => {
        // Create a test user (User table has no RLS — global). globalPrisma
        // is intentionally raw (no middleware) so emailHash is provided
        // explicitly — GAP-21 made it NOT NULL at the DB.
        const userEmail = `rls-test-${testRunId}@test.com`;
        const userA = await globalPrisma.user.create({
            data: { email: userEmail, emailHash: hashForLookup(userEmail), name: 'RLS Test User' },
        });
        userAId = userA.id;

        // Create Tenant A and its data using global connection
        const tenantA = await globalPrisma.tenant.create({
            data: { name: 'Tenant A', slug: `tenant-a-${testRunId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantAId = tenantA.id;

        const evidenceA = await globalPrisma.evidence.create({
            data: {
                tenantId: tenantAId,
                title: `Evidence A - ${testRunId}`,
                type: 'TEXT',
                content: 'Test evidence content A',
                status: 'DRAFT',
            },
        });

        // Chained (EXISTS-policy) child of Evidence.
        await globalPrisma.evidenceReview.create({
            data: {
                tenantId: tenantAId,
                evidenceId: evidenceA.id,
                reviewerId: userAId,
                action: 'SUBMITTED',
            },
        });

        const assetA = await globalPrisma.asset.create({
            data: { tenantId: tenantAId, name: `Asset A - ${testRunId}`, type: 'TRACTOR' },
        });

        const taskA = await globalPrisma.task.create({
            data: { tenantId: tenantAId, title: `Task A - ${testRunId}`, createdByUserId: userAId },
        });

        await globalPrisma.taskComment.create({
            data: {
                tenantId: tenantAId,
                taskId: taskA.id,
                body: `Comment A - ${testRunId}`,
                createdByUserId: userAId,
            },
        });

        // Mapping row for Tenant A
        await globalPrisma.taskLink.create({
            data: { tenantId: tenantAId, taskId: taskA.id, entityType: 'ASSET', entityId: assetA.id },
        });

        // Create Tenant B
        const tenantB = await globalPrisma.tenant.create({
            data: { name: 'Tenant B', slug: `tenant-b-${testRunId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantBId = tenantB.id;

        const evidenceB = await globalPrisma.evidence.create({
            data: {
                tenantId: tenantBId,
                title: `Evidence B - ${testRunId}`,
                type: 'TEXT',
                content: 'Test evidence content B',
                status: 'DRAFT',
            },
        });

        await globalPrisma.evidenceReview.create({
            data: {
                tenantId: tenantBId,
                evidenceId: evidenceB.id,
                reviewerId: userAId, // User table is global
                action: 'SUBMITTED',
            },
        });

        const assetB = await globalPrisma.asset.create({
            data: { tenantId: tenantBId, name: `Asset B - ${testRunId}`, type: 'HARVESTER' },
        });

        const taskB = await globalPrisma.task.create({
            data: { tenantId: tenantBId, title: `Task B - ${testRunId}`, createdByUserId: userAId },
        });

        await globalPrisma.taskComment.create({
            data: {
                tenantId: tenantBId,
                taskId: taskB.id,
                body: `Comment B - ${testRunId}`,
                createdByUserId: userAId,
            },
        });

        // Mapping row for Tenant B
        await globalPrisma.taskLink.create({
            data: { tenantId: tenantBId, taskId: taskB.id, entityType: 'ASSET', entityId: assetB.id },
        });
    });

    afterAll(async () => {
        const tenantIds = [tenantAId, tenantBId].filter(Boolean);
        try {
            for (const tid of tenantIds) {
                // Clean up in dependency order (leaf → root)
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "EvidenceReview" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "TaskComment" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Evidence" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tid);
            }
            if (userAId) await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userAId);
        } catch (e) {
            console.warn('[rls-isolation] cleanup error:', e);
        }
        await globalPrisma.$disconnect();
    });

    // ═══════════════════════════════════════════════════════════════════
    // META-TEST: RLS Coverage Completeness
    // ═══════════════════════════════════════════════════════════════════

    describe('RLS Coverage Completeness', () => {
        it('all tenant-scoped tables have RLS enabled in the database', async () => {
            // Query pg_class to see which tables have RLS enabled
            const result: Array<{ tablename: string; rowsecurity: boolean }> = await globalPrisma.$queryRaw`
                SELECT c.relname AS "tablename", c.relrowsecurity AS "rowsecurity"
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                ORDER BY c.relname
            `;

            const rlsMap = new Map(result.map(r => [r.tablename, r.rowsecurity]));

            const missingRLS: string[] = [];
            for (const table of TENANT_SCOPED_TABLES_WITH_TENANT_ID) {
                if (!rlsMap.has(table)) {
                    // Table doesn't exist yet (pending migration) — skip
                    continue;
                }
                if (!rlsMap.get(table)) {
                    missingRLS.push(table);
                }
            }

            expect(missingRLS).toEqual([]);
        });

        it('all tenant-scoped tables have FORCE RLS enabled', async () => {
            const result: Array<{ tablename: string; forcerowsecurity: boolean }> = await globalPrisma.$queryRaw`
                SELECT c.relname AS "tablename", c.relforcerowsecurity AS "forcerowsecurity"
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'r'
                ORDER BY c.relname
            `;

            const forceMap = new Map(result.map(r => [r.tablename, r.forcerowsecurity]));

            const missingForce: string[] = [];
            for (const table of TENANT_SCOPED_TABLES_WITH_TENANT_ID) {
                if (!forceMap.has(table)) continue;
                if (!forceMap.get(table)) {
                    missingForce.push(table);
                }
            }

            expect(missingForce).toEqual([]);
        });

        it('all tenant-scoped tables have a tenant_isolation policy (not allow_all)', async () => {
            const result: Array<{ tablename: string; policyname: string; qual: string | null }> = await globalPrisma.$queryRaw`
                SELECT p.tablename, p.policyname, p.qual
                FROM pg_policies p
                WHERE p.schemaname = 'public'
                ORDER BY p.tablename, p.policyname
            `;

            const policyMap = new Map<string, string[]>();
            for (const row of result) {
                if (!policyMap.has(row.tablename)) policyMap.set(row.tablename, []);
                policyMap.get(row.tablename)!.push(row.policyname);
            }

            const insecureTables: string[] = [];
            for (const table of TENANT_SCOPED_TABLES_WITH_TENANT_ID) {
                const policies = policyMap.get(table);
                if (!policies) continue; // table doesn't exist yet
                // Should have 'tenant_isolation' — NOT 'allow_all'
                const hasProperPolicy = policies.includes('tenant_isolation');
                const hasAllowAll = policies.includes('allow_all');
                if (!hasProperPolicy || hasAllowAll) {
                    insecureTables.push(table);
                }
            }

            expect(insecureTables).toEqual([]);
        });

        it('deferred (no-tenantId) tables have RLS enabled with allow_all (tracked)', async () => {
            const result: Array<{ tablename: string; policyname: string }> = await globalPrisma.$queryRaw`
                SELECT p.tablename, p.policyname
                FROM pg_policies p
                WHERE p.schemaname = 'public'
                ORDER BY p.tablename, p.policyname
            `;

            const policyMap = new Map<string, string[]>();
            for (const row of result) {
                if (!policyMap.has(row.tablename)) policyMap.set(row.tablename, []);
                policyMap.get(row.tablename)!.push(row.policyname);
            }

            const untracked: string[] = [];
            for (const table of DEFERRED_USING_TRUE_TABLES) {
                const policies = policyMap.get(table);
                if (!policies) continue;
                if (!policies.includes('allow_all')) {
                    untracked.push(table);
                }
            }

            // All deferred tables should have allow_all (meaning they're tracked but awaiting migration)
            expect(untracked).toEqual([]);
        });

        it('EXISTS-based policy tables have tenant_isolation (not allow_all)', async () => {
            const result: Array<{ tablename: string; policyname: string }> = await globalPrisma.$queryRaw`
                SELECT p.tablename, p.policyname
                FROM pg_policies p
                WHERE p.schemaname = 'public'
                ORDER BY p.tablename, p.policyname
            `;

            const policyMap = new Map<string, string[]>();
            for (const row of result) {
                if (!policyMap.has(row.tablename)) policyMap.set(row.tablename, []);
                policyMap.get(row.tablename)!.push(row.policyname);
            }

            const badTables: string[] = [];
            for (const table of EXISTS_POLICY_TABLES) {
                const policies = policyMap.get(table);
                if (!policies) continue;
                // Should have 'tenant_isolation', NOT 'allow_all'
                if (!policies.includes('tenant_isolation') || policies.includes('allow_all')) {
                    badTables.push(table);
                }
            }

            expect(badTables).toEqual([]);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Evidence Table
    // ═══════════════════════════════════════════════════════════════════

    describe('Evidence SELECT Isolation', () => {
        it('Tenant A context only sees its own evidence', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const evidence = await tx.evidence.findMany({
                    where: { title: { contains: testRunId } }
                });

                expect(evidence.length).toBe(1);
                expect(evidence[0].title).toBe(`Evidence A - ${testRunId}`);
                expect(evidence[0].tenantId).toBe(tenantAId);
            }, globalPrisma);
        });

        it('Tenant B context only sees its own evidence', async () => {
            await withTenantDb(tenantBId, async (tx) => {
                const evidence = await tx.evidence.findMany({
                    where: { title: { contains: testRunId } }
                });

                expect(evidence.length).toBe(1);
                expect(evidence[0].title).toBe(`Evidence B - ${testRunId}`);
                expect(evidence[0].tenantId).toBe(tenantBId);
            }, globalPrisma);
        });
    });

    describe('Evidence INSERT Isolation', () => {
        it('Cannot insert evidence under Tenant B while in Tenant A context', async () => {
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.evidence.create({
                        data: {
                            tenantId: tenantBId,
                            title: `Malicious Evidence Insert - ${Date.now()}`,
                            type: 'TEXT',
                            content: 'Malicious evidence content',
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Asset Table
    // ═══════════════════════════════════════════════════════════════════

    describe('Asset SELECT Isolation', () => {
        it('Tenant A context only sees its own assets', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const assets = await tx.asset.findMany({
                    where: { name: { contains: testRunId } }
                });

                expect(assets.length).toBe(1);
                expect(assets[0].name).toBe(`Asset A - ${testRunId}`);
                expect(assets[0].tenantId).toBe(tenantAId);
            }, globalPrisma);
        });
    });

    describe('Asset INSERT Isolation', () => {
        it('Cannot insert an asset under Tenant B while in Tenant A context', async () => {
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.asset.create({
                        data: {
                            tenantId: tenantBId,
                            name: `Malicious Asset - ${Date.now()}`,
                            type: 'TRACTOR',
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // TaskComment Table (tenant-scoped child of Task)
    // ═══════════════════════════════════════════════════════════════════

    describe('TaskComment SELECT Isolation', () => {
        it('Tenant A context only sees its own task comments', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const comments = await tx.taskComment.findMany();
                // We created exactly 1 task comment for tenant A
                expect(comments.length).toBeGreaterThan(0);
                for (const comment of comments) {
                    expect(comment.tenantId).toBe(tenantAId);
                }
            }, globalPrisma);
        });
    });

    describe('TaskComment INSERT Isolation', () => {
        it('Cannot insert a task comment under Tenant B while in Tenant A context', async () => {
            const taskB = await globalPrisma.task.findFirst({
                where: { tenantId: tenantBId, title: { contains: testRunId } }
            });

            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.taskComment.create({
                        data: {
                            tenantId: tenantBId,
                            taskId: taskB!.id,
                            body: 'Malicious comment',
                            createdByUserId: userAId,
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // MAPPING TABLE: TaskLink (tenantId-based)
    // ═══════════════════════════════════════════════════════════════════

    describe('TaskLink Mapping Isolation', () => {
        it('Tenant A sees only its own task links', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const links = await tx.taskLink.findMany();
                for (const link of links) {
                    expect(link.tenantId).toBe(tenantAId);
                }
                expect(links.length).toBeGreaterThan(0);
            }, globalPrisma);
        });

        it('Cannot create TaskLink with Tenant B tenantId from Tenant A context', async () => {
            const taskA = await globalPrisma.task.findFirst({ where: { tenantId: tenantAId, title: { contains: testRunId } } });
            const assetB = await globalPrisma.asset.findFirst({ where: { tenantId: tenantBId, name: { contains: testRunId } } });

            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.taskLink.create({
                        data: { tenantId: tenantBId, taskId: taskA!.id, entityType: 'ASSET', entityId: assetB!.id },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // CHAINED TABLE: EvidenceReview (EXISTS-based policy on its parent)
    // ═══════════════════════════════════════════════════════════════════

    describe('EvidenceReview Chained Isolation', () => {
        it('Tenant A sees only reviews of its own evidence', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const reviews = await tx.evidenceReview.findMany();
                // Each review should reference evidence belonging to Tenant A
                for (const review of reviews) {
                    const evidence = await globalPrisma.evidence.findUnique({ where: { id: review.evidenceId } });
                    expect(evidence!.tenantId).toBe(tenantAId);
                }
                expect(reviews.length).toBeGreaterThan(0);
            }, globalPrisma);
        });

        it('Tenant B cannot see Tenant A evidence reviews', async () => {
            const evidenceA = await globalPrisma.evidence.findFirst({ where: { tenantId: tenantAId, title: { contains: testRunId } } });

            await withTenantDb(tenantBId, async (tx) => {
                const reviews = await tx.evidenceReview.findMany({
                    where: { evidenceId: evidenceA!.id },
                });
                // Should see zero — RLS blocks access via EXISTS on Evidence
                expect(reviews.length).toBe(0);
            }, globalPrisma);
        });

        it('Cannot insert an EvidenceReview pointing to Tenant B evidence from Tenant A context', async () => {
            const evidenceB = await globalPrisma.evidence.findFirst({ where: { tenantId: tenantBId, title: { contains: testRunId } } });

            // denorm-tenantId — rejection can land via the composite
            // (evidenceId, tenantId) → Evidence(id, tenantId) FK rather
            // than the chained RLS WITH CHECK. Either rejection shape is
            // acceptable.
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.evidenceReview.create({
                        data: {
                            tenantId: tenantAId,
                            evidenceId: evidenceB!.id,
                            reviewerId: userAId,
                            action: 'SUBMITTED',
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/(violates row-level security policy|[Ff]oreign key constraint (?:violated|violation))/);
        });
    });

    // Deleted with teardown phase 3: the "nullable tenantId — a tenant sees
    // GLOBAL rows plus its own, never another tenant's" pair. Its subject was
    // Practice, whose model is gone; the surviving nullable-tenantId tables
    // (KnowledgeArticle / KnowledgeArticleVersion, same asymmetric
    // USING(tenantId IS NULL OR own) / WITH CHECK(own) policy) already have a
    // dedicated suite at tests/integration/knowledge-article-rls.test.ts.

    // ═══════════════════════════════════════════════════════════════════
    // No Context Edge Case
    // ═══════════════════════════════════════════════════════════════════

});
