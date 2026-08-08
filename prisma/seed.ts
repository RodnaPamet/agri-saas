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

    // ─── Seed clauses ───
    const clauseData = [
        { number: '4', title: 'Context of the Organization', sortOrder: 4 },
        { number: '5', title: 'Leadership', sortOrder: 5 },
        { number: '6', title: 'Planning', sortOrder: 6 },
        { number: '7', title: 'Support', sortOrder: 7 },
        { number: '8', title: 'Operation', sortOrder: 8 },
        { number: '9', title: 'Performance Evaluation', sortOrder: 9 },
        { number: '10', title: 'Improvement', sortOrder: 10 },
    ];
    for (const c of clauseData) {
        await prisma.clause.upsert({ where: { number: c.number }, create: c, update: {} });
    }
    console.log('✅ Clauses seeded');

    // ─── Seed assets ───
    const assetCount = await prisma.asset.count({ where: { tenantId: tenant.id } });
    if (assetCount === 0) {
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'John Deere 6155R', type: 'TRACTOR', manufacturer: 'John Deere', model: '6155R', serialNumber: 'JD6155R-2021-0042', year: 2021, owner: 'Farm manager', location: 'North machine shed', criticality: 'HIGH', purchaseCost: 145000 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Case IH Axial-Flow 250', type: 'HARVESTER', manufacturer: 'Case IH', model: 'Axial-Flow 250', serialNumber: 'CIH-AF250-2019-0117', year: 2019, owner: 'Farm manager', location: 'Main barn', criticality: 'HIGH', purchaseCost: 380000 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Grain Storage Barn', type: 'BUILDING', owner: 'Operations', location: 'East yard', criticality: 'MEDIUM' } });
    }
    console.log('✅ Assets seeded');

    // ─── Seed controls ───
    // `code` replaced the ISO-specific `annexId` column when the
    // compliance uproot dropped the Annex-A framing.
    const sampleControls = [
        { code: 'A.5.1', name: 'Information Security Policies', intent: 'Ensure management direction and support for information security.', status: 'IMPLEMENTED' },
        { code: 'A.5.2', name: 'Information Security Roles', intent: 'Establish defined roles and responsibilities.', status: 'IMPLEMENTING' },
        { code: 'A.8.1', name: 'User Endpoint Devices', intent: 'Protect information on user endpoint devices.', status: 'IMPLEMENTED' },
        { code: 'A.8.9', name: 'Configuration Management', intent: 'Ensure correct and secure configuration of systems.', status: 'PLANNED' },
    ];
    for (const c of sampleControls) {
        const existing = await prisma.control.findFirst({ where: { code: c.code, tenantId: tenant.id } });
        if (!existing) {
            await prisma.control.create({ data: { tenantId: tenant.id, ...c } });
        } else {
            // Reset applicability to APPLICABLE so the pill-toggle E2E
            // always finds a "Yes" row regardless of prior mutations.
            await prisma.control.update({
                where: { id: existing.id },
                data: {
                    applicability: 'APPLICABLE',
                    applicabilityJustification: null,
                    applicabilityDecidedByUserId: null,
                    applicabilityDecidedAt: null,
                },
            });
        }
    }
    console.log('✅ Controls seeded (applicability reset to APPLICABLE)');

    // ─── Policy Templates ───
    const policyTemplates = [
        { title: 'Information Security Policy', category: 'Core', tags: 'isms,governance', contentText: '# Information Security Policy\n\n## Purpose\nEstablish the organization\'s commitment to information security.\n\n## Policy Statements\n1. Information classified and protected by sensitivity.\n2. Access granted on need-to-know basis.\n3. Incidents reported and investigated promptly.' },
        { title: 'Access Control Policy', category: 'Technical', tags: 'access,authentication', contentText: '# Access Control Policy\n\n## Purpose\nEnsure authorized access and prevent unauthorized access.\n\n## Statements\n1. Least privilege principle.\n2. MFA for privileged accounts.\n3. Quarterly access reviews.' },
        { title: 'Data Classification Policy', category: 'Core', tags: 'data,classification', contentText: '# Data Classification Policy\n\n## Levels\n- Public\n- Internal\n- Confidential\n- Restricted' },
        { title: 'Acceptable Use Policy', category: 'HR', tags: 'acceptable-use', contentText: '# Acceptable Use Policy\n\n## Statements\n1. IT resources for business purposes.\n2. No bypassing security controls.\n3. Protect credentials.' },
        { title: 'Incident Response Policy', category: 'Operations', tags: 'incident,response', contentText: '# Incident Response Policy\n\n## Phases\n1. Identification\n2. Containment\n3. Eradication\n4. Recovery\n5. Lessons Learned' },
        { title: 'Business Continuity Policy', category: 'Operations', tags: 'bcp,disaster-recovery', contentText: '# Business Continuity Policy\n\n## Statements\n1. Annual BIA.\n2. Defined RTO/RPO.\n3. Annual BC/DR tests.' },
        { title: 'Risk Management Policy', category: 'Core', tags: 'risk,assessment', contentText: '# Risk Management Policy\n\n## Framework\n1. Identify\n2. Assess\n3. Treat\n4. Monitor' },
        { title: 'Change Management Policy', category: 'Operations', tags: 'change,management', contentText: '# Change Management Policy\n\n## Types\n- Standard\n- Normal\n- Emergency' },
        { title: 'Physical Security Policy', category: 'Physical', tags: 'physical,facilities', contentText: '# Physical Security Policy\n\n## Statements\n1. Appropriate entry controls.\n2. Visitor logging.\n3. Clear desk policy.' },
        { title: 'Human Resources Security Policy', category: 'HR', tags: 'hr,screening', contentText: '# HR Security Policy\n\n## Statements\n1. Background screening.\n2. Annual awareness training.\n3. NDA before access.' },
        { title: 'Third-Party Security Policy', category: 'Vendor', tags: 'vendor,supplier', contentText: '# Third-Party Security\n\n## Statements\n1. Security in supplier agreements.\n2. Minimum access.\n3. Monitor performance.' },
        { title: 'Logging and Monitoring Policy', category: 'Technical', tags: 'logging,monitoring', contentText: '# Logging and Monitoring\n\n## Statements\n1. Log security events.\n2. Protect logs.\n3. Automated alerting.' },
    ];
    for (const tmpl of policyTemplates) {
        const existing = await prisma.policyTemplate.findFirst({ where: { title: tmpl.title } });
        if (!existing) {
            await prisma.policyTemplate.create({ data: tmpl });
        }
    }
    console.log('✅ Policy Templates seeded');

    // ─── Frameworks & Requirements ───
    const annexAData = require('./fixtures/iso27001_2022_annexA.json') as Array<{
        key: string; theme: string; themeNumber: number; sortOrder: number; title: string; summary?: string;
    }>;

    // ISO 27001:2022
    // `key` lost its single-column unique so two revisions of a standard
    // can coexist, which means Prisma will no longer accept it as an
    // upsert `where`. Find-then-write keeps the seeder idempotent.
    const iso27001Existing = await prisma.framework.findFirst({ where: { key: 'ISO27001' } });
    const iso27001 = iso27001Existing
        ? await prisma.framework.update({ where: { id: iso27001Existing.id }, data: { name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' } })
        : await prisma.framework.create({ data: { key: 'ISO27001', name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' } });

    // Upsert all 93 Annex A requirements
    const requirementMap: Record<string, string> = {};
    for (const req of annexAData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso27001.id, code: req.key } },
            update: { title: req.title, description: req.summary || null, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
            create: { frameworkId: iso27001.id, code: req.key, title: req.title, description: req.summary || null, category: req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
        });
        requirementMap[req.key] = r.id;
    }
    console.log(`✅ ISO 27001:2022 framework + ${annexAData.length} Annex A requirements seeded`);

    // SOC2
    // `key` lost its single-column unique so two revisions of a standard
    // can coexist, which means Prisma will no longer accept it as an
    // upsert `where`. Find-then-write keeps the seeder idempotent.
    const soc2Existing = await prisma.framework.findFirst({ where: { key: 'SOC2' } });
    const soc2 = soc2Existing
        ? await prisma.framework.update({ where: { id: soc2Existing.id }, data: { name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' } })
        : await prisma.framework.create({ data: { key: 'SOC2', name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' } });
    const soc2Reqs = [
        { code: 'CC1.1', title: 'COSO principle 1 — Integrity and ethical values', category: 'Control Environment' },
        { code: 'CC2.1', title: 'Information for internal controls', category: 'Communication' },
        { code: 'CC3.1', title: 'Specifies objectives', category: 'Risk Assessment' },
        { code: 'CC5.1', title: 'Selects and develops control activities', category: 'Control Activities' },
        { code: 'CC6.1', title: 'Logical and physical access controls', category: 'Logical Access' },
        { code: 'CC7.1', title: 'System operations monitoring', category: 'System Operations' },
        { code: 'CC8.1', title: 'Change management', category: 'Change Management' },
    ];
    for (let i = 0; i < soc2Reqs.length; i++) {
        const req = soc2Reqs[i];
        await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: soc2.id, code: req.code } },
            update: {},
            create: { frameworkId: soc2.id, code: req.code, title: req.title, category: req.category, sortOrder: i },
        });
    }

    // NIS2 — full fixture-driven
    const nis2Data = require('./fixtures/nis2_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const nis2 = await prisma.framework.upsert({
        where: { key_version: { key: 'NIS2', version: '2022/2555' } },
        update: { name: 'NIS2 Directive', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
        create: { key: 'NIS2', name: 'NIS2 Directive', version: '2022/2555', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
    });
    // Clean old NIS2 requirements from key-only era
    const oldNis2 = await prisma.framework.findFirst({ where: { key: 'NIS2', version: null } });
    if (oldNis2 && oldNis2.id !== nis2.id) {
        await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: oldNis2.id } });
        await prisma.framework.delete({ where: { id: oldNis2.id } }).catch(() => { });
    }
    const nis2ReqMap: Record<string, string> = {};
    for (const req of nis2Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nis2.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nis2.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nis2ReqMap[req.key] = r.id;
    }
    console.log(`✅ NIS2 framework + ${nis2Data.length} requirements seeded`);

    // ISO 9001
    const iso9001Data = require('./fixtures/iso9001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso9001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO9001', version: '2015' } },
        update: { name: 'ISO 9001', description: 'ISO 9001:2015 Quality Management Systems' },
        create: { key: 'ISO9001', name: 'ISO 9001', version: '2015', kind: 'ISO_STANDARD', description: 'ISO 9001:2015 Quality Management Systems' },
    });
    const iso9001ReqMap: Record<string, string> = {};
    for (const req of iso9001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso9001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso9001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso9001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 9001 framework + ${iso9001Data.length} requirements seeded`);

    // ISO 28000
    const iso28000Data = require('./fixtures/iso28000_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso28000 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO28000', version: '2022' } },
        update: { name: 'ISO 28000', description: 'ISO 28000:2022 Supply Chain Security Management' },
        create: { key: 'ISO28000', name: 'ISO 28000', version: '2022', kind: 'ISO_STANDARD', description: 'ISO 28000:2022 Supply Chain Security Management' },
    });
    const iso28000ReqMap: Record<string, string> = {};
    for (const req of iso28000Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso28000.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso28000.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso28000ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 28000 framework + ${iso28000Data.length} requirements seeded`);

    // ISO 39001
    const iso39001Data = require('./fixtures/iso39001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso39001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO39001', version: '2012' } },
        update: { name: 'ISO 39001', description: 'ISO 39001:2012 Road Traffic Safety Management' },
        create: { key: 'ISO39001', name: 'ISO 39001', version: '2012', kind: 'ISO_STANDARD', description: 'ISO 39001:2012 Road Traffic Safety Management' },
    });
    const iso39001ReqMap: Record<string, string> = {};
    for (const req of iso39001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso39001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso39001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso39001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 39001 framework + ${iso39001Data.length} requirements seeded`);

    console.log('✅ SOC2 + NIS2 + ISO9001 + ISO28000 + ISO39001 frameworks seeded');

    // ─── Framework Packs ───
    //
    // A pack used to be a bundle of ControlTemplates joined through
    // PackTemplateLink. The compliance uproot removed the template
    // library, so a pack is now just a named, versioned handle on a
    // Framework — installation is judged by whether the tenant has
    // mapped any control to a requirement of that framework (see
    // FrameworkRepository.isPackInstalled).
    const PACKS = [
        { key: 'ISO27001_2022_BASE', name: 'ISO 27001:2022 Starter Pack', framework: iso27001, version: '2022', description: 'Full Annex A control set with default implementation tasks.' },
        { key: 'NIS2_BASELINE', name: 'NIS2 Baseline Pack', framework: nis2, version: '2022/2555', description: 'NIS2 directive security measures baseline.' },
        { key: 'ISO9001_CORE', name: 'ISO 9001 Core Pack', framework: iso9001, version: '2015', description: 'ISO 9001 quality management core controls.' },
        { key: 'ISO28000_CORE', name: 'ISO 28000 Core Pack', framework: iso28000, version: '2022', description: 'ISO 28000 supply chain security core controls.' },
        { key: 'ISO39001_CORE', name: 'ISO 39001 Core Pack', framework: iso39001, version: '2012', description: 'ISO 39001 road traffic safety core controls.' },
    ];
    for (const p of PACKS) {
        await prisma.frameworkPack.upsert({
            where: { key: p.key },
            update: { name: p.name, frameworkId: p.framework.id, version: p.version },
            create: { key: p.key, name: p.name, frameworkId: p.framework.id, version: p.version, description: p.description },
        });
    }

    console.log('✅ All Framework Packs seeded');

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

    // ─── Policies (E2E: policies list + detail navigation) ───
    // Promote 3 policy templates into live tenant policies with published
    // versions so the /policies list is never empty and row-click tests
    // can navigate to a detail page.
    const existingPolicies = await prisma.policy.count({ where: { tenantId: tenant.id } });
    if (existingPolicies === 0) {
        const toSeed = ['Information Security Policy', 'Access Control Policy', 'Incident Response Policy'];
        for (const title of toSeed) {
            const template = await prisma.policyTemplate.findFirst({ where: { title } });
            if (!template) continue;
            const policy = await prisma.policy.create({
                data: {
                    tenantId: tenant.id,
                    slug: title.replace(/\s+/g, '-').toLowerCase(),
                    title: template.title,
                    description: `Tenant adoption of ${template.title}`,
                    category: template.category || null,
                    status: 'PUBLISHED',
                    ownerUserId: admin.id,
                },
            });
            const version = await prisma.policyVersion.create({
                data: {
                    tenantId: tenant.id,
                    policyId: policy.id,
                    versionNumber: 1,
                    contentType: template.contentType,
                    contentText: template.contentText,
                    createdById: admin.id,
                },
            });
            await prisma.policy.update({
                where: { id: policy.id },
                data: { currentVersionId: version.id },
            });
        }
        console.log('✅ Policies seeded (3 published policies)');
    }

    // ─── ISO27001 pack install (E2E: coverage metrics + reports) ───
    // Link the seeded tenant controls to ISO27001 Annex A requirements so
    // the coverage report has mapped rows to render. Without this the
    // reporting.spec.ts "coverage metrics" test has no coverage data
    // available and would fall back to the legacy "not installed" skip.
    const tenantControls = await prisma.control.findMany({ where: { tenantId: tenant.id } });
    const annexMap: Record<string, string> = {};
    const annexReqs = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: iso27001.id },
    });
    for (const r of annexReqs) annexMap[r.code] = r.id;
    for (const ctrl of tenantControls) {
        // Seed-created controls use annexId like 'A.5.1' which matches the
        // requirement code directly.
        const code = ctrl.annexId ?? '';
        const reqId = annexMap[code];
        if (!reqId) continue;
        const existing = await prisma.controlRequirementLink.findFirst({
            where: { controlId: ctrl.id, requirementId: reqId },
        });
        if (!existing) {
            await prisma.controlRequirementLink.create({
                data: { tenantId: tenant.id, controlId: ctrl.id, requirementId: reqId },
            });
        }
    }
    console.log('✅ ISO27001 control→requirement links seeded (coverage report ready)');

    // ─── Audit cycle + frozen pack + share token (E2E prerequisites) ───
    // A sizeable portion of the E2E suite depends on a tenant having an
    // existing frozen pack with a share link (tooltip-and-copy, reporting,
    // audit-readiness). Seeding this once removes the "no audit pack
    // available" / "share link not yet generated" skip branches.
    const bcryptLib = bcrypt;
    let seedCycle = await prisma.auditCycle.findFirst({
        where: { tenantId: tenant.id, frameworkKey: 'ISO27001' },
    });
    if (!seedCycle) {
        seedCycle = await prisma.auditCycle.create({
            data: {
                tenantId: tenant.id,
                frameworkKey: 'ISO27001',
                frameworkVersion: '2022',
                name: 'Seeded ISO27001 Audit Cycle',
                status: 'PLANNING',
                createdByUserId: admin.id,
            },
        });
    }
    let seedPack = await prisma.auditPack.findFirst({
        where: { tenantId: tenant.id, auditCycleId: seedCycle.id },
    });
    if (!seedPack) {
        seedPack = await prisma.auditPack.create({
            data: {
                tenantId: tenant.id,
                auditCycleId: seedCycle.id,
                name: 'Seeded ISO27001 Audit Pack',
                status: 'FROZEN',
                frozenAt: new Date(),
                frozenByUserId: admin.id,
            },
        });
        // Minimal item snapshots so the pack has content to display.
        for (let i = 0; i < tenantControls.length; i++) {
            const c = tenantControls[i];
            await prisma.auditPackItem.create({
                data: {
                    tenantId: tenant.id,
                    auditPackId: seedPack.id,
                    entityType: 'CONTROL',
                    entityId: c.id,
                    snapshotJson: JSON.stringify({ id: c.id, annexId: c.annexId, name: c.name, status: c.status }),
                    sortOrder: i,
                },
            });
        }
    }
    // Share token — create one if none is active. We use a deterministic
    // seed token so E2Es can assert against a known value and the share
    // link is consistent across `db:reset` cycles.
    const crypto = require('crypto');
    const existingShare = await prisma.auditPackShare.findFirst({
        where: { auditPackId: seedPack.id, revokedAt: null },
    });
    if (!existingShare) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
        await prisma.auditPackShare.create({
            data: {
                tenantId: tenant.id,
                auditPackId: seedPack.id,
                tokenHash: hash,
                createdByUserId: admin.id,
            },
        });
        console.log(`✅ Audit pack share token generated (raw token: ${rawToken})`);
    }
    console.log('✅ Audit cycle + frozen pack + share link seeded');

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
                { tenantId: tenant.id, userId: admin.id, entity: 'Control', entityId: tenantControls[0]?.id ?? '', action: 'CONTROL_CREATED', details: 'Seeded control', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Policy', entityId: '', action: 'POLICY_PUBLISHED', details: 'Seeded policy', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Task', entityId: '', action: 'TASK_CREATED', details: 'Seeded task', actorType: 'USER' },
            ],
        });
        console.log('✅ Audit log entries seeded (4 entries)');
    }
    // Silence unused-binding lint for the re-exported bcrypt alias above.
    void bcryptLib;

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
