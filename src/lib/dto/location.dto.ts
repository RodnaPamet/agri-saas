/**
 * Location / Parcel / Field-operation DTOs — mirror the shapes returned
 * by LocationRepository and ParcelRepository. Geometry is serialized as
 * GeoJSON (never the raw PostGIS column); areaHa is a denormalized
 * hectare value computed by ST_Area at import time.
 */
import { z } from '@/lib/openapi/zod';
import { UserRefSchema } from './common';

// ─── Location List Item ───

export const LocationListItemDTOSchema = z.object({
    id: z.string(),
    tenantId: z.string(),
    key: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    /**
     * `LocationKind` — a Location is a FIELD or a storage row depending on
     * it, and callers filter on it (`?kind=BIN,STORAGE`; the asset form's
     * location picker reads it off the row). It was shipped by every
     * locations read while going undocumented here.
     */
    kind: z.string().optional(),
    /** Storage capacity, tonnes. Meaningful on storage kinds. */
    capacityTonnes: z.number().nullable().optional(),
    ownerUserId: z.string().nullable().optional(),
    spatialFileId: z.string().nullable().optional(),
    spatialFormat: z.string().nullable().optional(),
    boundsJson: z.unknown().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    owner: UserRefSchema.nullable().optional(),
    _count: z.object({
        parcels: z.number().optional(),
    }).optional(),
}).strip().openapi('LocationListItem', {
    description: 'Location as it appears in list views. A Location holds a set of imported Parcels (PostGIS polygons).',
});

export type LocationListItemDTO = z.infer<typeof LocationListItemDTOSchema>;

/**
 * The exact field set this DTO promises, as a runtime value.
 *
 * `toLocationListItemDTO` is bound to it by a test, so the mapper and the
 * documented contract cannot drift apart in either direction — which is how
 * the drift this exists to fix went unnoticed: the schema was
 * `.passthrough()`, so shipping seven extra columns violated nothing.
 */
export const LOCATION_LIST_ITEM_FIELDS = [
    'id',
    'tenantId',
    'key',
    'name',
    'description',
    'status',
    'kind',
    'capacityTonnes',
    'ownerUserId',
    'spatialFileId',
    'spatialFormat',
    'boundsJson',
    'createdAt',
    'updatedAt',
    'owner',
    '_count',
] as const;

/**
 * Project a LocationRepository row onto the documented response shape.
 *
 * The repository returns the whole row because internal callers need the
 * lifecycle columns (`deletedAt`, `retentionUntil`, `isSampleData`,
 * `deletedByUserId`, `createdByUserId`). None of them is any API consumer's
 * business, and three are retention/erasure bookkeeping. Apply this at every
 * response boundary rather than narrowing the repository, so internal logic
 * keeps the columns it legitimately reads.
 *
 * `capacityTonnes` arrives as a Prisma Decimal and leaves as a number, the
 * same treatment `areaHa` already gets on ParcelDTO.
 */
export function toLocationListItemDTO(row: Record<string, unknown>): LocationListItemDTO {
    const out: Record<string, unknown> = {};
    for (const field of LOCATION_LIST_ITEM_FIELDS) {
        if (field in row) out[field] = row[field];
    }
    if (out.capacityTonnes != null) out.capacityTonnes = Number(out.capacityTonnes);
    return out as LocationListItemDTO;
}

// ─── Parcel (with GeoJSON geometry) ───

export const ParcelDTOSchema = z.object({
    id: z.string(),
    name: z.string(),
    cropType: z.string().nullable().optional(),
    areaHa: z.number().nullable().optional(),
    /** GeoJSON MultiPolygon (WGS84), serialized via ST_AsGeoJSON. */
    geometry: z.unknown().nullable().optional(),
    properties: z.unknown().nullable().optional(),
}).passthrough().openapi('Parcel', {
    description: 'One imported parcel polygon. geometry is GeoJSON MultiPolygon in WGS84; areaHa is the on-ellipsoid area in hectares.',
});

export type ParcelDTO = z.infer<typeof ParcelDTOSchema>;

// ─── Location Detail (with parcel GeoJSON FeatureCollection) ───

export const LocationDetailDTOSchema = LocationListItemDTOSchema.extend({
    parcels: z.array(ParcelDTOSchema).optional(),
}).openapi('LocationDetail', {
    description: 'Location with its parcels. Returned by GET /locations/{id}.',
});

export type LocationDetailDTO = z.infer<typeof LocationDetailDTOSchema>;
