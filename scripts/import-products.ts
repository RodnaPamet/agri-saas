#!/usr/bin/env tsx
/**
 * Seed the input-product catalog (Item rows of category PESTICIDE /
 * FERTILIZER / AMENDMENT) with GENERIC, ILLUSTRATIVE product archetypes.
 *
 * Content provenance + LICENSE: these are GENERIC, ILLUSTRATIVE product
 * archetypes — NOT a real proprietary label database. Every `name` is a
 * "Generic <active-ingredient> <concentration>" descriptor authored for
 * this seed; the `activeIngredient` values are public-domain generic
 * chemical / biological names (glyphosate, copper hydroxide, ammonium
 * nitrate, Bacillus thuringiensis…), never brand-specific label text.
 * The agronomic / regulatory metadata (mode-of-action group, signal
 * word, re-entry interval, pre-harvest interval, NPK) are generic
 * public-domain agronomy norms. NO proprietary product label, brand
 * name, or MSDS / safety-data-sheet text is copied. Operators replace
 * these archetypes with their own labelled products.
 *
 * Each archetype becomes an `Item` in the target tenant, with its
 * generic regulatory/agronomic metadata on `attributesJson` (no schema
 * change — the Item model already carries `attributesJson` for exactly
 * this). Idempotent: Item upserts on (tenantId, sku); re-running skips
 * rows already present. A real Unit (from import-units.ts) is required
 * as the item's `defaultUnitId`; this script resolves the global unit
 * by key (L for liquids, kg for dry products) and creates the unit
 * catalog first if it is empty.
 *
 * Usage:
 *   tsx scripts/import-products.ts                 # first tenant
 *   tsx scripts/import-products.ts --tenant <slug> # a specific tenant
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ItemCategory } from '@prisma/client';
import { importUnits } from './import-units';

/** Which global unit a product defaults to (resolved to a Unit.id). */
type UnitKey = 'l' | 'kg';

interface ProductSeed {
    /** Stable synthetic key — the idempotency natural key (Item.sku). */
    sku: string;
    name: string;
    category: ItemCategory;
    unitKey: UnitKey;
    reorderLevel?: number;
    /** Generic public-domain regulatory/agronomic metadata. */
    attributes: {
        activeIngredient: string;
        concentration: string;
        formulation: string;
        /** Mode-of-action / resistance group (generic classification). */
        moaGroup: string;
        signalWord?: 'CAUTION' | 'WARNING' | 'DANGER' | null;
        reEntryIntervalHours?: number | null;
        preHarvestIntervalDays?: number | null;
        /** Fertilizer guaranteed analysis, e.g. "34-0-0". */
        npk?: string | null;
        organicApproved?: boolean;
    };
}

/**
 * ~20 generic, illustrative product archetypes spanning PESTICIDE,
 * FERTILIZER, and AMENDMENT. Generic public-domain agronomy only — see
 * the LICENSE note above.
 */
export const PRODUCT_SEEDS: ProductSeed[] = [
    // ── PESTICIDE — herbicides ──
    {
        sku: 'PROD-GLYPH-360', name: 'Generic Glyphosate 360 SL', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 20,
        attributes: { activeIngredient: 'Glyphosate', concentration: '360 g/L', formulation: 'SL (soluble concentrate)', moaGroup: 'HRAC Group 9 (G)', signalWord: 'WARNING', reEntryIntervalHours: 12, preHarvestIntervalDays: 7, organicApproved: false },
    },
    {
        sku: 'PROD-2,4-D-500', name: 'Generic 2,4-D Amine 500 SL', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 10,
        attributes: { activeIngredient: '2,4-D dimethylamine', concentration: '500 g/L', formulation: 'SL (soluble concentrate)', moaGroup: 'HRAC Group 4 (O)', signalWord: 'DANGER', reEntryIntervalHours: 48, preHarvestIntervalDays: 14, organicApproved: false },
    },
    {
        sku: 'PROD-PENDI-330', name: 'Generic Pendimethalin 330 EC', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 10,
        attributes: { activeIngredient: 'Pendimethalin', concentration: '330 g/L', formulation: 'EC (emulsifiable concentrate)', moaGroup: 'HRAC Group 3 (K1)', signalWord: 'CAUTION', reEntryIntervalHours: 24, preHarvestIntervalDays: 60, organicApproved: false },
    },
    // ── PESTICIDE — fungicides ──
    {
        sku: 'PROD-CU-OH-WP', name: 'Generic Copper Hydroxide WP', category: 'PESTICIDE', unitKey: 'kg', reorderLevel: 5,
        attributes: { activeIngredient: 'Copper hydroxide', concentration: '538 g/kg', formulation: 'WP (wettable powder)', moaGroup: 'FRAC Group M01 (multi-site)', signalWord: 'WARNING', reEntryIntervalHours: 24, preHarvestIntervalDays: 1, organicApproved: true },
    },
    {
        sku: 'PROD-SULFUR-WG', name: 'Generic Wettable Sulfur 80 WG', category: 'PESTICIDE', unitKey: 'kg', reorderLevel: 5,
        attributes: { activeIngredient: 'Sulfur', concentration: '800 g/kg', formulation: 'WG (water-dispersible granule)', moaGroup: 'FRAC Group M02 (multi-site)', signalWord: 'CAUTION', reEntryIntervalHours: 24, preHarvestIntervalDays: 0, organicApproved: true },
    },
    {
        sku: 'PROD-CHLORO-720', name: 'Generic Chlorothalonil 720 SC', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 10,
        attributes: { activeIngredient: 'Chlorothalonil', concentration: '720 g/L', formulation: 'SC (suspension concentrate)', moaGroup: 'FRAC Group M05 (multi-site)', signalWord: 'DANGER', reEntryIntervalHours: 12, preHarvestIntervalDays: 7, organicApproved: false },
    },
    {
        sku: 'PROD-AZOXY-250', name: 'Generic Azoxystrobin 250 SC', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 5,
        attributes: { activeIngredient: 'Azoxystrobin', concentration: '250 g/L', formulation: 'SC (suspension concentrate)', moaGroup: 'FRAC Group 11 (QoI)', signalWord: 'CAUTION', reEntryIntervalHours: 4, preHarvestIntervalDays: 14, organicApproved: false },
    },
    // ── PESTICIDE — insecticides (incl. biologicals) ──
    {
        sku: 'PROD-BT-KURST', name: 'Generic Bt kurstaki', category: 'PESTICIDE', unitKey: 'kg', reorderLevel: 2,
        attributes: { activeIngredient: 'Bacillus thuringiensis subsp. kurstaki', concentration: '32,000 IU/mg', formulation: 'WP (wettable powder)', moaGroup: 'IRAC Group 11A (microbial)', signalWord: 'CAUTION', reEntryIntervalHours: 4, preHarvestIntervalDays: 0, organicApproved: true },
    },
    {
        sku: 'PROD-SPINOSAD-SC', name: 'Generic Spinosad 120 SC', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 3,
        attributes: { activeIngredient: 'Spinosad', concentration: '120 g/L', formulation: 'SC (suspension concentrate)', moaGroup: 'IRAC Group 5 (spinosyns)', signalWord: 'CAUTION', reEntryIntervalHours: 4, preHarvestIntervalDays: 1, organicApproved: true },
    },
    {
        sku: 'PROD-IMID-200', name: 'Generic Imidacloprid 200 SL', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 5,
        attributes: { activeIngredient: 'Imidacloprid', concentration: '200 g/L', formulation: 'SL (soluble concentrate)', moaGroup: 'IRAC Group 4A (neonicotinoid)', signalWord: 'WARNING', reEntryIntervalHours: 12, preHarvestIntervalDays: 21, organicApproved: false },
    },
    {
        sku: 'PROD-PYRE-OIL', name: 'Generic Pyrethrin + Oil', category: 'PESTICIDE', unitKey: 'l', reorderLevel: 3,
        attributes: { activeIngredient: 'Pyrethrins', concentration: '50 g/L', formulation: 'EC (emulsifiable concentrate)', moaGroup: 'IRAC Group 3A (pyrethrin)', signalWord: 'CAUTION', reEntryIntervalHours: 12, preHarvestIntervalDays: 0, organicApproved: true },
    },
    // ── FERTILIZER — straight + compound ──
    {
        sku: 'PROD-AN-34-0-0', name: 'Generic Ammonium Nitrate 34-0-0', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 500,
        attributes: { activeIngredient: 'Ammonium nitrate', concentration: '34% N', formulation: 'Prilled granule', moaGroup: 'Nitrogen (straight)', signalWord: null, reEntryIntervalHours: null, preHarvestIntervalDays: null, npk: '34-0-0', organicApproved: false },
    },
    {
        sku: 'PROD-UREA-46-0-0', name: 'Generic Urea 46-0-0', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 500,
        attributes: { activeIngredient: 'Urea', concentration: '46% N', formulation: 'Prilled granule', moaGroup: 'Nitrogen (straight)', signalWord: null, npk: '46-0-0', organicApproved: false },
    },
    {
        sku: 'PROD-MAP-11-52-0', name: 'Generic MAP 11-52-0', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 250,
        attributes: { activeIngredient: 'Monoammonium phosphate', concentration: '11% N, 52% P2O5', formulation: 'Granule', moaGroup: 'Phosphate (compound)', signalWord: null, npk: '11-52-0', organicApproved: false },
    },
    {
        sku: 'PROD-MOP-0-0-60', name: 'Generic Muriate of Potash 0-0-60', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 250,
        attributes: { activeIngredient: 'Potassium chloride', concentration: '60% K2O', formulation: 'Granule', moaGroup: 'Potash (straight)', signalWord: null, npk: '0-0-60', organicApproved: false },
    },
    {
        sku: 'PROD-NPK-15-15-15', name: 'Generic Compound NPK 15-15-15', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 250,
        attributes: { activeIngredient: 'NPK compound', concentration: '15% N, 15% P2O5, 15% K2O', formulation: 'Granule (blend)', moaGroup: 'Compound (balanced)', signalWord: null, npk: '15-15-15', organicApproved: false },
    },
    {
        sku: 'PROD-CAN-28-0-0', name: 'Generic Calcium Ammonium Nitrate 27-0-0', category: 'FERTILIZER', unitKey: 'kg', reorderLevel: 500,
        attributes: { activeIngredient: 'Calcium ammonium nitrate', concentration: '27% N', formulation: 'Granule', moaGroup: 'Nitrogen (straight)', signalWord: null, npk: '27-0-0', organicApproved: false },
    },
    {
        sku: 'PROD-UAN-32', name: 'Generic UAN Solution 32-0-0', category: 'FERTILIZER', unitKey: 'l', reorderLevel: 1000,
        attributes: { activeIngredient: 'Urea ammonium nitrate', concentration: '32% N', formulation: 'Liquid solution', moaGroup: 'Nitrogen (liquid)', signalWord: null, npk: '32-0-0', organicApproved: false },
    },
    // ── FERTILIZER — organic-approved ──
    {
        sku: 'PROD-FISH-EMUL', name: 'Generic Fish Emulsion 5-1-1', category: 'FERTILIZER', unitKey: 'l', reorderLevel: 20,
        attributes: { activeIngredient: 'Hydrolysed fish', concentration: '5% N, 1% P2O5, 1% K2O', formulation: 'Liquid', moaGroup: 'Organic nitrogen', signalWord: null, npk: '5-1-1', organicApproved: true },
    },
    // ── AMENDMENT — soil conditioners ──
    {
        sku: 'PROD-AG-LIME', name: 'Generic Agricultural Lime (CaCO3)', category: 'AMENDMENT', unitKey: 'kg', reorderLevel: 1000,
        attributes: { activeIngredient: 'Calcium carbonate', concentration: '95% CaCO3', formulation: 'Ground / pulverised', moaGroup: 'Liming agent (pH)', signalWord: null, organicApproved: true },
    },
    {
        sku: 'PROD-GYPSUM', name: 'Generic Gypsum (Calcium Sulfate)', category: 'AMENDMENT', unitKey: 'kg', reorderLevel: 500,
        attributes: { activeIngredient: 'Calcium sulfate dihydrate', concentration: '23% Ca, 18% S', formulation: 'Granule / pulverised', moaGroup: 'Soil conditioner (Ca/S)', signalWord: null, organicApproved: true },
    },
    {
        sku: 'PROD-ELEM-SULFUR', name: 'Generic Elemental Sulfur (Soil)', category: 'AMENDMENT', unitKey: 'kg', reorderLevel: 250,
        attributes: { activeIngredient: 'Elemental sulfur', concentration: '90% S', formulation: 'Granule', moaGroup: 'Acidifying agent (pH)', signalWord: null, organicApproved: true },
    },
];

export interface ImportProductsResult {
    tenantId: string;
    created: number;
    skipped: number;
}

/**
 * Resolve a global Unit by key, seeding the unit catalog first if it is
 * empty (so this importer works standalone, not only after import-units).
 */
async function resolveUnitId(prisma: PrismaClient, key: UnitKey): Promise<string> {
    let unit = await prisma.unit.findUnique({ where: { key }, select: { id: true } });
    if (!unit) {
        await importUnits(prisma);
        unit = await prisma.unit.findUnique({ where: { key }, select: { id: true } });
    }
    if (!unit) throw new Error(`Unit "${key}" not found and could not be seeded`);
    return unit.id;
}

/** Seed the product catalog into a tenant. Idempotent on (tenantId, sku). */
export async function importProducts(
    prisma: PrismaClient,
    opts: { tenantSlug?: string; tenantId?: string } = {},
): Promise<ImportProductsResult> {
    const tenant = opts.tenantId
        ? await prisma.tenant.findUnique({ where: { id: opts.tenantId }, select: { id: true } })
        : opts.tenantSlug
            ? await prisma.tenant.findUnique({ where: { slug: opts.tenantSlug }, select: { id: true } })
            : await prisma.tenant.findFirst({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!tenant) throw new Error(`No tenant found${opts.tenantSlug ? ` for slug "${opts.tenantSlug}"` : ''}`);

    // Resolve the two units once (L for liquids, kg for dry products).
    const unitIds: Record<UnitKey, string> = {
        l: await resolveUnitId(prisma, 'l'),
        kg: await resolveUnitId(prisma, 'kg'),
    };

    let created = 0;
    let skipped = 0;

    for (const p of PRODUCT_SEEDS) {
        // Item — upsert on (tenantId, sku). The schema has no compound
        // unique on (tenantId, sku), so guard with a findFirst.
        const existing = await prisma.item.findFirst({
            where: { tenantId: tenant.id, sku: p.sku },
            select: { id: true },
        });
        if (existing) {
            skipped++;
            continue;
        }
        await prisma.item.create({
            data: {
                tenantId: tenant.id,
                name: p.name,
                category: p.category,
                sku: p.sku,
                defaultUnitId: unitIds[p.unitKey],
                reorderLevel: p.reorderLevel ?? null,
                // Marked at creation, not inferred later (#1078). Everything
                // this script writes is a generic illustrative archetype by
                // construction — that is the whole licensing rationale in the
                // docblock above — so it is the one place that KNOWS, and a
                // flag set here never has to be reconstructed from a name
                // prefix or the absence of a creator.
                isArchetype: true,
                attributesJson: p.attributes,
            },
        });
        created++;
    }

    return { tenantId: tenant.id, created, skipped };
}

async function main(): Promise<number> {
    const tenantIdx = process.argv.indexOf('--tenant');
    const tenantSlug = tenantIdx >= 0 ? process.argv[tenantIdx + 1] : undefined;
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    try {
        const res = await importProducts(prisma, { tenantSlug });
        console.log(
            `Products import: tenant ${res.tenantId} — ${res.created} products created, ` +
                `${res.skipped} already present.`,
        );
        return 0;
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error('Products import failed:', err);
        process.exit(1);
    });
}
