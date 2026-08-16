/**
 * Staging Seed — Deterministic, idempotent seed for staging environments.
 *
 * Runs the base seed (prisma/seed.ts) first, then adds staging-specific
 * demo data: tasks and evidence placeholders.
 *
 * GRC teardown phase 3: the audit-cycle and practice→requirement steps are
 * gone with their models. This script is wired to `npm run seed:staging`
 * and was calling five dropped delegates, so it died on its first
 * statement — invisible to `npm run typecheck` because `scripts/` is
 * excluded from tsconfig. It also carried three PRE-EXISTING field bugs
 * that the same exclusion hid: `assigneeId` (the field is
 * `assigneeUserId`) and `name` on Evidence (the field is `title`), plus
 * `type`/`status` values that are not in `EvidenceType`/`EvidenceStatus`
 * at all. All corrected here.
 *
 * Usage:
 *   npx tsx scripts/seed-staging.ts
 *   npm run seed:staging
 *
 * Idempotent: safe to run multiple times without duplicating data.
 */

const { PrismaClient: StagingPrismaClient } = require('@prisma/client');
const path = require('path');

const stagingPrisma = new StagingPrismaClient();

// ── Config (override via env vars) ──
const STAGING_TENANT_SLUG = process.env.STAGING_TENANT_SLUG || 'acme-corp';
const STAGING_ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL || 'admin@acme.com';
const STAGING_ADMIN_PASSWORD = process.env.STAGING_ADMIN_PASSWORD || 'password123';

async function seedStaging() {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║  Staging Seed — Agrent                   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`  Tenant: ${STAGING_TENANT_SLUG}`);
    console.log(`  Admin:  ${STAGING_ADMIN_EMAIL}\n`);

    // ── Step 1: Run base seed ──
    console.log('── Step 1: Running base seed ──────────────');
    require(path.resolve(__dirname, '../prisma/seed.ts'));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // ── Step 2: Resolve tenant and admin ──
    console.log('\n── Step 2: Staging-specific demo data ─────');
    const tenant = await stagingPrisma.tenant.findUnique({ where: { slug: STAGING_TENANT_SLUG } });
    if (!tenant) {
        console.error(`❌ Tenant "${STAGING_TENANT_SLUG}" not found. Did the base seed run?`);
        process.exit(1);
    }
    const admin = await stagingPrisma.user.findUnique({ where: { emailHash: hashForLookup(STAGING_ADMIN_EMAIL) } });
    if (!admin) {
        console.error(`❌ Admin user "${STAGING_ADMIN_EMAIL}" not found.`);
        process.exit(1);
    }

    // ── Step 3: Create demo tasks ──
    const demoTasks = [
        { title: 'Complete annual risk assessment', description: 'Perform the ISO 27001 annual risk assessment for all business units.', priority: 'HIGH', status: 'OPEN' },
        { title: 'Update access control policy', description: 'Review and update the access control policy to reflect new cloud services.', priority: 'MEDIUM', status: 'IN_PROGRESS' },
        { title: 'Schedule penetration test', description: 'Engage external vendor for Q2 penetration testing of production systems.', priority: 'HIGH', status: 'OPEN' },
        { title: 'Employee security awareness training', description: 'Deploy phishing simulation and security awareness module to all staff.', priority: 'MEDIUM', status: 'DONE' },
        { title: 'Review vendor SLAs', description: 'Audit all critical vendor SLAs for security and compliance clauses.', priority: 'LOW', status: 'OPEN' },
    ];
    for (const t of demoTasks) {
        const existing = await stagingPrisma.task.findFirst({
            where: { tenantId: tenant.id, title: t.title },
        });
        if (!existing) {
            await stagingPrisma.task.create({
                data: {
                    tenantId: tenant.id,
                    title: t.title,
                    description: t.description,
                    priority: t.priority,
                    status: t.status,
                    createdByUserId: admin.id,
                    assigneeUserId: admin.id,
                },
            });
        }
    }
    console.log(`✅ ${demoTasks.length} demo tasks seeded`);

    // ── Step 4: Create evidence placeholders ──
    // `title`, not `name`; and only values that exist in EvidenceType /
    // EvidenceStatus. The previous rows used DOCUMENT / CERTIFICATE /
    // SCREENSHOT and CURRENT — none of which are members of either enum.
    const demoEvidence = [
        { title: 'Spray record — north field', type: 'FILE', status: 'APPROVED' },
        { title: 'Soil analysis 2026', type: 'FILE', status: 'APPROVED' },
        { title: 'Seed certificate — winter wheat', type: 'FILE', status: 'SUBMITTED' },
        { title: 'Supplier delivery note', type: 'LINK', status: 'DRAFT' },
    ];
    for (const e of demoEvidence) {
        const existing = await stagingPrisma.evidence.findFirst({
            where: { tenantId: tenant.id, title: e.title },
        });
        if (!existing) {
            await stagingPrisma.evidence.create({
                data: { tenantId: tenant.id, title: e.title, type: e.type, status: e.status },
            });
        }
    }
    console.log(`✅ ${demoEvidence.length} evidence placeholders seeded`);

    // ── Summary ──
    const counts = {
        tenants: await stagingPrisma.tenant.count(),
        users: await stagingPrisma.user.count(),
        tasks: await stagingPrisma.task.count({ where: { tenantId: tenant.id } }),
        evidence: await stagingPrisma.evidence.count({ where: { tenantId: tenant.id } }),
        locations: await stagingPrisma.location.count({ where: { tenantId: tenant.id } }),
    };

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  Staging Seed Complete                   ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Tenants:      ${String(counts.tenants).padStart(4)}                     ║`);
    console.log(`║  Users:        ${String(counts.users).padStart(4)}                     ║`);
    console.log(`║  Tasks:        ${String(counts.tasks).padStart(4)}                     ║`);
    console.log(`║  Evidence:     ${String(counts.evidence).padStart(4)}                     ║`);
    console.log(`║  Locations:    ${String(counts.locations).padStart(4)}                     ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Login: ${STAGING_ADMIN_EMAIL} / ${STAGING_ADMIN_PASSWORD}    ║`);
    console.log('╚══════════════════════════════════════════╝');
}

seedStaging()
    .catch((err) => {
        console.error('❌ Staging seed failed:', err);
        process.exit(1);
    })
    .finally(() => stagingPrisma.$disconnect());
