/**
 * Agriculture demo fixture — the canonical tier-1 dataset shared by the
 * ag E2E suite, the ag integration tests, and the dev seed.
 *
 * Shape (the "3 fields / 10 parcels / 5 products / 2 spray jobs" baseline):
 *   • 3 Locations (fields): North Farm, River Bottom, Hill Block
 *   • 10 Parcels with real PostGIS geometry (4 / 3 / 3 across the fields)
 *   • 5 catalog Products (PESTICIDE × 2, FERTILIZER × 2, AMENDMENT × 1),
 *     each with an InventoryLot carrying opening stock
 *   • 2 SPRAY field-operation jobs (one per of the first two fields),
 *     each prescribing a product + dose over that field's parcels
 *
 * It drives the REAL usecases (createLocation / createParcel /
 * createItem / createLot / createFieldOperation) under the caller's
 * tenant context, so the seeded rows are byte-identical to
 * production-created data: parcels get areaHa from `ST_Area`, lots get a
 * hash-chained RECEIPT, jobs get OperationParcel lines + a Task. Marking
 * a job line DONE later deducts dose×area from the FEFO lot — the tier-1
 * financial path the suite asserts.
 *
 * Units are GLOBAL (no tenant scope); we upsert the four we need by their
 * canonical key so the fixture is self-contained on a fresh DB.
 *
 * Idempotent-enough for tests: every call creates a fresh graph in the
 * caller's (typically isolated/empty) tenant. Returns all created ids for
 * assertions.
 */
import type { Polygon } from 'geojson';
import type { RequestContext } from '@/app-layer/types';
import { prisma } from '@/lib/prisma';
import { createLocation } from '@/app-layer/usecases/location';
import { createParcel } from '@/app-layer/usecases/parcel';
import { createItem } from '@/app-layer/usecases/catalog';
import { createLot } from '@/app-layer/usecases/inventory';
import { createFieldOperation } from '@/app-layer/usecases/field-operation';

export interface AgDemoUnits {
    /** L/ha — RATE dose unit (dose × area on spray completion). */
    lPerHa: string;
    /** L — VOLUME, the liquid-product stock unit. */
    litre: string;
    /** kg — WEIGHT, the solid-product stock unit. */
    kg: string;
    /** kg/ha — RATE dose unit for granular inputs. */
    kgPerHa: string;
}

export interface AgDemoLocation {
    id: string;
    name: string;
    parcelIds: string[];
}

export interface AgDemoProduct {
    id: string;
    name: string;
    category: string;
    /** The product's stock unit (== its lot unit). */
    unitId: string;
    /** Opening-stock lot for this product. */
    lotId: string;
    lotCode: string;
}

export interface AgDemoJob {
    taskId: string;
    taskKey: string | null;
    locationId: string;
    parcelIds: string[];
    productItemId: string;
    doseValue: number;
    doseUnitId: string;
}

export interface AgDemoResult {
    units: AgDemoUnits;
    locations: AgDemoLocation[];
    /** Flat list of every parcel created, across all three fields. */
    parcels: Array<{ id: string; locationId: string; name: string; areaHa: number | null }>;
    products: AgDemoProduct[];
    jobs: AgDemoJob[];
}

/** A small WGS84 square polygon at the given lon/lat origin (≈ a field block). */
function square(lon: number, lat: number, size = 0.01): Polygon {
    return {
        type: 'Polygon',
        coordinates: [[
            [lon, lat],
            [lon + size, lat],
            [lon + size, lat + size],
            [lon, lat + size],
            [lon, lat],
        ]],
    };
}

/** Upsert a global Unit by its canonical key (idempotent across tenants). */
async function ensureUnit(key: string, name: string, symbol: string, measure: string): Promise<string> {
    const unit = await prisma.unit.upsert({
        where: { key },
        update: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- QuantityMeasure enum cast
        create: { key, name, symbol, measure: measure as any },
        select: { id: true },
    });
    return unit.id;
}

/**
 * Seed the demo agriculture graph into the caller's tenant. The ctx must
 * be an OWNER/EDITOR context for an existing tenant whose user is an
 * ACTIVE member (the E2E isolated-tenant owner, or an integration-test
 * seeded owner).
 */
export async function seedAgDemo(ctx: RequestContext): Promise<AgDemoResult> {
    // ── Units (global, shared by key) ───────────────────────────────
    const units: AgDemoUnits = {
        lPerHa: await ensureUnit('l-per-ha', 'Litres per hectare', 'L/ha', 'RATE'),
        litre: await ensureUnit('l', 'Litre', 'L', 'VOLUME'),
        kg: await ensureUnit('kg', 'Kilogram', 'kg', 'WEIGHT'),
        kgPerHa: await ensureUnit('kg-per-ha', 'Kilograms per hectare', 'kg/ha', 'RATE'),
    };

    // ── 3 fields, 10 parcels (4 / 3 / 3) ────────────────────────────
    const fieldSpecs: Array<{ name: string; lon: number; lat: number; parcels: number; crop: string }> = [
        { name: 'North Farm', lon: -1.10, lat: 52.20, parcels: 4, crop: 'Winter Wheat' },
        { name: 'River Bottom', lon: -1.05, lat: 52.18, parcels: 3, crop: 'Spring Barley' },
        { name: 'Hill Block', lon: -1.02, lat: 52.22, parcels: 3, crop: 'Oilseed Rape' },
    ];

    const locations: AgDemoLocation[] = [];
    const parcels: AgDemoResult['parcels'] = [];

    for (const f of fieldSpecs) {
        const loc = await createLocation(ctx, {
            name: f.name,
            description: `Demo field — ${f.crop}.`,
        });
        const parcelIds: string[] = [];
        for (let i = 0; i < f.parcels; i++) {
            // Lay each parcel out on a row so none overlap.
            const geom = square(f.lon + i * 0.012, f.lat, 0.01);
            const p = await createParcel(ctx, loc.id, {
                name: `${f.name} P${i + 1}`,
                cropType: f.crop,
                geometry: geom,
            });
            parcelIds.push(p.id);
            parcels.push({ id: p.id, locationId: loc.id, name: `${f.name} P${i + 1}`, areaHa: p.areaHa });
        }
        locations.push({ id: loc.id, name: f.name, parcelIds });
    }

    // ── 5 products + an opening-stock lot each ──────────────────────
    //
    // The two PESTICIDE rows carry a registration number and quarantine
    // period because `createItem` now REQUIRES them for that category
    // (#1078) — both print in the ДНЕВНИК, so a pesticide without them
    // cannot produce a complete register. The values are illustrative, like
    // the rest of this fixture; what matters is that the fixture exercises
    // the same contract a real caller must satisfy rather than a laxer one.
    const productSpecs: Array<{
        name: string;
        category: 'PESTICIDE' | 'FERTILIZER' | 'AMENDMENT';
        unitId: string; lotCode: string; opening: number; reorder: number;
        pppRegistrationNo?: string; quarantinePeriodDays?: number;
    }> = [
        { name: 'Glyphosate 360 SL', category: 'PESTICIDE', unitId: units.litre, lotCode: 'GLY-2026-01', opening: 1000, reorder: 50, pppRegistrationNo: 'DEMO-0001-ПРЗ', quarantinePeriodDays: 30 },
        { name: 'Mancozeb 75% WP', category: 'PESTICIDE', unitId: units.kg, lotCode: 'MAN-2026-01', opening: 500, reorder: 25, pppRegistrationNo: 'DEMO-0002-ПРЗ', quarantinePeriodDays: 21 },
        { name: 'Calcium Nitrate', category: 'FERTILIZER', unitId: units.kg, lotCode: 'CAN-2026-01', opening: 2000, reorder: 200 },
        { name: 'Aqua Ammonium 28%', category: 'FERTILIZER', unitId: units.litre, lotCode: 'AQN-2026-01', opening: 1500, reorder: 100 },
        { name: 'Sulfur Granule', category: 'AMENDMENT', unitId: units.kg, lotCode: 'SUL-2026-01', opening: 800, reorder: 40 },
    ];

    const products: AgDemoProduct[] = [];
    for (const s of productSpecs) {
        const item = await createItem(ctx, {
            name: s.name,
            category: s.category,
            defaultUnitId: s.unitId,
            reorderLevel: s.reorder,
            pppRegistrationNo: s.pppRegistrationNo ?? null,
            quarantinePeriodDays: s.quarantinePeriodDays ?? null,
        });
        const lot = await createLot(ctx, {
            itemId: item.id,
            lotCode: s.lotCode,
            initialQuantity: s.opening,
        });
        products.push({
            id: item.id,
            name: item.name,
            category: item.category,
            unitId: s.unitId,
            lotId: lot.id,
            lotCode: s.lotCode,
        });
    }

    // ── 2 SPRAY jobs (one over each of the first two fields) ─────────
    const jobs: AgDemoJob[] = [];
    const jobSpecs: Array<{ locIdx: number; product: AgDemoProduct; dose: number }> = [
        { locIdx: 0, product: products[0], dose: 2 }, // Glyphosate @ 2 L/ha over North Farm
        { locIdx: 1, product: products[3], dose: 3 }, // Aqua Ammonium @ 3 L/ha over River Bottom
    ];
    for (const j of jobSpecs) {
        const loc = locations[j.locIdx];
        const op = await createFieldOperation(ctx, loc.id, {
            operationType: 'SPRAY',
            assigneeUserId: ctx.userId,
            parcelIds: loc.parcelIds,
            productItemId: j.product.id,
            doseValue: j.dose,
            doseUnitId: units.lPerHa,
            targetNote: `Apply ${j.product.name} at ${j.dose} L/ha.`,
        });
        jobs.push({
            taskId: op.taskId,
            taskKey: op.taskKey,
            locationId: loc.id,
            parcelIds: loc.parcelIds,
            productItemId: j.product.id,
            doseValue: j.dose,
            doseUnitId: units.lPerHa,
        });
    }

    return { units, locations, parcels, products, jobs };
}
