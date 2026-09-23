/**
 * "Try it with sample data" — a small, realistic, REVERSIBLE dataset
 * seeded into the farmer's OWN tenant (not a separate demo tenant).
 *
 * Every row the loader writes is tagged `isSampleData: true` on the eight
 * ag models that carry the flag (Location, Parcel, InventoryLot, LogEntry,
 * and — since the grain chain was added — CropType, Season, CropPlan,
 * Planting). The one-tap clear soft-deletes exactly those rows — tenant-
 * scoped, idempotent, nothing else touched.
 *
 * ── Why the planning chain is here ──
 *
 * The grain calculator reports NOTHING without it. It reads Plantings,
 * resolves each one's CropPlan -> CropType to a canonical commodity, and
 * prices that against the global market series. A tenant with sample
 * locations, parcels, stock and journal entries still saw an empty
 * calculator, which is the one screen where "no data" and "broken" look
 * identical. The four planning models gained `isSampleData` in the same
 * change so this chain is as clearable as the rest — untagged planning
 * rows would be indistinguishable from a farmer's real season.
 *
 * Why direct prisma writes (not the createLocation / createParcel /
 * createLot usecases):
 *   • None of those usecases accept an `isSampleData` flag, so reusing
 *     them would force a create-then-flag follow-up UPDATE per row.
 *   • createLocation runs the FREE-plan entitlement gate
 *     (assertWithinLimit) — a sample dataset must never be blocked by
 *     (or count against) a tenant's plan caps.
 *   • createParcel requires real PostGIS geometry + a validity check;
 *     the sample parcels are illustrative names only (geometry is
 *     nullable), matching the seed-demo "we just want the row" convention.
 *   • createLot routes through the hash-chained stock-ledger writer
 *     (appendStockTransaction) for initial stock; a sample lot just
 *     needs to exist (quantityOnHand 0), again per the seed convention.
 * So we write directly INSIDE runInTenantContext (RLS-bound) with an
 * explicit `tenantId` on every row (defence in depth) and the tag set at
 * insert time — the cleanest atomic path that keeps all four models
 * tagged. `assertCanWrite(ctx)` gates the mutations, mirroring the
 * sibling create usecases.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { Prisma } from '@prisma/client';
import type { Polygon } from 'geojson';
import { repairedGeometrySql, areaHectaresNonNullSql } from '@/lib/db/geo';
import { ParcelRepository } from '../repositories/ParcelRepository';

/** Marketing-grade but illustrative — one field, a few parcels. */
const SAMPLE_LOCATION_NAME = 'Sample field';
const SAMPLE_PARCEL_NAMES = ['North block', 'South block', 'River strip'];

/**
 * SYNTHETIC parcel outlines — invented rectangles, not anyone's real field.
 *
 * Without geometry a sample location cannot demonstrate the product at all:
 * the schematic map, the parcel tap and the whole vegetation-index overlay
 * have nothing to draw, and `boundsJson` stays null so a client frames the
 * location at its no-data fallback. That was the state until now — three
 * parcels, zero drawable — and it reads as a broken map rather than as
 * absent data.
 *
 * Placed on the Danubian plain near Dolna Mitropolia: arable, unremarkable,
 * and deliberately nowhere near any tenant's real holdings. Real parcel
 * geometry must never be committed to this repository — it is public.
 *
 * **They total ~12 ha on purpose.** `SAMPLE_AREA_M2` declares a 12 ha
 * planting and the calculator's 60 t standing crop is 12 ha x 5 t/ha, so
 * parcels of any other size would make the sample data contradict its own
 * arithmetic on the one screen a reader is most likely to check it against.
 * Roughly 4 ha each: two blocks and a narrower strip, sharing edges the way
 * real blocks do.
 *
 * Rings are closed and wound counter-clockwise; `repairedGeometrySql` runs
 * `ST_MakeValid` over them regardless, and PostGIS computes the stored
 * `areaHa` from the polygon itself rather than from arithmetic here.
 */
const SAMPLE_PARCEL_GEOMETRY: readonly Polygon[] = [
    // North block — ~4.05 ha
    {
        type: 'Polygon',
        coordinates: [[
            [24.6000, 43.4518], [24.6025, 43.4518],
            [24.6025, 43.4536], [24.6000, 43.4536], [24.6000, 43.4518],
        ]],
    },
    // South block — ~4.05 ha, sharing the north block's southern edge
    {
        type: 'Polygon',
        coordinates: [[
            [24.6000, 43.4500], [24.6025, 43.4500],
            [24.6025, 43.4518], [24.6000, 43.4518], [24.6000, 43.4500],
        ]],
    },
    // River strip — ~3.89 ha, narrower and taller, along the eastern edge
    {
        type: 'Polygon',
        coordinates: [[
            [24.6025, 43.4500], [24.6037, 43.4500],
            [24.6037, 43.4536], [24.6025, 43.4536], [24.6025, 43.4500],
        ]],
    },
];
const SAMPLE_CROP_NAME = 'Пшеница';
/** Must be a slug the GLOBAL market series actually carries, or the
 *  calculator prices nothing and reports a refusal instead of a figure.
 *  'wheat' has by far the deepest price history of the available slugs. */
const SAMPLE_COMMODITY = 'wheat';
/** 12 ha, in m² — `Planting.areaM2` is the stored unit. */
const SAMPLE_AREA_M2 = 120_000;
/** 5 t/ha, a plausible Bulgarian wheat yield. */
const SAMPLE_YIELD_KG_PER_HA = 5_000;
/**
 * Carry-over grain in store, TONNES — plausible beside the 60 t standing
 * crop the planting above implies (12 ha x 5 t/ha).
 */
export const SAMPLE_LOT_TONNES = 18;
/**
 * The crop name is also the ITEM name, and the calculator derives a lot's
 * commodity from `normalizeCommodity(item.name)` while a CropType carries
 * `commodityCanonical` explicitly. Exported so a test can pin that those
 * two routes agree — if they ever diverge the standing crop and the grain
 * on hand land in DIFFERENT rows, which looks like working software.
 */
export const SAMPLE_COMMODITY_NAME = SAMPLE_CROP_NAME;
export const SAMPLE_COMMODITY_SLUG = SAMPLE_COMMODITY;

/**
 * True iff this tenant already holds a non-deleted sample-data Location.
 * The Location is the anchor row — its presence means a load already ran,
 * so `loadSampleData` no-ops and the UI can offer "Clear" instead.
 */
export async function hasSampleData(ctx: RequestContext): Promise<boolean> {
    const t = ctx.tenantId;
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.location.findFirst({
            where: { tenantId: t, isSampleData: true, deletedAt: null },
            select: { id: true },
        });
        return existing !== null;
    });
}

/**
 * Seed the sample dataset into the current tenant. Idempotent: no-ops
 * (returns `{ created: false }`) if sample data is already present.
 * Otherwise creates one Location + 2-3 Parcels + one InventoryLot +
 * 1-2 LogEntries, every row tagged `isSampleData: true`.
 */
export async function loadSampleData(ctx: RequestContext): Promise<{ created: boolean }> {
    assertCanWrite(ctx);
    if (await hasSampleData(ctx)) return { created: false };

    const t = ctx.tenantId;
    return runInTenantContext(ctx, async (db) => {
        // Re-check inside the RLS-bound context to keep the create
        // idempotent under a racing double-tap.
        const already = await db.location.findFirst({
            where: { tenantId: t, isSampleData: true, deletedAt: null },
            select: { id: true },
        });
        if (already) return { created: false };

        // ── Location (the anchor row) ──
        const location = await db.location.create({
            data: {
                tenantId: t,
                name: SAMPLE_LOCATION_NAME,
                description: 'Example field so you can see the app with data. Clear it any time.',
                kind: 'FIELD',
                isSampleData: true,
                createdByUserId: ctx.userId,
            },
            select: { id: true },
        });

        // ── 2-3 Parcels, WITH synthetic outlines ──
        //
        // Created one at a time rather than via `createMany` because the row
        // id is needed immediately to write `geometry`: it is an `Unsupported`
        // PostGIS column, so Prisma cannot set it and `createMany` returns no
        // ids. Same create-then-raw-UPDATE shape `ParcelRepository` uses for
        // a real import — `areaHa` is computed BY POSTGIS from the polygon,
        // never hand-written, so the stored area cannot drift from the shape.
        for (const [i, name] of SAMPLE_PARCEL_NAMES.entries()) {
            const parcelRow = await db.parcel.create({
                data: {
                    tenantId: t,
                    locationId: location.id,
                    name,
                    cropType: i === 0 ? 'Wheat' : i === 1 ? 'Barley' : 'Grass',
                    isSampleData: true,
                },
                select: { id: true },
            });
            const geomSql = repairedGeometrySql(SAMPLE_PARCEL_GEOMETRY[i]);
            await db.$executeRaw(
                Prisma.sql`UPDATE "Parcel"
                    SET "geometry" = ${geomSql},
                        "areaHa" = ${areaHectaresNonNullSql(geomSql)}
                    WHERE "id" = ${parcelRow.id} AND "tenantId" = ${t}`,
            );
        }

        // Location bounds, derived from the parcels just written rather than
        // from a bbox spelled out beside the polygons — the same call the
        // spatial import uses, so a sample location frames exactly like an
        // imported one. Null bounds is what left a client with nothing to
        // frame and sent it to its no-data fallback.
        const sampleBounds = await ParcelRepository.boundsForLocation(db, ctx, location.id);
        if (sampleBounds) {
            await db.location.update({
                where: { id: location.id },
                data: { boundsJson: sampleBounds as unknown as Prisma.InputJsonValue },
            });
        }

        // ── One InventoryLot of HARVESTED GRAIN ──
        //
        // This lot is the only thing exercising the calculator's "grain on
        // hand" arm, and `grain-net-worth` imposes three conditions that all
        // fail SILENTLY — an excluded lot is indistinguishable from no sample
        // data at all:
        //   1. the item's category must be HARVESTED_PRODUCE (the lot query
        //      filters on it),
        //   2. the lot's OWN unit must convert to tonnes, so it has to be a
        //      WEIGHT unit — any other and the lot is dropped as
        //      `lotsUnresolvedUnit`,
        //   3. `normalizeCommodity(item.name)` must resolve, and must resolve
        //      to the SAME commodity as the CropType's `commodityCanonical`,
        //      or the standing crop and the grain on hand split across two
        //      rows instead of describing one farm.
        //
        // The previous version reused whatever Item the tenant happened to
        // have and set no quantity: on a real farm that produced a PESTICIDE
        // lot holding zero, attached to the sample field. It satisfied none of
        // the three.
        //
        // Skip the lot entirely if no weight unit exists (the global unit
        // catalog hasn't been imported) — the rest of the dataset is still
        // useful without it.
        const unit =
            (await db.unit.findFirst({ where: { key: 'kg' }, select: { id: true, key: true } })) ??
            (await db.unit.findFirst({ where: { key: 't' }, select: { id: true, key: true } }));
        if (unit) {
            // `quantityOnHand` is denominated in the lot's own unit, so the
            // magnitude MUST follow the key that was actually found. Writing
            // the kg figure against a tonne unit would store 18 000 tonnes
            // and read back as a plausible-looking number.
            const quantityOnHand =
                unit.key === 't' ? SAMPLE_LOT_TONNES : SAMPLE_LOT_TONNES * 1_000;

            // Item carries no isSampleData flag (it is catalog, not tenant
            // data), so match on name+category rather than stacking a fresh
            // duplicate on every load/clear cycle.
            let item = await db.item.findFirst({
                where: {
                    tenantId: t,
                    name: SAMPLE_CROP_NAME,
                    category: 'HARVESTED_PRODUCE',
                    deletedAt: null,
                },
                select: { id: true },
            });
            if (!item) {
                item = await db.item.create({
                    data: {
                        tenantId: t,
                        name: SAMPLE_CROP_NAME,
                        category: 'HARVESTED_PRODUCE',
                        defaultUnitId: unit.id,
                        createdByUserId: ctx.userId,
                    },
                    select: { id: true },
                });
            }
            await db.inventoryLot.create({
                data: {
                    tenantId: t,
                    itemId: item.id,
                    lotCode: 'SAMPLE-LOT-001',
                    unitId: unit.id,
                    locationId: location.id,
                    quantityOnHand,
                    isSampleData: true,
                },
                select: { id: true },
            });
        }

        // ── 1-2 LogEntries ──
        await db.logEntry.createMany({
            data: [
                {
                    tenantId: t,
                    type: 'OBSERVATION',
                    status: 'DONE',
                    occurredAt: new Date(),
                    title: 'Crop emergence looking even across the field',
                    notes: '<p>Sample observation — good establishment after rain.</p>',
                    isSampleData: true,
                    createdByUserId: ctx.userId,
                },
                {
                    tenantId: t,
                    type: 'INPUT_APPLICATION',
                    status: 'DONE',
                    occurredAt: new Date(),
                    title: 'Applied nitrogen to the north block',
                    notes: '<p>Sample input-application record.</p>',
                    isSampleData: true,
                    createdByUserId: ctx.userId,
                },
            ],
        });

        // ── The grain chain: CropType -> Season -> CropPlan -> Planting ──
        //
        // Without this the calculator is empty. `commodityCanonical` is what
        // the net-worth usecase prices against the GLOBAL market series, so
        // it must be a slug that series actually carries — 'wheat' has the
        // deepest history of any of them. Hard-coding the canonical slug
        // rather than deriving it from the name keeps the sample dataset
        // working if `normalizeCommodity` ever changes how it reads Cyrillic.
        const cropType = await db.cropType.create({
            data: {
                tenantId: t,
                name: SAMPLE_CROP_NAME,
                commodityCanonical: SAMPLE_COMMODITY,
                isSampleData: true,
            },
            select: { id: true },
        });

        const year = new Date().getUTCFullYear();
        const season = await db.season.create({
            data: {
                tenantId: t,
                key: `sample-${year}`,
                name: `${year} — примерен сезон`,
                year,
                // March 1 → October 31, the temperate main growing window,
                // matching `seedDefaultSeason`'s choice rather than inventing
                // a second convention for the same thing.
                startDate: new Date(Date.UTC(year, 2, 1)),
                endDate: new Date(Date.UTC(year, 9, 31)),
                isSampleData: true,
            },
            select: { id: true },
        });

        const cropPlan = await db.cropPlan.create({
            data: {
                tenantId: t,
                seasonId: season.id,
                cropTypeId: cropType.id,
                name: `${SAMPLE_CROP_NAME} ${year}`,
                firstSowDate: new Date(Date.UTC(year, 2, 15)),
                isSampleData: true,
            },
            select: { id: true },
        });

        // Attach to a sample PARCEL so the calculator's row names a field the
        // farmer can see on the map, rather than reporting an area attached to
        // nothing. `createMany` above does not return ids, so re-read one.
        const parcel = await db.parcel.findFirst({
            where: { tenantId: t, locationId: location.id, isSampleData: true, deletedAt: null },
            select: { id: true },
            orderBy: { name: 'asc' },
        });

        await db.planting.create({
            data: {
                tenantId: t,
                cropPlanId: cropPlan.id,
                parcelId: parcel?.id ?? null,
                successionNumber: 1,
                // Wheat is drilled, not transplanted. PlantingMethod is only
                // DIRECT_SOW | TRANSPLANT — the SOWN/TRANSPLANTED spellings
                // belong to PlantingStatus, which is a different enum.
                method: 'DIRECT_SOW',
                status: 'SOWN',
                // 12 ha at 5 t/ha — a plausible Bulgarian wheat block, and
                // enough for the calculator to report a real standing value
                // rather than refusing for want of a yield estimate.
                areaM2: SAMPLE_AREA_M2,
                plannedYieldKgPerHa: SAMPLE_YIELD_KG_PER_HA,
                isSampleData: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'SAMPLE_DATA_LOADED',
            entityType: 'Location',
            entityId: location.id,
            details: 'Loaded "try it with sample data" dataset',
            detailsJson: {
                category: 'custom',
                summary: 'Sample data loaded into tenant workspace',
                data: {
                    locationId: location.id,
                    parcels: SAMPLE_PARCEL_NAMES.length,
                    grainChain: true,
                    commodity: SAMPLE_COMMODITY,
                },
            },
        });

        return { created: true };
    });
}

/**
 * Remove the sample dataset: soft-delete (set `deletedAt`) every row
 * tagged `isSampleData: true && deletedAt: null` for this tenant across
 * the four models. Tenant-scoped, idempotent (a second call clears
 * nothing). Returns the total number of rows soft-deleted.
 */
export async function clearSampleData(ctx: RequestContext): Promise<{ cleared: number }> {
    assertCanWrite(ctx);
    const t = ctx.tenantId;
    return runInTenantContext(ctx, async (db) => {
        const now = new Date();
        const where = { tenantId: t, isSampleData: true, deletedAt: null } as const;
        const data = { deletedAt: now, deletedByUserId: ctx.userId } as const;

        // Each updateMany is tenant-scoped (explicit tenantId, defence in
        // depth) AND isSampleData-scoped — never touches a farmer's real
        // rows. Order is irrelevant: soft-delete leaves FK targets intact.
        // The grain chain soft-deletes alongside the rest. Order is still
        // irrelevant — soft-delete leaves FK targets intact, so a Planting
        // whose CropPlan is already marked deleted is not orphaned, it is
        // simply also marked. Every one of these carries `deletedByUserId`,
        // so the shared `data` object applies unchanged.
        const [logEntries, lots, parcels, locations, plantings, cropPlans, seasons, cropTypes] =
            await Promise.all([
                db.logEntry.updateMany({ where, data }),
                db.inventoryLot.updateMany({ where, data }),
                db.parcel.updateMany({ where, data }),
                db.location.updateMany({ where, data }),
                db.planting.updateMany({ where, data }),
                db.cropPlan.updateMany({ where, data }),
                db.season.updateMany({ where, data }),
                db.cropType.updateMany({ where, data }),
            ]);

        const cleared =
            logEntries.count + lots.count + parcels.count + locations.count +
            plantings.count + cropPlans.count + seasons.count + cropTypes.count;

        if (cleared > 0) {
            await logEvent(db, ctx, {
                action: 'SAMPLE_DATA_CLEARED',
                entityType: 'Tenant',
                entityId: t,
                details: `Cleared sample data (${cleared} rows soft-deleted)`,
                detailsJson: {
                    category: 'custom',
                    summary: 'Sample data cleared from tenant workspace',
                    data: {
                        cleared,
                        plantings: plantings.count,
                        cropPlans: cropPlans.count,
                        seasons: seasons.count,
                        cropTypes: cropTypes.count,
                        locations: locations.count,
                        parcels: parcels.count,
                        inventoryLots: lots.count,
                        logEntries: logEntries.count,
                    },
                },
            });
        }

        return { cleared };
    });
}
