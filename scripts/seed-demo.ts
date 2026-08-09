#!/usr/bin/env tsx
/**
 * End-to-end DEMO seed — the two product personas in one coherent dataset.
 *
 *   1. A STARTUP FARM (simple mode): a single tenant whose
 *      TenantModuleSettings enables only the core ag modules
 *      (JOURNAL / INVENTORY / PLANNING). On login this operator sees a
 *      focused workspace — no certification / risk / vendor chrome.
 *      BillingAccount.plan = FREE (the per-user / per-location caps bite
 *      in SAAS mode; in dev SELFHOSTED everything resolves to ENTERPRISE).
 *
 *   2. A LARGE GRAIN PRODUCER (enterprise): one Organization with several
 *      child farm tenants (hub-and-spoke), each with the full module
 *      surface and BillingAccount.plan = ENTERPRISE. An org admin sees the
 *      portfolio of farms.
 *
 * Both personas get real ag data (location, input stock lot, a journal
 * entry, a farm task, CC0 growing guides) so the core flows work
 * immediately. Idempotent: re-running upserts by slug + skips present rows.
 *
 * Usage:  tsx scripts/seed-demo.ts   (or `npm run seed:demo`)
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { setEnabledModules } from '@/app-layer/usecases/modules';
import { createLocation } from '@/app-layer/usecases/location';
import { createLot } from '@/app-layer/usecases/inventory';
import { hashForLookup } from '@/lib/security/encryption';
import { SIMPLE_MODE_MODULES, ALL_MODULES } from '@/lib/modules';
import type { ModuleKey } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';
import { attachAutoEvidenceFromLogEntry } from '@/app-layer/usecases/auto-evidence';
import { loadAndValidateCatalogFile } from '../prisma/catalog-loader';
import { applyCatalogFile } from '../prisma/catalog-applier';
import { importUnits } from './import-units';
import { seedAgriEvents } from './seed-agri-events';
import { seedPromotions } from './seed-promotions';
import { importKnowledge } from './import-knowledge';
import { importCropVarieties } from './import-crop-varieties';
import { importProducts } from './import-products';
import {
    generateSuccessions,
    mergeTiming,
    mergeSpacing,
    type CropTiming,
    type CropSpacing,
} from '@/lib/planning/succession';
import * as path from 'path';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

function ownerCtx(tenantId: string, userId: string): RequestContext {
    return {
        requestId: randomUUID(),
        userId,
        tenantId,
        tenantSlug: undefined,
        role: 'OWNER' as Role,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
        appPermissions: getPermissionsForRole('OWNER' as Role),
    };
}

async function upsertOwner(email: string, name: string, pwd: string) {
    return prisma.user.upsert({
        where: { emailHash: hashForLookup(email) },
        update: {},
        create: { email, emailHash: hashForLookup(email), passwordHash: pwd, name },
    });
}

interface FarmSpec {
    slug: string;
    name: string;
    ownerEmail: string;
    ownerName: string;
    modules: readonly ModuleKey[];
    plan: 'FREE' | 'ENTERPRISE';
    organizationId?: string;
    cropProduct: string;
}

/** Create (idempotently) one farm tenant with module settings + ag data. */
async function seedFarm(spec: FarmSpec, pwd: string) {
    const owner = await upsertOwner(spec.ownerEmail, spec.ownerName, pwd);

    let tenant = await prisma.tenant.findUnique({ where: { slug: spec.slug } });
    if (!tenant) {
        const r = await createTenantWithOwner({
            name: spec.name,
            slug: spec.slug,
            ownerEmail: spec.ownerEmail,
            requestId: `seed-demo-${randomUUID()}`,
        });
        tenant = await prisma.tenant.findUnique({ where: { id: r.tenant.id } });
    }
    if (!tenant) throw new Error(`seed-demo: failed to create tenant ${spec.slug}`);

    if (spec.organizationId) {
        await prisma.tenant.update({ where: { id: tenant.id }, data: { organizationId: spec.organizationId } });
    }

    const ctx = ownerCtx(tenant.id, owner.id);

    // Persona differentiator #1 — module settings (drives the visible nav).
    await setEnabledModules(ctx, [...spec.modules]);

    // Persona differentiator #2 — billing plan (caps bite in SAAS mode).
    try {
        await prisma.billingAccount.upsert({
            where: { tenantId: tenant.id },
            update: { plan: spec.plan },
            create: { tenantId: tenant.id, plan: spec.plan },
        });
    } catch {
        /* BillingAccount shape varies by deployment; non-fatal for the demo. */
    }

    // ── Ag data so the core flows work immediately ──
    const litre = await prisma.unit.findUnique({ where: { key: 'l' } });
    const kg = await prisma.unit.findUnique({ where: { key: 'kg' } });

    // Two input items + one harvested-produce item.
    async function ensureItem(name: string, category: 'SEED' | 'FERTILIZER' | 'PESTICIDE' | 'HARVESTED_PRODUCE', unitId?: string) {
        if (!unitId) return null;
        const existing = await prisma.item.findFirst({ where: { tenantId: tenant!.id, name } });
        if (existing) return existing;
        return prisma.item.create({ data: { tenantId: tenant!.id, name, category, defaultUnitId: unitId, createdByUserId: owner.id } });
    }
    const fert = await ensureItem('Liquid Nitrogen 28%', 'FERTILIZER', litre?.id);
    await ensureItem(spec.cropProduct, 'HARVESTED_PRODUCE', kg?.id);

    // Generic, illustrative product/active-ingredient catalog (PESTICIDE /
    // FERTILIZER / AMENDMENT archetypes) on the INVENTORY surface, so the
    // inventory list shows a realistic spread of inputs immediately.
    // Idempotent on (tenantId, sku). Generic public-domain agronomy only —
    // no proprietary label data (see import-products.ts LICENSE note).
    if (spec.modules.includes('INVENTORY')) {
        try {
            await importProducts(prisma, { tenantId: tenant.id });
        } catch (e) {
            console.warn(`  ⚠️  ${spec.slug}: product catalog seed skipped:`, e instanceof Error ? e.message : e);
        }
    }

    // Location (a field) — reuses the entitlement-gated usecase.
    let locationId: string | null = null;
    const existingLoc = await prisma.location.findFirst({ where: { tenantId: tenant.id, name: 'Home Field' } });
    if (existingLoc) {
        locationId = existingLoc.id;
    } else {
        try {
            const loc = await createLocation(ctx, { name: 'Home Field', description: 'Demo field block.' });
            locationId = loc.id;
        } catch (e) {
            console.warn(`  ⚠️  ${spec.slug}: location seed skipped:`, e instanceof Error ? e.message : e);
        }
    }

    // An inventory lot with stock (a fertiliser delivery).
    if (fert) {
        const existingLot = await prisma.inventoryLot.findFirst({ where: { tenantId: tenant.id, itemId: fert.id } });
        if (!existingLot) {
            try {
                await createLot(ctx, { itemId: fert.id, lotCode: `N28-${spec.slug}`, locationId, initialQuantity: 1000 });
            } catch (e) {
                console.warn(`  ⚠️  ${spec.slug}: lot seed skipped:`, e instanceof Error ? e.message : e);
            }
        }
    }

    // A journal observation. Direct-prisma (the seed convention) — the
    // createLogEntry usecase is exercised by the integration tests; here we
    // just want the row so the journal list isn't empty.
    const existingEntry = await prisma.logEntry.findFirst({ where: { tenantId: tenant.id } });
    if (!existingEntry) {
        const entry = await prisma.logEntry.create({
            data: {
                tenantId: tenant.id,
                type: 'OBSERVATION',
                status: 'DONE',
                occurredAt: new Date(),
                title: 'Crop emergence looking even across the field',
                notes: '<p>Good establishment after last week\'s rain.</p>',
                createdByUserId: owner.id,
            },
            select: { id: true },
        });
        if (locationId) {
            await prisma.logLocation.create({ data: { tenantId: tenant.id, logEntryId: entry.id, locationId } }).catch(() => {});
        }
    }

    // A farm task assigned to the owner. Direct-prisma (mirrors how the
    // main seed creates tasks) to avoid the createTask side effects
    // (BullMQ assignment-notification enqueue) that hang without Redis.
    const existingTask = await prisma.task.findFirst({ where: { tenantId: tenant.id, type: 'FARM_TASK' } });
    if (!existingTask) {
        const task = await prisma.task.create({
            data: {
                tenantId: tenant.id,
                type: 'FARM_TASK',
                title: 'Scout north field for aphids',
                priority: 'P2',
                status: 'OPEN',
                dueAt: new Date(Date.now() + 3 * 86_400_000),
                createdByUserId: owner.id,
                assigneeUserId: owner.id,
                metadataJson: { farmTaskType: 'SCOUTING', farmTaskCategory: 'PEST_DISEASE' },
            },
            select: { id: true },
        });
        if (locationId) {
            await prisma.taskLink.create({
                data: { tenantId: tenant.id, taskId: task.id, entityType: 'LOCATION', entityId: locationId },
            }).catch(() => {});
        }
    }

    // CC0 growing guides.
    try {
        await importKnowledge(prisma, { tenantSlug: spec.slug });
    } catch (e) {
        console.warn(`  ⚠️  ${spec.slug}: knowledge seed skipped:`, e instanceof Error ? e.message : e);
    }

    // Crop-planning catalog + a demo season/plan with generated plantings
    // (PLANNING module). Redis-free path — see `seedDemoPlanning`.
    if (spec.modules.includes('PLANNING')) {
        try {
            await seedDemoPlanning(tenant.id, locationId);
        } catch (e) {
            console.warn(`  ⚠️  ${spec.slug}: planning seed skipped:`, e instanceof Error ? e.message : e);
        }
    }

    console.log(`✅ ${spec.name} (${spec.slug}) — modules: [${spec.modules.join(', ')}], plan: ${spec.plan}, owner: ${spec.ownerEmail}`);
    return { tenant, owner };
}

/**
 * Seed the crop-planning catalog (CC0 varieties) + one demo Season +
 * CropPlan, then populate its Plantings via the PURE succession engine
 * written DIRECTLY with prisma.
 *
 * Why direct prisma + the pure engine, not the `generatePlantings`
 * usecase: the usecase fans out field tasks via `createTask`, which
 * enqueues a BullMQ assignment notification — that hangs without Redis.
 * The seed matches the existing Redis-free convention (journal entry +
 * farm task are created directly with prisma above for the same reason).
 * The plantings themselves are the engine's deterministic output, so the
 * seed value is identical to what the usecase would persist; the
 * auto-generated tasks are simply omitted in the seed.
 *
 * Idempotent: skips if the demo plan already exists.
 */
async function seedDemoPlanning(tenantId: string, locationId: string | null) {
    // 1 — CC0 catalog (idempotent on natural keys).
    await importCropVarieties(prisma, { tenantId });

    // 2 — a demo Season (idempotent on (tenantId, key)).
    const seasonKey = 'demo-season';
    let season = await prisma.season.findFirst({
        where: { tenantId, key: seasonKey },
        select: { id: true },
    });
    if (!season) {
        const year = new Date().getUTCFullYear();
        season = await prisma.season.create({
            data: {
                tenantId,
                key: seasonKey,
                name: `${year} Main Season`,
                year,
                startDate: new Date(Date.UTC(year, 2, 1)),
                endDate: new Date(Date.UTC(year, 9, 31)),
                status: 'ACTIVE',
            },
            select: { id: true },
        });
    }

    // 3 — a demo CropPlan on a lettuce variety (idempotent). The crop
    //     catalog (import-crop-varieties.ts) seeds several lettuce
    //     varieties; the looseleaf type is the demo plan's anchor.
    const lettuce = await prisma.cropVariety.findFirst({
        where: { tenantId, key: 'lettuce-looseleaf' },
    });
    if (!lettuce) return; // catalog import must have been skipped

    const planName = 'Summer lettuce successions';
    const existingPlan = await prisma.cropPlan.findFirst({
        where: { tenantId, seasonId: season.id, name: planName },
        select: { id: true },
    });
    if (existingPlan) return;

    const firstSow = new Date(Date.UTC(new Date().getUTCFullYear(), 3, 1));
    const plan = await prisma.cropPlan.create({
        data: {
            tenantId,
            seasonId: season.id,
            cropTypeId: lettuce.cropTypeId,
            cropVarietyId: lettuce.id,
            locationId: locationId ?? null,
            name: planName,
            method: lettuce.defaultMethod ?? 'TRANSPLANT',
            firstSowDate: firstSow,
            successions: 4,
            intervalDays: 14,
            plantsPerSuccession: 60,
            status: 'ACTIVE',
        },
        select: { id: true, method: true, cropVarietyId: true, locationId: true },
    });

    // 4 — run the PURE engine + createMany the plantings directly.
    const varietyTiming: Partial<CropTiming> = {
        method: lettuce.defaultMethod ?? undefined,
        daysToTransplant: lettuce.daysToTransplant,
        daysToMaturity: lettuce.daysToMaturity ?? undefined,
        harvestWindowDays: lettuce.harvestWindowDays,
    };
    const varietySpacing: Partial<CropSpacing> = {
        inRowSpacingCm: lettuce.inRowSpacingCm ? Number(lettuce.inRowSpacingCm.toString()) : null,
        betweenRowSpacingCm: lettuce.betweenRowSpacingCm ? Number(lettuce.betweenRowSpacingCm.toString()) : null,
        seedsPerGram: lettuce.seedsPerGram ? Number(lettuce.seedsPerGram.toString()) : null,
        germinationRate: lettuce.germinationRate ? Number(lettuce.germinationRate.toString()) : null,
        seedsPerCell: lettuce.seedsPerCell,
    };
    const timing = mergeTiming(null, varietyTiming);
    timing.method = plan.method;
    const spacing = mergeSpacing(null, varietySpacing);
    const computed = generateSuccessions(
        { firstSowDate: firstSow, successions: 4, intervalDays: 14 },
        timing,
        { plantsPerSuccession: 60, bedLengthM: null, rowsPerBed: null, areaM2: null },
        spacing,
    );
    await prisma.planting.createMany({
        data: computed.map((c) => ({
            tenantId,
            cropPlanId: plan.id,
            cropVarietyId: plan.cropVarietyId,
            locationId: plan.locationId,
            successionNumber: c.successionNumber,
            method: timing.method,
            sowDate: c.sowDate,
            transplantDate: c.transplantDate,
            harvestStartDate: c.harvestStartDate,
            harvestEndDate: c.harvestEndDate,
            seedQuantityGrams: c.seedQuantityGrams,
            plantCount: c.plantCount,
            areaM2: c.areaM2,
            status: 'PLANNED' as const,
        })),
    });
}

/**
 * Replicate `installPack`'s tenant-scoped writes for a scheme pack:
 * create one Practice per linked PracticeTemplate + its
 * PracticeRequirementLink rows, so the tenant has Practices mapped to the
 * scheme's requirements (which is what auto-evidence + readiness key on).
 * Direct prisma to avoid the createTask/BullMQ enqueue path; idempotent
 * (skips a practice whose code already exists). RLS-safe enough for a seed:
 * every write carries the explicit tenantId.
 */
async function installSchemePackForDemo(tenantId: string, userId: string, packKey: string) {
    const pack = await prisma.frameworkPack.findUnique({
        where: { key: packKey },
        include: {
            templateLinks: { include: { template: { include: { requirementLinks: true } } } },
        },
    });
    if (!pack) {
        console.warn(`  ⚠️  pack ${packKey} not found — scheme catalog import may have failed`);
        return;
    }

    let practicesCreated = 0;
    let mappingsCreated = 0;
    for (const link of pack.templateLinks) {
        const tmpl = link.template;
        let practice = await prisma.practice.findFirst({ where: { tenantId, code: tmpl.code } });
        if (!practice) {
            practice = await prisma.practice.create({
                data: {
                    tenantId,
                    code: tmpl.code,
                    name: tmpl.title,
                    description: tmpl.description,
                    category: tmpl.category,
                    frequency: tmpl.defaultFrequency,
                    status: 'NOT_STARTED',
                    createdByUserId: userId,
                },
            });
            practicesCreated++;
        }
        for (const rl of tmpl.requirementLinks) {
            await prisma.practiceRequirementLink.upsert({
                where: { practiceId_requirementId: { practiceId: practice.id, requirementId: rl.requirementId } },
                create: { tenantId, practiceId: practice.id, requirementId: rl.requirementId },
                update: {},
            });
            mappingsCreated++;
        }
    }
    console.log(`✅ Installed ${packKey}: ${practicesCreated} practices, ${mappingsCreated} requirement mappings`);
}

/**
 * Create one INPUT_APPLICATION spray LogEntry on the tenant and run the
 * auto-evidence attach so the demo shows farm-record → scheme-evidence.
 * The attach runs inside `runInTenantContext` (it needs a tenant-bound db
 * handle). Idempotent: skips when an auto-evidence row already exists for
 * the tenant (category AUTO_FARM_RECORD).
 */
async function seedSprayAutoEvidence(tenantId: string, tenantSlug: string, userId: string) {
    const already = await prisma.evidence.findFirst({
        where: { tenantId, category: 'AUTO_FARM_RECORD' },
        select: { id: true },
    });
    if (already) {
        console.log('✅ Auto-evidence already present — skipping spray demo');
        return;
    }

    const entry = await prisma.logEntry.create({
        data: {
            tenantId,
            type: 'INPUT_APPLICATION',
            status: 'DONE',
            occurredAt: new Date(),
            title: 'Applied fungicide to North Field block A',
            notes: '<p>Demo spray record — backs the plant-protection practice points.</p>',
            createdByUserId: userId,
        },
        select: { id: true },
    });

    const ctx: RequestContext = { ...ownerCtx(tenantId, userId), tenantSlug };
    const { created } = await runInTenantContext(ctx, (db) =>
        attachAutoEvidenceFromLogEntry(db, ctx, entry.id),
    );
    console.log(`✅ Spray record ${entry.id} → ${created} auto-evidence row(s) attached (status SUBMITTED, pending review)`);
}

async function main() {
    console.log('🌱 Seeding the two-persona demo dataset…\n');
    const pwd = await bcrypt.hash(process.env.SEED_PASSWORD || 'password123', 10);

    // Global unit catalog (shared) — needed before any item/lot.
    await importUnits(prisma);

    // Global agriculture-events catalogue (shared, no tenantId). Demo rows only
    // — see the header of scripts/seed-agri-events.ts. Without this the /events
    // page renders its empty state and the nav entry hides itself.
    await seedAgriEvents(prisma);

    // Global supplier + promotions catalogue (shared, no tenantId). Demo rows
    // only — see the header of scripts/seed-promotions.ts.
    await seedPromotions(prisma);

    // ── Persona 1: the startup farmer (simple mode, FREE) ──
    await seedFarm(
        {
            slug: 'green-acres',
            name: 'Green Acres',
            ownerEmail: 'farmer@greenacres.demo',
            ownerName: 'Sam Smallholder',
            modules: SIMPLE_MODE_MODULES,
            plan: 'FREE',
            cropProduct: 'Wheat (grain)',
        },
        pwd,
    );

    // ── Persona 2: the large grain producer (enterprise, hub-and-spoke) ──
    const org = await prisma.organization.upsert({
        where: { slug: 'bigfarm-co' },
        update: {},
        create: { name: 'BigFarm Co', slug: 'bigfarm-co' },
    });
    console.log(`✅ Organization: ${org.name} (${org.slug})`);

    const childFarms: Array<Pick<FarmSpec, 'slug' | 'name' | 'ownerEmail' | 'ownerName' | 'cropProduct'>> = [
        { slug: 'bigfarm-north', name: 'BigFarm — North Estate', ownerEmail: 'north@bigfarm.demo', ownerName: 'Nadia North', cropProduct: 'Wheat (grain)' },
        { slug: 'bigfarm-south', name: 'BigFarm — South Estate', ownerEmail: 'south@bigfarm.demo', ownerName: 'Sven South', cropProduct: 'Barley (grain)' },
        { slug: 'bigfarm-east', name: 'BigFarm — East Estate', ownerEmail: 'east@bigfarm.demo', ownerName: 'Elena East', cropProduct: 'Oilseed Rape' },
    ];
    const seededChildren: Record<string, { tenant: { id: string; slug: string }; owner: { id: string } }> = {};
    for (const farm of childFarms) {
        const res = await seedFarm(
            { ...farm, modules: ALL_MODULES, plan: 'ENTERPRISE', organizationId: org.id },
            pwd,
        );
        seededChildren[farm.slug] = { tenant: { id: res.tenant.id, slug: res.tenant.slug }, owner: { id: res.owner.id } };
    }

    // ── Certification schemes (global AG_SCHEME frameworks) ──
    // Import the two concept-only scheme catalogs (GlobalG.A.P. IFA + EU
    // Organic) through the SAME loader + applier the `schemes:import` CLI
    // uses, so the demo shows real, mappable schemes. Idempotent (the
    // applier upserts on `key`). Concept-only / paraphrased text — no
    // proprietary scheme wording (LICENSE hygiene; each file is marked
    // illustrative).
    const CATALOG_DIR = path.resolve(__dirname, '..', 'prisma', 'catalogs');
    // EVERY catalogue in the directory, not a hardcoded pair. Two of the four
    // shipped YAMLs were never loaded by anything automated — the list here
    // named two, and `schemes:import` is a manual CLI absent from db:seed, CI
    // and deploy/ — so a catalogue could be added to the repo and simply never
    // exist in any database. Reading the directory means adding a YAML is the
    // whole change.
    const schemeCatalogs = fs
        .readdirSync(CATALOG_DIR)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort();
    for (const fileName of schemeCatalogs) {
        try {
            const file = loadAndValidateCatalogFile(path.join(CATALOG_DIR, fileName));
            const result = await applyCatalogFile(prisma, file, path.join(CATALOG_DIR, fileName));
            console.log(
                `✅ Certification scheme: ${result.framework.key} (${result.requirements.upserted} requirements, ${result.templates.created} new templates)`,
            );
        } catch (e) {
            console.warn(`  ⚠️  scheme catalog ${fileName} skipped:`, e instanceof Error ? e.message : e);
        }
    }

    // ── Install the GlobalG.A.P. pack into one enterprise farm + show the
    //    spray → auto-evidence chain end-to-end. Direct prisma (Redis-free):
    //    replicate installPack's practice + PracticeRequirementLink writes so
    //    Practices mapped to the plant-protection requirements exist, then
    //    create one INPUT_APPLICATION spray record and let
    //    attachAutoEvidenceFromLogEntry mint the SUBMITTED scheme evidence.
    const GG_PACK_KEY = 'GLOBALGAP-IFA-DEMO-BASE';
    const north = seededChildren['bigfarm-north'];
    if (north) {
        try {
            await installSchemePackForDemo(north.tenant.id, north.owner.id, GG_PACK_KEY);
            await seedSprayAutoEvidence(north.tenant.id, north.tenant.slug, north.owner.id);
        } catch (e) {
            console.warn('  ⚠️  GlobalG.A.P. demo (pack + auto-evidence) skipped:', e instanceof Error ? e.message : e);
        }
        // Agro-intel demo data (weather obs + data stream) on North Estate.
        try {
            await seedAgroIntel(north.tenant.id);
        } catch (e) {
            console.warn('  ⚠️  Agro-intel demo seed skipped:', e instanceof Error ? e.message : e);
        }
        // Enterprise-grain demo data (bins / contracts / yield / costing) on
        // North Estate — it has the GRAIN module (ALL_MODULES) + ENTERPRISE plan.
        try {
            await seedGrainDemo(north.tenant.id, north.owner.id);
        } catch (e) {
            console.warn('  ⚠️  Enterprise-grain demo seed skipped:', e instanceof Error ? e.message : e);
        }
    }

    // Enterprise-grain demo data on a SECOND child farm (South Estate) so the
    // org-level grain portfolio dashboard aggregates non-zero figures across
    // MORE THAN ONE farm. `seedGrainDemo` is per-tenant idempotent (bins keyed
    // on (tenantId, key); lots/contracts/yields skip when a stable-key row
    // exists), so re-running the seed never duplicates. Illustrative figures
    // only — same marked-illustrative data shape as North Estate.
    const south = seededChildren['bigfarm-south'];
    if (south) {
        try {
            await seedGrainDemo(south.tenant.id, south.owner.id);
        } catch (e) {
            console.warn('  ⚠️  Enterprise-grain demo seed (South Estate) skipped:', e instanceof Error ? e.message : e);
        }
    }

    // Org admin who sees the whole portfolio.
    const orgAdmin = await upsertOwner('admin@bigfarm.demo', 'Olivia OrgAdmin', pwd);
    await prisma.orgMembership.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: orgAdmin.id } },
        update: {},
        create: { organizationId: org.id, userId: orgAdmin.id, role: 'ORG_ADMIN' },
    });
    // Auto-provision the org admin into each child farm as AUDITOR (portfolio read).
    const orgTenants = await prisma.tenant.findMany({ where: { organizationId: org.id }, select: { id: true } });
    for (const t of orgTenants) {
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: t.id, userId: orgAdmin.id } },
            update: {},
            create: { tenantId: t.id, userId: orgAdmin.id, role: 'AUDITOR', provisionedByOrgId: org.id },
        });
    }
    console.log(`✅ Org admin admin@bigfarm.demo provisioned across ${orgTenants.length} child farms`);

    console.log('\n🎉 Demo seed complete.');
    console.log('   Startup farmer : farmer@greenacres.demo  → /t/green-acres   (simple mode)');
    console.log('   Enterprise org : admin@bigfarm.demo       → /org/bigfarm-co  (portfolio)');
    console.log('   (password set via SEED_PASSWORD; default "password123")');
}

/**
 * Agro-intel demo data (direct prisma, Redis-free, idempotent).
 *
 * Seeds, for one bigfarm location:
 *   • ~10 days of WeatherObservation — a deliberately WARM-WET run so the
 *     disease-risk evaluator escalates to HIGH (≥3 consecutive conducive
 *     days) AND today's spray window reads UNSUITABLE (rain wash-off).
 *     This makes both signal classes demonstrable when the weather-pull
 *     job (or a manual evaluateLocationSignals) runs.
 *   • One DataStream (a leaf-wetness sensor) + a couple of readings.
 *   • A boundsJson on the location so the weather-pull job can derive a
 *     centroid and pull real Open-Meteo data on the next daily run.
 *
 * Idempotent: WeatherObservation upserts on (tenantId, locationId,
 * obsDate); the DataStream upserts on (tenantId, key); readings are
 * skipped when the stream already has rows.
 */
async function seedAgroIntel(tenantId: string): Promise<void> {
    const loc = await prisma.location.findFirst({
        where: { tenantId, name: 'Home Field' },
        select: { id: true, boundsJson: true },
    });
    if (!loc) return;

    // Give the field a bounding box (≈ a parcel in England) so the
    // weather-pull job can derive a centroid even before parcels exist.
    if (!loc.boundsJson) {
        await prisma.location.update({
            where: { id: loc.id },
            data: { boundsJson: [-1.21, 52.19, -1.19, 52.21] }, // [w, s, e, n]
        });
    }

    // 10 days ending today — warm + wet so disease pressure is HIGH and
    // today's spray window is UNSUITABLE (precip ≥ 2 mm wash-off limit).
    const today = new Date();
    for (let back = 9; back >= 0; back--) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
        const isToday = back === 0;
        const tempMaxC = 24;
        const tempMinC = 14;
        const tempMeanC = 19; // within disease band [10,30]
        const humidityMean = 93; // ≥ 90 ⇒ leaf-wetness proxy
        const precipMm = isToday ? 6 : 3; // ≥ 2 ⇒ spray UNSUITABLE today
        const windMaxKmh = 8;
        await prisma.weatherObservation.upsert({
            where: { tenantId_locationId_obsDate: { tenantId, locationId: loc.id, obsDate: d } },
            update: { source: 'seed-demo', tempMaxC, tempMinC, tempMeanC, precipMm, windMaxKmh, humidityMean },
            create: {
                tenantId,
                locationId: loc.id,
                obsDate: d,
                source: 'seed-demo',
                tempMaxC,
                tempMinC,
                tempMeanC,
                precipMm,
                windMaxKmh,
                humidityMean,
            },
        });
    }

    // A leaf-wetness sensor stream + a couple of readings.
    const stream = await prisma.dataStream.upsert({
        where: { tenantId_key: { tenantId, key: 'leaf-wetness-1' } },
        update: {},
        create: {
            tenantId,
            locationId: loc.id,
            key: 'leaf-wetness-1',
            name: 'Home Field — leaf wetness',
            kind: 'LEAF_WETNESS',
            unit: 'minutes',
            status: 'ACTIVE',
        },
        select: { id: true },
    });
    const existingReadings = await prisma.dataStreamReading.count({
        where: { tenantId, dataStreamId: stream.id },
    });
    if (existingReadings === 0) {
        await prisma.dataStreamReading.createMany({
            data: [
                {
                    tenantId,
                    dataStreamId: stream.id,
                    recordedAt: new Date(today.getTime() - 2 * 3600_000),
                    value: 420,
                    unit: 'minutes',
                },
                {
                    tenantId,
                    dataStreamId: stream.id,
                    recordedAt: new Date(today.getTime() - 1 * 3600_000),
                    value: 510,
                    unit: 'minutes',
                },
            ],
        });
    }
    console.log('✅ Agro-intel: 10d warm-wet weather + leaf-wetness stream seeded (disease + spray signals demonstrable)');
}

/**
 * Enterprise-grain demo data (direct prisma, Redis-free, idempotent) for a
 * grain-enabled ENTERPRISE farm. Illustrative figures only.
 *
 * Seeds:
 *   • Two BIN/STORAGE Locations with `capacityTonnes`.
 *   • A couple of HARVESTED_PRODUCE InventoryLots in those bins, each with
 *     grain-quality `attributesJson` (moisture / testWeight / protein) +
 *     an initial-stock RECEIPT (via the ledger writer) so bin fill shows.
 *   • 2–3 Contracts (a SALE + a PURCHASE, varied status), with encrypted
 *     terms/pricingNotes round-tripping through the middleware.
 *   • A few YieldRecords linked to existing plantings / the field.
 *   • One INPUT_APPLICATION LogEntry carrying a `costAmount` + a LogPlanting
 *     link + a CONSUMPTION StockTransaction with a cost, so the per-activity
 *     cost rollup shows non-zero numbers.
 *
 * Idempotent: bins upsert on (tenantId, key); lots/contracts/yields skip
 * when a stable-key row already exists.
 */
async function seedGrainDemo(tenantId: string, userId: string): Promise<void> {
    const ctx: RequestContext = { ...ownerCtx(tenantId, userId), tenantSlug: undefined };

    // ── Bins (BIN/STORAGE Locations with capacity) ──
    async function ensureBin(key: string, name: string, kind: 'BIN' | 'STORAGE', capacityTonnes: number) {
        const existing = await prisma.location.findFirst({ where: { tenantId, key } });
        if (existing) return existing;
        return prisma.location.create({
            data: { tenantId, key, name, kind, capacityTonnes, createdByUserId: userId },
        });
    }
    const binA = await ensureBin('grain-bin-a', 'Grain Bin A (illustrative)', 'BIN', 500);
    await ensureBin('grain-store-1', 'Main Grain Store (illustrative)', 'STORAGE', 2000);

    // ── A HARVESTED_PRODUCE item + two lots stored in Bin A ──
    const kg = await prisma.unit.findUnique({ where: { key: 'kg' } });
    let produce = await prisma.item.findFirst({ where: { tenantId, category: 'HARVESTED_PRODUCE' } });
    if (!produce && kg) {
        produce = await prisma.item.create({
            data: { tenantId, name: 'Milling Wheat (harvest)', category: 'HARVESTED_PRODUCE', defaultUnitId: kg.id, createdByUserId: userId },
        });
    }
    if (produce) {
        const lotSpecs = [
            { code: 'WHEAT-A1', qty: 180, attrs: { moisture: 13.2, testWeight: 78, protein: 12.1 } },
            { code: 'WHEAT-A2', qty: 140, attrs: { moisture: 14.0, testWeight: 76, protein: 11.4 } },
        ];
        for (const spec of lotSpecs) {
            const existingLot = await prisma.inventoryLot.findFirst({ where: { tenantId, itemId: produce.id, lotCode: spec.code } });
            if (existingLot) continue;
            try {
                await createLot(ctx, {
                    itemId: produce.id,
                    lotCode: spec.code,
                    locationId: binA.id,
                    initialQuantity: spec.qty,
                });
                // Stamp grain-quality attributes on the lot (createLot doesn't take attrs).
                await prisma.inventoryLot.updateMany({
                    where: { tenantId, itemId: produce.id, lotCode: spec.code },
                    data: { attributesJson: spec.attrs },
                });
            } catch (e) {
                console.warn(`  ⚠️  grain lot ${spec.code} skipped:`, e instanceof Error ? e.message : e);
            }
        }
    }

    // ── Contracts (a SALE + a PURCHASE + a settled SALE) ──
    const season = await prisma.season.findFirst({ where: { tenantId, key: 'demo-season' }, select: { id: true } });
    const contractSpecs = [
        { key: 'SALE-2026-001', counterparty: 'Acme Mills Ltd', commodity: 'Milling Wheat', type: 'SALE' as const, status: 'ACTIVE' as const, volumeTonnes: 500, pricePerTonne: 235.5, terms: 'Illustrative: 500t milling wheat, FOB farm gate, EUR. Quality spec 13% protein min.', pricingNotes: 'Illustrative: basis +12 over Dec MATIF, locked 2026-05-01.' },
        { key: 'BUY-2026-002', counterparty: 'AgChem Supplies', commodity: 'Liquid Nitrogen 28%', type: 'PURCHASE' as const, status: 'DRAFT' as const, volumeTonnes: 40, pricePerTonne: 310, terms: 'Illustrative: forward purchase of N28 fertiliser for spring application.', pricingNotes: null },
        { key: 'SALE-2025-099', counterparty: 'Northern Grain Co', commodity: 'Feed Barley', type: 'SALE' as const, status: 'SETTLED' as const, volumeTonnes: 320, pricePerTonne: 188, terms: 'Illustrative: settled prior-season feed barley sale.', pricingNotes: null },
    ];
    for (const spec of contractSpecs) {
        const existing = await prisma.contract.findFirst({ where: { tenantId, key: spec.key } });
        if (existing) continue;
        await prisma.contract.create({
            data: {
                tenantId,
                seasonId: season?.id ?? null,
                key: spec.key,
                counterparty: spec.counterparty,
                commodity: spec.commodity,
                type: spec.type,
                status: spec.status,
                volumeTonnes: spec.volumeTonnes,
                pricePerTonne: spec.pricePerTonne,
                priceCurrency: 'EUR',
                deliveryStart: new Date(Date.UTC(new Date().getUTCFullYear(), 8, 1)),
                deliveryEnd: new Date(Date.UTC(new Date().getUTCFullYear(), 9, 31)),
                terms: spec.terms,
                pricingNotes: spec.pricingNotes,
            },
        });
    }

    // ── Yield records linked to existing plantings / the field ──
    const field = await prisma.location.findFirst({ where: { tenantId, name: 'Home Field' }, select: { id: true } });
    const plantings = await prisma.planting.findMany({ where: { tenantId }, select: { id: true }, take: 2 });
    const existingYield = await prisma.yieldRecord.findFirst({ where: { tenantId }, select: { id: true } });
    if (!existingYield) {
        const yieldSpecs = [
            { commodity: 'Milling Wheat', grossTonnes: 182.4, moisturePct: 13.5, areaHa: 24, plantingId: plantings[0]?.id ?? null, valuationNotes: 'Illustrative: valued at spot; quality premium for protein.' },
            { commodity: 'Feed Barley', grossTonnes: 96.0, moisturePct: 14.8, areaHa: 16, plantingId: plantings[1]?.id ?? null, valuationNotes: 'Illustrative: held for Q1 carry.' },
        ];
        for (const spec of yieldSpecs) {
            await prisma.yieldRecord.create({
                data: {
                    tenantId,
                    plantingId: spec.plantingId,
                    locationId: field?.id ?? null,
                    seasonId: season?.id ?? null,
                    commodity: spec.commodity,
                    harvestedAt: new Date(Date.UTC(new Date().getUTCFullYear(), 8, 15)),
                    grossTonnes: spec.grossTonnes,
                    moisturePct: spec.moisturePct,
                    areaHa: spec.areaHa,
                    valuationNotes: spec.valuationNotes,
                },
            });
        }
    }

    // ── A costed field event so the cost rollup is non-zero ──
    // One INPUT_APPLICATION LogEntry with a costAmount + a LogPlanting link
    // to the first planting; the cost rollup joins Planting → LogPlanting →
    // LogEntry.costAmount (and any linked StockTransaction.costAmount).
    if (plantings[0]) {
        const already = await prisma.logPlanting.findFirst({ where: { tenantId, plantingId: plantings[0].id }, select: { id: true } });
        if (!already) {
            const entry = await prisma.logEntry.create({
                data: {
                    tenantId,
                    type: 'INPUT_APPLICATION',
                    status: 'DONE',
                    occurredAt: new Date(),
                    title: 'Applied nitrogen to wheat (illustrative, costed)',
                    notes: '<p>Illustrative costed field event — backs the per-activity cost rollup.</p>',
                    costAmount: 1250,
                    costCurrency: 'EUR',
                    createdByUserId: userId,
                },
                select: { id: true },
            });
            await prisma.logPlanting
                .create({ data: { tenantId, logEntryId: entry.id, plantingId: plantings[0].id, stage: 'SOW' } })
                .catch(() => {});
        }
    }

    console.log('✅ Enterprise-grain: bins + produce lots + contracts + yield records + a costed field event seeded (illustrative)');
}

main()
    .catch((err) => {
        console.error('Demo seed failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
        // Force exit — a lazily-opened BullMQ/Redis handle from a usecase
        // can keep the event loop alive after the work is done (Redis is
        // absent in dev). The data is committed; exit deterministically.
        process.exit(process.exitCode ?? 0);
    });
