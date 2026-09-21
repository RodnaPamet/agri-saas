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

/** Marketing-grade but illustrative — one field, a few parcels. */
const SAMPLE_LOCATION_NAME = 'Sample field';
const SAMPLE_PARCEL_NAMES = ['North block', 'South block', 'River strip'];
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

        // ── 2-3 Parcels (illustrative names; geometry is nullable) ──
        await db.parcel.createMany({
            data: SAMPLE_PARCEL_NAMES.map((name, i) => ({
                tenantId: t,
                locationId: location.id,
                name,
                cropType: i === 0 ? 'Wheat' : i === 1 ? 'Barley' : 'Grass',
                isSampleData: true,
            })),
        });

        // ── One InventoryLot ── needs a real itemId + unitId. Reuse an
        // existing tenant item+unit if present; otherwise create a minimal
        // catalog Item (Item has no isSampleData flag — it is harmless
        // residue if a clear later runs, and the lot itself IS tagged +
        // soft-deleted on clear). Skip the lot entirely if no Unit exists
        // (the global unit catalog hasn't been imported) — the sample
        // dataset is still useful without it.
        const unit = await db.unit.findFirst({ select: { id: true } });
        if (unit) {
            let item = await db.item.findFirst({
                where: { tenantId: t, deletedAt: null },
                select: { id: true },
            });
            if (!item) {
                item = await db.item.create({
                    data: {
                        tenantId: t,
                        name: 'Sample fertiliser',
                        category: 'FERTILIZER',
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
