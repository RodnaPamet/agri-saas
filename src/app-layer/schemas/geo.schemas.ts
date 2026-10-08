import { z } from 'zod';
import type { Polygon, MultiPolygon, LineString } from 'geojson';

/**
 * GeoJSON polygon validation for hand-drawn parcels (terra-draw output).
 * Strict enough to reject malformed input before it reaches PostGIS:
 *   - positions are [lon, lat(, …)] with ≥2 numbers,
 *   - linear rings have ≥4 positions (closed ring),
 *   - longitudes ∈ [-180, 180], latitudes ∈ [-90, 90].
 * `ST_GeomFromGeoJSON` is the final arbiter of validity; this catches the
 * common shapes early with a clean 400.
 */
const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const position = z.tuple([lon, lat]).rest(z.number());
const linearRing = z.array(position).min(4);

const polygon = z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(linearRing).min(1),
});
const multiPolygon = z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(linearRing).min(1)).min(1),
});

/**
 * MultiPolygon alone — the shape a READ always returns.
 *
 * `Parcel.geometry` is `geometry(MultiPolygon, 4326)`, and every write path
 * normalises to it (`ST_Multi` in `geometrySql` and friends), so a parcel read
 * back from the database is a MultiPolygon even when the user drew a single
 * ring. `PolygonGeometrySchema` is the right shape for INPUT, where a client
 * may legitimately send either; using it for output would document a Polygon
 * that cannot occur and leave a client writing a branch it can never exercise.
 *
 * agrent-ios decodes MultiPolygon only and asked whether a Polygon can arrive.
 * It cannot, and this is where that answer is enforced rather than asserted.
 */
export const MultiPolygonGeometrySchema = multiPolygon;

export const PolygonGeometrySchema = z.discriminatedUnion('type', [polygon, multiPolygon]);

/**
 * GeoJSON LineString — the "blade" a user draws across a parcel to split
 * it. ≥2 positions; the same lon/lat bounds as a polygon ring.
 */
const lineString = z.object({
    type: z.literal('LineString'),
    coordinates: z.array(position).min(2),
});
export const LineStringGeometrySchema = lineString;

/** Narrow a validated schema value to the geojson library's types. */
export type PolygonGeometry = Polygon | MultiPolygon;
export type LineGeometry = LineString;

export const CreateParcelSchema = z
    .object({
        name: z.string().min(1).max(200),
        cropType: z.string().max(120).nullable().optional(),
        geometry: PolygonGeometrySchema,
    })
    .strip();

export const UpdateParcelSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        cropType: z.string().max(120).nullable().optional(),
        cadastralId: z.string().max(50).nullable().optional(),
        // ДНЕВНИК per-field header (Прил.1 РД 11-3194/31.12.2021). No import
        // carries Склад; Землище/Местност are backfilled from cadastral
        // properties where present, and all three are operator-editable.
        landDistrict: z.string().max(200).nullable().optional(),
        locality: z.string().max(200).nullable().optional(),
        produceStore: z.string().max(200).nullable().optional(),
        geometry: PolygonGeometrySchema.optional(),
    })
    .strip()
    .refine(
        (b) =>
            b.name !== undefined ||
            b.cropType !== undefined ||
            b.cadastralId !== undefined ||
            b.landDistrict !== undefined ||
            b.locality !== undefined ||
            b.produceStore !== undefined ||
            b.geometry !== undefined,
        { message: 'No fields to update.' },
    );

/**
 * Merge ≥2 parcels of a location into one new parcel (their geometric
 * union). The originals are soft-deleted; the union gets `name`.
 */
export const MergeParcelsSchema = z
    .object({
        parcelIds: z.array(z.string().min(1)).min(2, 'Select at least two parcels to merge.'),
        name: z.string().min(1).max(200),
    })
    .strip();

/**
 * Split one parcel along a drawn line into the pieces the blade cuts it
 * into. The original is soft-deleted; each piece becomes a new parcel.
 */
export const SplitParcelSchema = z
    .object({
        line: LineStringGeometrySchema,
    })
    .strip();
