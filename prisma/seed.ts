import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { seedDefaultSeason } from '@/app-layer/usecases/planning-defaults';
import { hashForLookup } from '@/lib/security/encryption';
import { seedDefaultOrgDashboard } from '@/app-layer/usecases/org-dashboard-presets';
import type { RequestContext } from '@/app-layer/types';
import { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';
import { createLocation } from '@/app-layer/usecases/location';
import { createParcel, type CreateParcelInput } from '@/app-layer/usecases/parcel';
import { importUnits } from '../scripts/import-units';
import { seedAgriEvents } from '../scripts/seed-agri-events';
import { seedPromotions } from '../scripts/seed-promotions';

// Prisma 7 — adapter is required for PrismaClient construction.
const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL ?? '',
    }),
});

async function main() {
    console.log('🌱 Seeding Inflect Compliance database...');

    // ─── Users (no role/tenantId — membership is sole authority) ───
    //
    // Pre-create the admin user BEFORE calling `createTenantWithOwner`
    // below. The usecase upserts the owner email (find-or-create); when
    // it finds an existing row it reuses it without overwriting fields.
    // Pre-creating with the password hash + name preserves credentials
    // login + the friendly display name on the OWNER user that the
    // production tenant-creation path otherwise leaves blank.
    // B9 — the demo password is overridable via SEED_PASSWORD; the
    // literal is the well-known local-dev default (prod users are
    // provisioned via OAuth, never this seed). Tests/CI leave it unset
    // so the default holds.
    const seedPassword = process.env.SEED_PASSWORD || 'password123';
    const pwd = await bcrypt.hash(seedPassword, 10);

    const admin = await prisma.user.upsert({
        where: { emailHash: hashForLookup('admin@acme.com') },
        update: {},
        create: { email: 'admin@acme.com', emailHash: hashForLookup('admin@acme.com'), passwordHash: pwd, uiLanguage: 'en', name: 'Alice Admin' },
    });
    const editor = await prisma.user.upsert({
        where: { emailHash: hashForLookup('editor@acme.com') },
        update: {},
        create: { email: 'editor@acme.com', emailHash: hashForLookup('editor@acme.com'), passwordHash: pwd, uiLanguage: 'en', name: 'Bob Editor' },
    });
    const reader = await prisma.user.upsert({
        where: { emailHash: hashForLookup('viewer@acme.com') },
        update: {},
        create: { email: 'viewer@acme.com', emailHash: hashForLookup('viewer@acme.com'), passwordHash: pwd, uiLanguage: 'en', name: 'Carol Reader' },
    });
    const auditor = await prisma.user.upsert({
        where: { emailHash: hashForLookup('auditor@acme.com') },
        update: {},
        create: { email: 'auditor@acme.com', emailHash: hashForLookup('auditor@acme.com'), passwordHash: pwd, uiLanguage: 'en', name: 'Dan Auditor' },
    });
    console.log('✅ Users created');

    // ─── Tenant (production path: createTenantWithOwner) ───
    //
    // GAP-07 alignment — the seed used to call `prisma.tenant.upsert`
    // directly + manually grant `role: 'ADMIN'`, which diverged from the
    // production tenant-creation path in two important ways:
    //
    //   1. No wrapped DEK was generated, so encrypted-field writes against
    //      the seed tenant silently fell back to v1 (global KEK) instead
    //      of v2 (per-tenant DEK) — masking real-world encryption shape
    //      in dev / E2E.
    //   2. The first membership was ADMIN, not OWNER — diverging from the
    //      role model where every tenant must have ≥ 1 ACTIVE OWNER
    //      (enforced by the `tenant_membership_last_owner_guard` trigger).
    //
    // Now the seed routes through the canonical
    // `createTenantWithOwner` usecase — same path used by the
    // platform-admin `POST /api/admin/tenants` route. Idempotent:
    // checked before calling so re-runs against an existing dev DB
    // don't error on the unique slug.
    let tenant = await prisma.tenant.findUnique({
        where: { slug: 'acme-corp' },
    });
    if (!tenant) {
        const result = await createTenantWithOwner({
            name: 'Acme Corp',
            slug: 'acme-corp',
            ownerEmail: admin.email,
            requestId: `seed-${randomUUID()}`,
        });
        tenant = await prisma.tenant.findUnique({
            where: { id: result.tenant.id },
        });
    }
    if (!tenant) {
        throw new Error('seed: failed to create or load acme-corp tenant');
    }

    // Apply the seed-only fields (`industry`, `maxRiskScale`) that
    // `createTenantWithOwner` doesn't take — purely cosmetic on the
    // dev tenant; production sets these via subsequent usecases.
    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { industry: 'Technology', maxRiskScale: 5 },
    });
    // Ensure the default planning season exists (idempotent). Fresh tenants
    // get it inside `createTenantWithOwner`; this backfills a dev tenant
    // that pre-dates that seeding on a re-seed.
    await seedDefaultSeason(prisma, tenant.id);
    console.log('✅ Tenant:', tenant.name, '(OWNER:', admin.email + ')');

    // ─── Tenant Memberships (non-owner roles) ───
    //
    // The OWNER membership for `admin` was created atomically inside
    // `createTenantWithOwner` above. Only the non-owner fixtures land
    // here.
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: editor.id } },
        update: {},
        create: { tenantId: tenant.id, userId: editor.id, role: 'EDITOR' },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: reader.id } },
        update: {},
        create: { tenantId: tenant.id, userId: reader.id, role: 'READER' },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: auditor.id } },
        update: {},
        create: { tenantId: tenant.id, userId: auditor.id, role: 'AUDITOR' },
    });
    console.log('✅ Tenant memberships created');

    // ─── Hub-and-spoke organization layer (Epic O-1) ───
    //
    // Default org "Acme Corp" parented over the acme-corp tenant.
    // Demonstrates the full hub-and-spoke shape:
    //   1. Organization (parent) ← linked tenant
    //   2. CISO user as ORG_ADMIN
    //   3. Auto-provisioned AUDITOR membership in every child tenant,
    //      with `provisionedByOrgId` set so the (future) Epic O-2
    //      deprovision usecase can distinguish auto-created from
    //      manually-granted memberships.
    //
    // Slugs live in separate tables (Organization vs Tenant) so they
    // could share names; we deliberately use distinct slugs (`acme-org`
    // vs `acme-corp`) to avoid confusion in URL paths.
    //
    // Idempotent: every step uses upsert + the natural unique key.
    const organization = await prisma.organization.upsert({
        where: { slug: 'acme-org' },
        update: {},
        create: { name: 'Acme Corp', slug: 'acme-org' },
    });
    console.log('✅ Organization:', organization.name);

    // Link the existing acme-corp tenant to the org (no-op on re-run
    // because writing the same FK is idempotent).
    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { organizationId: organization.id },
    });
    console.log('✅ Tenant linked to organization');

    // Seed the eight default org-dashboard widgets (KPI tiles +
    // donut + trend + tenant-coverage list + drill-down CTAs). The
    // ciso-portfolio E2E suite asserts on `#org-stat-coverage` etc.
    // — those id anchors come from the dispatched widgets, so the
    // dashboard must be pre-populated before the test runs.
    // Idempotent — short-circuits on any pre-existing widget row.
    const dashboardSeed = await seedDefaultOrgDashboard(prisma, organization.id);
    if (dashboardSeed.seeded) {
        console.log(`✅ Org dashboard widgets seeded (${dashboardSeed.created})`);
    }

    // CISO is the canonical ORG_ADMIN — sees every child tenant as
    // AUDITOR via the auto-provisioning fan-out below.
    const ciso = await prisma.user.upsert({
        where: { emailHash: hashForLookup('ciso@acme.com') },
        update: {},
        create: { email: 'ciso@acme.com', emailHash: hashForLookup('ciso@acme.com'), passwordHash: pwd, uiLanguage: 'en', name: 'Carla CISO' },
    });

    await prisma.orgMembership.upsert({
        where: {
            organizationId_userId: {
                organizationId: organization.id,
                userId: ciso.id,
            },
        },
        update: {},
        create: {
            organizationId: organization.id,
            userId: ciso.id,
            role: 'ORG_ADMIN',
        },
    });
    console.log('✅ Org membership created (CISO as ORG_ADMIN)');

    // Auto-provisioned AUDITOR fan-out. In production this is the
    // job of `provisionOrgAdminToTenants` (Epic O-2); the seed
    // inlines the equivalent rows so the deployed dev/test DB has a
    // realistic post-provisioning state immediately. `provisionedByOrgId`
    // is set so the deprovision usecase will recognise these rows as
    // auto-created when ORG_ADMIN is removed.
    const orgTenants = await prisma.tenant.findMany({
        where: { organizationId: organization.id },
        select: { id: true },
    });
    let provisioned = 0;
    for (const t of orgTenants) {
        const result = await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: t.id, userId: ciso.id } },
            // Update path runs only if the row exists from a prior seed.
            // We refresh `provisionedByOrgId` so a pre-existing manual
            // membership of CISO would NOT be overwritten — only the
            // auto-created row carries the org id. (In practice this
            // seed creates the membership from scratch.)
            update: {},
            create: {
                tenantId: t.id,
                userId: ciso.id,
                role: 'AUDITOR',
                provisionedByOrgId: organization.id,
            },
        });
        if (result.provisionedByOrgId === organization.id) provisioned++;
    }
    console.log(
        `✅ Auto-provisioned AUDITOR memberships in ${provisioned} tenant(s)`,
    );

    // ─── Seed assets ───
    const assetCount = await prisma.asset.count({ where: { tenantId: tenant.id } });
    if (assetCount === 0) {
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'John Deere 6155R', type: 'TRACTOR', manufacturer: 'John Deere', model: '6155R', serialNumber: 'JD6155R-2021-0042', year: 2021, owner: 'Farm manager', location: 'North machine shed', criticality: 'HIGH', purchaseCost: 145000 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Case IH Axial-Flow 250', type: 'HARVESTER', manufacturer: 'Case IH', model: 'Axial-Flow 250', serialNumber: 'CIH-AF250-2019-0117', year: 2019, owner: 'Farm manager', location: 'Main barn', criticality: 'HIGH', purchaseCost: 380000 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Grain Storage Barn', type: 'BUILDING', owner: 'Operations', location: 'East yard', criticality: 'MEDIUM' } });
    }
    console.log('✅ Assets seeded');

    // ─── Tasks (E2E: tasks list + CopyText(task.key) flow) ───
    // Seeds three tasks with deterministic keys (TSK-1/2/3) so the tasks
    // list is never empty and the task-key CopyText affordance always
    // has a target to exercise in E2E.
    const existingTasks = await prisma.task.count({ where: { tenantId: tenant.id } });
    if (existingTasks === 0) {
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-1',
                title: 'Implement MFA for privileged accounts',
                description: 'All privileged users must have MFA enabled within 30 days.',
                type: 'TASK',
                severity: 'HIGH',
                priority: 'P1',
                status: 'OPEN',
                source: 'MANUAL',
                createdByUserId: admin.id,
                assigneeUserId: editor.id,
            },
        });
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-2',
                title: 'Quarterly access review',
                description: 'Review and recertify user access for production systems.',
                type: 'TASK',
                severity: 'MEDIUM',
                priority: 'P2',
                status: 'IN_PROGRESS',
                source: 'MANUAL',
                createdByUserId: admin.id,
                assigneeUserId: admin.id,
            },
        });
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-3',
                title: 'Patch critical vulnerabilities',
                description: 'Apply security patches to all production systems within SLA.',
                type: 'TASK',
                severity: 'HIGH',
                priority: 'P1',
                status: 'OPEN',
                source: 'MANUAL',
                createdByUserId: editor.id,
            },
        });
        // A FARM_TASK so /farm-tasks — the sole task UI, which lists only
        // FARM_TASK + FIELD_OPERATION — is never empty in the shared tenant.
        // The row→detail, mobile-card, and task-key CopyText E2E flows need a
        // farm-typed row to exercise (the TASK rows above never surface there).
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-4',
                title: 'Scout the north block for aphids',
                description: 'Walk the north block and check the undersides of leaves for aphid colonies.',
                type: 'FARM_TASK',
                severity: 'MEDIUM',
                priority: 'P2',
                status: 'OPEN',
                source: 'MANUAL',
                createdByUserId: admin.id,
                assigneeUserId: editor.id,
                metadataJson: { farmTaskType: 'SCOUTING', farmTaskCategory: 'PEST_DISEASE' },
            },
        });
        // Seed the per-tenant key counter to match. `WorkItemRepository`
        // mints `TSK-N` from `TaskKeySequence`; the #102 migration
        // backfills that counter from existing keys, but the backfill
        // runs BEFORE this seed inserts TSK-1..4. Without this row the
        // first API-created task mints `TSK-1` and collides with the
        // seeded task on the unique `[tenantId, key]` index.
        await prisma.taskKeySequence.upsert({
            where: { tenantId: tenant.id },
            create: { tenantId: tenant.id, lastValue: 4 },
            update: { lastValue: 4 },
        });
        console.log('✅ Tasks seeded (TSK-1 / TSK-2 / TSK-3 + FARM_TASK TSK-4) + key counter');
    }

    // ─── Audit log entries (E2E: admin/audit-log table render) ───
    // The DataTable platform regression spec exercises the admin audit
    // log page, which renders an empty-state placeholder when there
    // are no entries. Seed a handful so the `<table>` element is always
    // present (the spec asserts on table structure, not content).
    const auditLogCount = await prisma.auditLog.count({ where: { tenantId: tenant.id } });
    if (auditLogCount === 0) {
        await prisma.auditLog.createMany({
            data: [
                { tenantId: tenant.id, userId: admin.id, entity: 'Tenant', entityId: tenant.id, action: 'TENANT_SEEDED', details: 'Initial seed', actorType: 'SYSTEM' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Asset', entityId: '', action: 'ASSET_CREATED', details: 'Seeded asset', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Task', entityId: '', action: 'TASK_CREATED', details: 'Seeded task', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Evidence', entityId: '', action: 'EVIDENCE_CREATED', details: 'Seeded evidence', actorType: 'USER' },
            ],
        });
        console.log('✅ Audit log entries seeded (4 entries)');
    }
    // ─── Agriculture (Feature 1 — spray-prescription map) demo data ───
    // Wrapped so a storage misconfiguration (e.g. STORAGE_PROVIDER unset)
    // degrades to a warning instead of failing the whole seed.
    try {
        await importUnits(prisma);

        // Global agriculture-events catalogue (shared, no tenantId). Demo rows
        // only — see the header of scripts/seed-agri-events.ts. Without this the
        // /events page renders its empty state and the nav entry hides itself.
        await seedAgriEvents(prisma);

        // Global supplier + promotions catalogue (shared, no tenantId). Demo
        // rows only — see the header of scripts/seed-promotions.ts.
        await seedPromotions(prisma);

        const litre = await prisma.unit.findUnique({ where: { key: 'l' } });
        const kg = await prisma.unit.findUnique({ where: { key: 'kg' } });
        const demoProducts: Array<{ name: string; category: 'PESTICIDE' | 'FERTILIZER'; unitId?: string }> = [
            { name: 'Glyphosate 360 SL', category: 'PESTICIDE', unitId: litre?.id },
            { name: 'Liquid Nitrogen 28%', category: 'FERTILIZER', unitId: litre?.id },
            { name: 'Slug Pellets (Ferric)', category: 'PESTICIDE', unitId: kg?.id },
        ];
        for (const p of demoProducts) {
            if (!p.unitId) continue;
            const existing = await prisma.item.findFirst({ where: { tenantId: tenant.id, name: p.name } });
            if (!existing) {
                await prisma.item.create({
                    data: { tenantId: tenant.id, name: p.name, category: p.category, defaultUnitId: p.unitId, createdByUserId: admin.id },
                });
            }
        }
        console.log('✅ Agriculture: unit catalog + demo input products seeded');

        const adminCtx: RequestContext = {
            requestId: randomUUID(),
            userId: admin.id,
            tenantId: tenant.id,
            tenantSlug: undefined,
            role: 'OWNER' as Role,
            permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
            appPermissions: getPermissionsForRole('OWNER' as Role),
        };
        const existingLoc = await prisma.location.findFirst({ where: { tenantId: tenant.id, name: 'Home Farm — Demo' } });
        if (!existingLoc) {
            const loc = await createLocation(adminCtx, {
                name: 'Home Farm — Demo',
                description: 'Seeded demo field block — three parcels ready for a spray job.',
            });
            // Spatial file import is now an async BullMQ job
            // (stageLocationSpatialImport → spatial-import worker), which a
            // Redis-free seed can't drive. Per the seed convention, create the
            // demo parcels directly via the createParcel usecase — the same
            // path the API uses (geometry persisted via geo.ts, areaHa
            // re-derived server-side, RLS-scoped).
            const demoParcels: CreateParcelInput[] = [
                { name: 'North Field', cropType: 'Winter Wheat', geometry: { type: 'Polygon', coordinates: [[[-1.100, 52.200], [-1.085, 52.200], [-1.085, 52.212], [-1.100, 52.212], [-1.100, 52.200]]] } },
                { name: 'River Meadow', cropType: 'Grass', geometry: { type: 'Polygon', coordinates: [[[-1.100, 52.185], [-1.088, 52.185], [-1.088, 52.196], [-1.100, 52.196], [-1.100, 52.185]]] } },
                { name: 'Top Paddock', cropType: null, geometry: { type: 'Polygon', coordinates: [[[-1.082, 52.200], [-1.070, 52.200], [-1.070, 52.210], [-1.082, 52.210], [-1.082, 52.200]]] } },
            ];
            for (const p of demoParcels) {
                await createParcel(adminCtx, loc.id, p);
            }
            console.log('✅ Agriculture: demo Location "Home Farm — Demo" + 3 parcels seeded');
        } else {
            console.log('✅ Agriculture: demo Location already present (skipped)');
        }
    } catch (err) {
        console.warn('⚠️  Agriculture demo seed skipped:', err instanceof Error ? err.message : err);
    }

    console.log('\n🎉 Seed complete! Login as admin@acme.com — password set via SEED_PASSWORD (default in prisma/seed.ts)');
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
        // Seeding parcels calls createParcel → enqueueParcelSoilFetch, which
        // lazily opens a BullMQ (soil) queue whose Redis connection would
        // otherwise keep this one-shot process alive forever (the CI seed
        // step hung ~40 min after "Seed complete!" until it was cancelled).
        // Close the queue, then force-exit as a belt-and-braces guarantee
        // against any other lingering job-queue handle.
        const { closeQueue } = await import('@/app-layer/jobs/queue');
        await closeQueue().catch(() => {});
        process.exit(process.exitCode ?? 0);
    });
