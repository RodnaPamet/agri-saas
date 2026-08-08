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
// CANONICAL LIST: every Prisma table that MUST have tenantId-based RLS.
// If a table is added to the schema with tenantId, add it here too.
// ═══════════════════════════════════════════════════════════════════
const TENANT_SCOPED_TABLES_WITH_TENANT_ID: string[] = [
    // Core entities
    'Policy',
    'PolicyVersion',
    'Evidence',
    'Control',
    'Asset',
    'Audit',
    'Finding',
    // Tasks
    'Task',
    'TaskLink',
    'TaskComment',
    'TaskWatcher',
    // Control sub-entities
    'ControlTask',
    'ControlEvidenceLink',
    'ControlRequirementLink',
    // Mapping/junction tables
    'ControlAsset',
    // Clause tracker
    'ClauseProgress',
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
    // Vendor management
    'Vendor',
    'VendorContact',
    'VendorDocument',
    'VendorAssessment',
    'VendorAssessmentAnswer',
    'VendorLink',
    'VendorEvidenceBundle',
    'VendorEvidenceBundleItem',
    'VendorRelationship',
    // Audit readiness
    'AuditCycle',
    'AuditPack',
    'AuditPackItem',
    'AuditPackShare',
    'AuditorAccount',
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

// Tables that use EXISTS-based RLS policies (no tenantId column, but proper
// tenant isolation via subquery against parent tenant-scoped tables).
const EXISTS_POLICY_TABLES: string[] = [
    'PolicyControlLink',
    // Epic A.1 — promoted from DEFERRED_USING_TRUE_TABLES. Each uses an
    // EXISTS subquery against its tenant-scoped parent row:
    'PolicyApproval',
    'PolicyAcknowledgement',
    'EvidenceReview',
    'FindingEvidence',
    'AuditChecklistItem',
    'AuditorPackAccess',
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

        const policyA = await globalPrisma.policy.create({
            data: {
                tenantId: tenantAId,
                title: `Policy A - ${testRunId}`,
                slug: `policy-a-${testRunId}`,
            },
        });

        await globalPrisma.policyVersion.create({
            data: {
                tenantId: tenantAId,
                policyId: policyA.id,
                versionNumber: 1,
                createdById: userAId,
            },
        });

        // Use raw SQL for Evidence to avoid Prisma Client trying to SELECT
        // the ownerUserId column which may not exist in the DB yet (pending migration).
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Evidence" ("id", "tenantId", "title", "type", "content", "status", "dateCollected", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, 'TEXT', $3, 'DRAFT', NOW(), NOW(), NOW())`,
            tenantAId,
            `Evidence A - ${testRunId}`,
            'Test evidence content A',
        );

        await globalPrisma.vendor.create({
            data: {
                tenantId: tenantAId,
                name: `Vendor A - ${testRunId}`,
            },
        });

        await globalPrisma.audit.create({
            data: {
                tenantId: tenantAId,
                title: `Audit A - ${testRunId}`,
            },
        });

        const controlA = await globalPrisma.control.create({
            data: { tenantId: tenantAId, name: `Control A - ${testRunId}`, status: 'IMPLEMENTED' },
        });

        const assetA = await globalPrisma.asset.create({
            data: { tenantId: tenantAId, name: `Asset A - ${testRunId}`, type: 'TRACTOR' },
        });

        // Create mapping rows for Tenant A
        await globalPrisma.controlAsset.create({
            data: { tenantId: tenantAId, controlId: controlA.id, assetId: assetA.id },
        });

        await globalPrisma.policyControlLink.create({
            data: { tenantId: tenantAId, policyId: policyA.id, controlId: controlA.id },
        });

        // Create Tenant B
        const tenantB = await globalPrisma.tenant.create({
            data: { name: 'Tenant B', slug: `tenant-b-${testRunId}`, industry: 'Technology', maxRiskScale: 5 },
        });
        tenantBId = tenantB.id;

        const policyB = await globalPrisma.policy.create({
            data: {
                tenantId: tenantBId,
                title: `Policy B - ${testRunId}`,
                slug: `policy-b-${testRunId}`,
            },
        });

        await globalPrisma.policyVersion.create({
            data: {
                tenantId: tenantBId,
                policyId: policyB.id,
                versionNumber: 1,
                createdById: userAId, // User table is global
            },
        });

        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Evidence" ("id", "tenantId", "title", "type", "content", "status", "dateCollected", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, 'TEXT', $3, 'DRAFT', NOW(), NOW(), NOW())`,
            tenantBId,
            `Evidence B - ${testRunId}`,
            'Test evidence content B',
        );

        await globalPrisma.vendor.create({
            data: {
                tenantId: tenantBId,
                name: `Vendor B - ${testRunId}`,
            },
        });

        await globalPrisma.audit.create({
            data: {
                tenantId: tenantBId,
                title: `Audit B - ${testRunId}`,
            },
        });

        const controlB = await globalPrisma.control.create({
            data: { tenantId: tenantBId, name: `Control B - ${testRunId}`, status: 'PLANNED' },
        });

        const assetB = await globalPrisma.asset.create({
            data: { tenantId: tenantBId, name: `Asset B - ${testRunId}`, type: 'HARVESTER' },
        });

        // Create mapping rows for Tenant B
        await globalPrisma.controlAsset.create({
            data: { tenantId: tenantBId, controlId: controlB.id, assetId: assetB.id },
        });

        await globalPrisma.policyControlLink.create({
            data: { tenantId: tenantBId, policyId: policyB.id, controlId: controlB.id },
        });
    });

    afterAll(async () => {
        const tenantIds = [tenantAId, tenantBId].filter(Boolean);
        try {
            for (const tid of tenantIds) {
                // Clean up in dependency order (leaf → root)
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "PolicyControlLink" WHERE "policyId" IN (SELECT id FROM "Policy" WHERE "tenantId" = $1)`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "ControlAsset" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Audit" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Vendor" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Evidence" WHERE "tenantId" = $1`, tid);
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Policy" WHERE "tenantId" = $1`, tid);
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
    // Policy Table
    // ═══════════════════════════════════════════════════════════════════

    describe('Policy SELECT Isolation', () => {
        it('Tenant A context only sees its own policies', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const policies = await tx.policy.findMany({
                    where: { title: { contains: testRunId } }
                });

                expect(policies.length).toBe(1);
                expect(policies[0].title).toBe(`Policy A - ${testRunId}`);
                expect(policies[0].tenantId).toBe(tenantAId);
            }, globalPrisma);
        });
    });

    describe('Policy INSERT Isolation', () => {
        it('Cannot insert a policy under Tenant B while in Tenant A context', async () => {
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.policy.create({
                        data: {
                            tenantId: tenantBId,
                            title: 'Malicious Policy Insert',
                            slug: `malicious-${Date.now()}`,
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    describe('PolicyVersion SELECT Isolation', () => {
        it('Tenant A context only sees its own policy versions', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const versions = await tx.policyVersion.findMany();
                // We created exactly 1 policy version for tenant A
                expect(versions.length).toBeGreaterThan(0);
                for (const version of versions) {
                    expect(version.tenantId).toBe(tenantAId);
                }
            }, globalPrisma);
        });
    });

    describe('PolicyVersion INSERT Isolation', () => {
        it('Cannot insert a policy version under Tenant B while in Tenant A context', async () => {
            const policyB = await globalPrisma.policy.findFirst({
                where: { tenantId: tenantBId, title: { contains: testRunId } }
            });

            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.policyVersion.create({
                        data: {
                            tenantId: tenantBId,
                            policyId: policyB!.id,
                            versionNumber: 999,
                            createdById: userAId,
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Evidence Table
    // ═══════════════════════════════════════════════════════════════════

    describe('Evidence SELECT Isolation', () => {
        it('Tenant B context only sees its own evidence', async () => {
            await withTenantDb(tenantBId, async (tx) => {
                // Use raw SQL to avoid Prisma Client column mismatch on ownerUserId
                const evidence: Array<{ title: string; tenantId: string }> = await tx.$queryRawUnsafe(
                    `SELECT "title", "tenantId" FROM "Evidence" WHERE "title" LIKE $1`,
                    `%${testRunId}%`,
                );

                expect(evidence.length).toBe(1);
                expect(evidence[0].title).toBe(`Evidence B - ${testRunId}`);
                expect(evidence[0].tenantId).toBe(tenantBId);
            }, globalPrisma);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Control Table (nullable tenantId)
    // ═══════════════════════════════════════════════════════════════════

    describe('Control with nullable tenantId', () => {
        let globalControlId: string;
        let tenantAControlId: string;

        beforeAll(async () => {
            const globalCtrl = await globalPrisma.control.create({
                data: { name: `Global Control - ${testRunId}`, status: 'IMPLEMENTED' },
            });
            globalControlId = globalCtrl.id;

            const tenantCtrl = await globalPrisma.control.create({
                data: { tenantId: tenantAId, name: `TenantA Control - ${testRunId}`, status: 'PLANNED' },
            });
            tenantAControlId = tenantCtrl.id;
        });

        afterAll(async () => {
            for (const ctrlId of [globalControlId, tenantAControlId].filter(Boolean)) {
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "id" = $1`, ctrlId);
            }
        });

        it('Tenant A can see both global (null tenantId) and its own controls', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const controls = await tx.control.findMany({
                    where: { name: { contains: testRunId } },
                });

                const names = controls.map(c => c.name);
                expect(names).toContain(`Global Control - ${testRunId}`);
                expect(names).toContain(`TenantA Control - ${testRunId}`);
            }, globalPrisma);
        });

        it('Tenant B can see global controls but NOT Tenant A-specific controls', async () => {
            await withTenantDb(tenantBId, async (tx) => {
                const controls = await tx.control.findMany({
                    where: { name: { contains: testRunId } },
                });

                const names = controls.map(c => c.name);
                expect(names).toContain(`Global Control - ${testRunId}`);
                expect(names).not.toContain(`TenantA Control - ${testRunId}`);
            }, globalPrisma);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Vendor Table (NEW)
    // ═══════════════════════════════════════════════════════════════════

    describe('Vendor SELECT Isolation', () => {
        it('Tenant A context only sees its own vendors', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const vendors = await tx.vendor.findMany({
                    where: { name: { contains: testRunId } }
                });

                expect(vendors.length).toBe(1);
                expect(vendors[0].name).toBe(`Vendor A - ${testRunId}`);
                expect(vendors[0].tenantId).toBe(tenantAId);
            }, globalPrisma);
        });

        it('Tenant B context only sees its own vendors', async () => {
            await withTenantDb(tenantBId, async (tx) => {
                const vendors = await tx.vendor.findMany({
                    where: { name: { contains: testRunId } }
                });

                expect(vendors.length).toBe(1);
                expect(vendors[0].name).toBe(`Vendor B - ${testRunId}`);
                expect(vendors[0].tenantId).toBe(tenantBId);
            }, globalPrisma);
        });
    });

    describe('Vendor INSERT Isolation', () => {
        it('Cannot insert a vendor under Tenant B while in Tenant A context', async () => {
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.vendor.create({
                        data: {
                            tenantId: tenantBId,
                            name: `Malicious Vendor - ${Date.now()}`,
                        },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Audit Table (NEW)
    // ═══════════════════════════════════════════════════════════════════

    describe('Audit SELECT Isolation', () => {
        it('Tenant A context only sees its own audits', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const audits = await tx.audit.findMany({
                    where: { title: { contains: testRunId } }
                });

                expect(audits.length).toBe(1);
                expect(audits[0].title).toBe(`Audit A - ${testRunId}`);
                expect(audits[0].tenantId).toBe(tenantAId);
            }, globalPrisma);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // MAPPING TABLE: ControlAsset (tenantId-based)
    // ═══════════════════════════════════════════════════════════════════

    describe('ControlAsset Mapping Isolation', () => {
        it('Tenant A sees only its own control-asset links', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const links = await tx.controlAsset.findMany();
                for (const link of links) {
                    expect(link.tenantId).toBe(tenantAId);
                }
                expect(links.length).toBeGreaterThan(0);
            }, globalPrisma);
        });

        it('Cannot create ControlAsset with Tenant B tenantId from Tenant A context', async () => {
            const controlA = await globalPrisma.control.findFirst({ where: { tenantId: tenantAId, name: { contains: testRunId } } });
            const assetB = await globalPrisma.asset.findFirst({ where: { tenantId: tenantBId, name: { contains: testRunId } } });

            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.controlAsset.create({
                        data: { tenantId: tenantBId, controlId: controlA!.id, assetId: assetB!.id },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/new row violates row-level security policy/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // MAPPING TABLE: PolicyControlLink (EXISTS-based — no tenantId)
    // ═══════════════════════════════════════════════════════════════════

    describe('PolicyControlLink Mapping Isolation', () => {
        it('Tenant A sees only links to its own policies', async () => {
            await withTenantDb(tenantAId, async (tx) => {
                const links = await tx.policyControlLink.findMany();
                // Each link should reference a policy belonging to Tenant A
                for (const link of links) {
                    const policy = await globalPrisma.policy.findUnique({ where: { id: link.policyId } });
                    expect(policy!.tenantId).toBe(tenantAId);
                }
                expect(links.length).toBeGreaterThan(0);
            }, globalPrisma);
        });

        it('Tenant B cannot see Tenant A policy-control links', async () => {
            const policyA = await globalPrisma.policy.findFirst({ where: { tenantId: tenantAId, title: { contains: testRunId } } });

            await withTenantDb(tenantBId, async (tx) => {
                const links = await tx.policyControlLink.findMany({
                    where: { policyId: policyA!.id },
                });
                // Should see zero — RLS blocks access via EXISTS on Policy
                expect(links.length).toBe(0);
            }, globalPrisma);
        });

        it('Cannot insert PolicyControlLink pointing to Tenant B policy from Tenant A context', async () => {
            const policyB = await globalPrisma.policy.findFirst({ where: { tenantId: tenantBId, title: { contains: testRunId } } });
            const controlA = await globalPrisma.control.findFirst({ where: { tenantId: tenantAId, name: { contains: testRunId } } });

            // denorm-tenantId — rejection now lands via the composite
            // (policyId, tenantId) → Policy(id, tenantId) FK rather
            // than the chained RLS WITH CHECK. Either rejection
            // shape is acceptable.
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.policyControlLink.create({
                        data: { tenantId: tenantAId, policyId: policyB!.id, controlId: controlA!.id },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/(violates row-level security policy|[Ff]oreign key constraint (?:violated|violation))/);
        });

        it('Cannot insert PolicyControlLink pointing to Tenant B control from Tenant A context', async () => {
            const policyA = await globalPrisma.policy.findFirst({ where: { tenantId: tenantAId, title: { contains: testRunId } } });
            const controlB = await globalPrisma.control.findFirst({ where: { tenantId: tenantBId, name: { contains: testRunId } } });

            // Control-side single-column FK doesn't enforce tenant
            // equality (Control.tenantId is nullable for global
            // controls). Rejection here comes from Control's own RLS
            // FORCE ROW LEVEL SECURITY: under tenant-A's session,
            // Control.id=controlB.id is invisible, so the FK
            // resolution returns 0 rows.
            await expect(
                withTenantDb(tenantAId, async (tx) => {
                    await tx.policyControlLink.create({
                        data: { tenantId: tenantAId, policyId: policyA!.id, controlId: controlB!.id },
                    });
                }, globalPrisma)
            ).rejects.toThrow(/(violates row-level security policy|[Ff]oreign key constraint (?:violated|violation))/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // No Context Edge Case
    // ═══════════════════════════════════════════════════════════════════

});
