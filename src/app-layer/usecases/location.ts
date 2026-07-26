import { RequestContext } from '../types';
import { LocationRepository, LocationFilters, LocationListParams } from '../repositories/LocationRepository';
import { ParcelRepository } from '../repositories/ParcelRepository';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertWithinLimit } from '@/lib/billing/entitlements';

export interface CreateLocationInput {
    name: string;
    description?: string | null;
    status?: 'ACTIVE' | 'ARCHIVED';
    ownerUserId?: string | null;
}

export interface UpdateLocationInput {
    name?: string;
    description?: string | null;
    status?: 'ACTIVE' | 'ARCHIVED';
    ownerUserId?: string | null;
}

export async function listLocations(ctx: RequestContext, filters?: LocationFilters) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => LocationRepository.list(db, ctx, filters));
}

export async function listLocationsPaginated(ctx: RequestContext, params: LocationListParams) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => LocationRepository.listPaginated(db, ctx, params));
}

export async function getLocation(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.getById(db, ctx, id);
        if (!location) throw notFound('Location not found');
        return location;
    });
}

/** Location plus its parcels (geometry serialized to GeoJSON) — feeds the map. */
export async function getLocationWithParcels(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.getById(db, ctx, id);
        if (!location) throw notFound('Location not found');
        const parcels = await ParcelRepository.listForLocation(db, ctx, id);
        return { ...location, parcels };
    });
}

/**
 * Just the parcels for a location, as GeoJSON. `simplifyTolerance`
 * (degrees) opts into `ST_Simplify` on the export path for a lighter
 * payload on a many-field location; omit it for exact sketch/edit
 * geometry.
 */
export async function listLocationParcels(
    ctx: RequestContext,
    id: string,
    opts: { simplifyTolerance?: number } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.getById(db, ctx, id);
        if (!location) throw notFound('Location not found');
        const parcels = await ParcelRepository.listForLocation(db, ctx, id, opts);
        return { locationId: id, bounds: location.boundsJson ?? null, parcels };
    });
}

/**
 * The location's bounding box ([west, south, east, north]) or null. Used by
 * the offline-basemap proxy to keep a bounded-per-location tile pack — a
 * requested basemap tile outside this bbox is rejected. Tenant-scoped via the
 * repository; a missing location is a 404.
 */
export async function getLocationBounds(
    ctx: RequestContext,
    id: string,
): Promise<[number, number, number, number] | null> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.getById(db, ctx, id);
        if (!location) throw notFound('Location not found');
        const bounds = location.boundsJson;
        return Array.isArray(bounds) && bounds.length === 4
            ? (bounds as [number, number, number, number])
            : null;
    });
}

/**
 * Render a location's parcels as a Mapbox Vector Tile (binary protobuf)
 * for the z/x/y tile — the map's vector source at zoom ≥ 6. Tenant- +
 * location-scoped in the repository; an empty buffer means no parcel
 * touches the tile.
 */
export async function getLocationParcelTile(
    ctx: RequestContext,
    locationId: string,
    z: number,
    x: number,
    y: number,
): Promise<Buffer> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => ParcelRepository.mvtForTile(db, ctx, locationId, z, x, y));
}

export async function createLocation(ctx: RequestContext, data: CreateLocationInput) {
    assertCanWrite(ctx);
    // Plan gate: a startup-farmer (FREE) tenant caps the number of farms/fields.
    await assertWithinLimit(ctx, 'location');
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.create(db, ctx, {
            name: data.name,
            description: data.description ?? null,
            ...(data.status ? { status: data.status } : {}),
            ownerUserId: data.ownerUserId || null,
            createdByUserId: ctx.userId,
        });

        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Location',
            entityId: location.id,
            details: `Created location: ${location.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Location',
                operation: 'created',
                after: { name: location.name },
                summary: `Created location: ${location.name}`,
            },
        });

        return location;
    });
}

export async function updateLocation(ctx: RequestContext, id: string, data: UpdateLocationInput) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.update(db, ctx, id, {
            name: data.name,
            description: data.description,
            status: data.status,
            ownerUserId:
                data.ownerUserId === undefined ? undefined : data.ownerUserId || null,
        });
        if (!location) throw notFound('Location not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Location',
            entityId: id,
            details: 'Location updated',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Location',
                operation: 'updated',
                changedFields: Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined),
                summary: 'Location updated',
            },
        });

        return location;
    });
}


/**
 * Refuse to delete a Location that still has inventory assigned to it.
 *
 * `InventoryLot.locationId` has no FK cascade and lots are not deleted with
 * their location, so soft-deleting an occupied row leaves every lot pointing at
 * a deleted Location: the stock stays on hand and keeps counting in inventory,
 * but disappears from every bin view. Silent, and only noticeable once the
 * numbers stop reconciling.
 *
 * This mirrors the refusal in `grain-bin.ts::deleteBin`. Both paths delete the
 * SAME table, so a guard on only one of them is arguably worse than none: the
 * protected path teaches you to trust a protection the other path lacks.
 *
 * Deliberately NOT a `kind` guard. Blocking bin deletion here would leave bins
 * undeletable for any tenant without the GRAIN module, since the grain route is
 * module-gated and this is then the only path. The integrity risk is orphaned
 * stock, not which page you deleted from — so guard the stock.
 */
async function assertNoDependentStock(
    db: PrismaTx,
    ctx: RequestContext,
    locationIds: string[],
): Promise<void> {
    if (locationIds.length === 0) return;

    const occupied = await db.inventoryLot.groupBy({
        by: ['locationId'],
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            locationId: { in: locationIds },
        },
        _count: { _all: true },
    });
    const blocking = occupied.filter((g) => g.locationId && g._count._all > 0);
    if (blocking.length === 0) return;

    // Name the offenders — "some location has stock" is not actionable.
    const names = await db.location.findMany({
        where: {
            id: { in: blocking.map((g) => g.locationId as string) },
            tenantId: ctx.tenantId,
        },
        select: { id: true, name: true },
        take: 20,
    });
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    const detail = blocking
        .map((g) => `${nameById.get(g.locationId as string) ?? g.locationId} (${g._count._all} lot(s))`)
        .join(', ');
    throw badRequest(
        `Cannot delete a location that still holds stock: ${detail}. Move or unassign the lots first.`,
    );
}

export async function deleteLocation(ctx: RequestContext, id: string) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        await assertNoDependentStock(db, ctx, [id]);
        const deleted = await LocationRepository.softDelete(db, ctx, id);
        if (!deleted) throw notFound('Location not found');

        await logEvent(db, ctx, {
            action: 'SOFT_DELETE',
            entityType: 'Location',
            entityId: id,
            details: 'Location soft-deleted',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Location',
                operation: 'deleted',
                summary: 'Location soft-deleted',
            },
        });

        return { success: true };
    });
}

/**
 * Bulk soft-delete locations — the locations table "Delete selected" action.
 * Mirrors {@link deleteLocation}: ADMIN-gated, tenant-scoped, reuses
 * `LocationRepository.softDelete` (Location is NOT in SOFT_DELETE_MODELS, so
 * the explicit repository soft-delete is the mechanism), one audit row per
 * deleted location. Ids that don't resolve are skipped (idempotent — a
 * re-submit deletes nothing rather than throwing). Returns the count deleted.
 */
export async function bulkDeleteLocation(
    ctx: RequestContext,
    locationIds: string[],
): Promise<{ deleted: number }> {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Whole-batch refusal, not skip-and-continue: this runs in ONE
        // transaction, so a partial delete followed by a throw would roll back
        // anyway — and "deleted 3 of 5, silently" is worse than a clear no.
        await assertNoDependentStock(db, ctx, locationIds);
        let deleted = 0;
        for (const id of locationIds) {
            const ok = await LocationRepository.softDelete(db, ctx, id);
            if (!ok) continue;
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Location',
                entityId: id,
                details: 'Location soft-deleted (bulk)',
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Location',
                    operation: 'deleted',
                    summary: 'SOFT_DELETE',
                },
            });
            deleted++;
        }
        return { deleted };
    });
}
