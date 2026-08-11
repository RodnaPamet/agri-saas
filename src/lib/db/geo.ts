/**
 * Geo / PostGIS helpers — the ONLY place raw `ST_*` SQL is allowed.
 *
 * `Parcel.geometry` is a Prisma `Unsupported("geometry(MultiPolygon,
 * 4326)")` column: the Prisma client cannot read or write it through
 * the normal API, so all geometry I/O goes through the `Prisma.sql`
 * fragments built here and is run via `$executeRaw` / `$queryRaw` in
 * the parcel repository.
 *
 * A guardrail (geo-raw-sql-containment) asserts that `ST_` only appears
 * in this file, so the spatial surface stays auditable.
 */
import { Prisma } from '@prisma/client';
import type { Geometry, Polygon, MultiPolygon, LineString } from 'geojson';

/**
 * SQL fragment that converts a GeoJSON geometry (passed as a JSON
 * string parameter) into a PostGIS `geometry(MultiPolygon, 4326)`:
 * parse → coerce to MultiPolygon → stamp SRID 4326. Use inside an
 * INSERT/UPDATE, e.g. `Prisma.sql\`... SET "geometry" = ${geometrySql(g)}\``.
 */
export function geometrySql(geometry: Polygon | MultiPolygon): Prisma.Sql {
    const json = JSON.stringify(geometry);
    return Prisma.sql`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326))`;
}

/**
 * Like `geometrySql`, but REPAIRS the geometry before it lands:
 * `ST_MakeValid` resolves self-intersections / ring problems, then
 * `ST_CollectionExtract(..., 3)` keeps only the POLYGON components (a
 * bowtie repair can yield a GEOMETRYCOLLECTION), and `ST_Multi` normalises
 * back to the column's MultiPolygon type. The server's last line of
 * defence: even if a not-quite-valid geometry slips past the usecase
 * `ST_IsValid` gate, the persisted value is topologically valid, so
 * `ST_Area` (and therefore `areaHa`) is always meaningful — never a
 * garbage value from a self-intersecting polygon. Idempotent on an
 * already-valid geometry. Lives here so `ST_*` stays contained in geo.ts.
 */
export function repairedGeometrySql(geometry: Polygon | MultiPolygon): Prisma.Sql {
    const json = JSON.stringify(geometry);
    return Prisma.sql`ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326)), 3))`;
}

/**
 * Like `repairedGeometrySql`, but REPROJECTS from a non-WGS84 source SRID to
 * 4326 BEFORE repairing — the Bulgarian КАИС / КВС / КККР cadastre ingest path
 * (EPSG:7801 BGS2005/CCS2005 Lambert, or EPSG:32635 UTM 35N). Order is
 * deliberate: `ST_SetSRID` stamps the source SRID onto the raw GeoJSON
 * (whose coordinates are the source CRS's metres), `ST_Transform(..., 4326)`
 * reprojects to WGS84 FIRST, THEN `ST_MakeValid` repairs — reprojecting a
 * repaired-in-metres geometry could reintroduce topology error near the
 * projection's edges, so repair happens in the final 4326 frame. Keeps the
 * column's MultiPolygon/4326 invariant identical to `repairedGeometrySql`, so
 * a reprojected parcel is byte-shaped like a native-WGS84 one and `areaHa`
 * (via `areaHectaresNonNullSql`) stays meaningful.
 *
 * `sourceSrid` is a trusted, validated integer from the parser's supported
 * set (never user input); it is inlined via `Prisma.raw` so the SRID reaches
 * PostGIS as an integer literal rather than a typed bind parameter.
 */
export function reprojectedGeometrySql(
    geometry: Polygon | MultiPolygon,
    sourceSrid: number,
): Prisma.Sql {
    if (!Number.isInteger(sourceSrid) || sourceSrid <= 0) {
        throw new Error(`reprojectedGeometrySql: sourceSrid must be a positive integer, got ${sourceSrid}`);
    }
    const json = JSON.stringify(geometry);
    const srid = Prisma.raw(String(sourceSrid));
    return Prisma.sql`ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${json}), ${srid}), 4326)), 3))`;
}

/**
 * Part A (PR2) — the canonical reproject-then-repair fragment for the cadastre
 * write path: `ST_Transform(ST_SetSRID(geom, srid), 4326)` INNERMOST, then
 * `ST_MakeValid → ST_CollectionExtract(...,3) → ST_Multi`. Identical pipeline
 * to `reprojectedGeometrySql` (which it delegates to) — this is the name the
 * Part A probe path uses to make the "reproject FIRST, repair in the 4326
 * frame" intent explicit at the call site (`ParcelRepository`). `sourceSrid`
 * is a trusted validated integer (7801 / 32635 from the parser's supported set
 * or the PostGIS probe) inlined as an integer literal, never user input.
 */
export function reprojectedRepairedGeometrySql(
    geometry: Polygon | MultiPolygon,
    sourceSrid: number,
): Prisma.Sql {
    return reprojectedGeometrySql(geometry, sourceSrid);
}

/**
 * Part A (PR2) — CANDIDATE-SRID PROBE. Given a sample of raw source-CRS
 * geometries (their coordinates are projected metres, SRID not yet stamped) and
 * a list of candidate SRIDs, transform the WHOLE sample from EACH candidate to
 * WGS84 in ONE round-trip and return each candidate's resulting bounding box
 * (`xmin/ymin/xmax/ymax` = west/south/east/north). The caller
 * (`ParcelRepository.probeSourceSrid`) picks the candidate whose transformed
 * bounds land inside Bulgaria's WGS84 envelope — disambiguating 7801 vs 32635
 * by REPROJECTED position, never by raw metre magnitude (the two overlap over
 * Bulgaria). One row per candidate; a candidate whose transform yields no
 * extent comes back with NULL corners (caller treats that as "no match").
 *
 * `srids` are trusted, validated integers (the parser's supported set) inlined
 * as integer literals via `Prisma.raw`; the geometries ride as bound `text`
 * parameters through `ST_GeomFromGeoJSON`. Lives here so every `ST_*` stays
 * contained in geo.ts.
 */
export function probeCandidateSridSql(
    geometries: ReadonlyArray<Polygon | MultiPolygon>,
    srids: readonly number[],
): Prisma.Sql {
    for (const s of srids) {
        if (!Number.isInteger(s) || s <= 0) {
            throw new Error(`probeCandidateSridSql: srid must be a positive integer, got ${s}`);
        }
    }
    const geomRows = geometries.map((g) => Prisma.sql`(${JSON.stringify(g)}::text)`);
    const sridRows = srids.map((s) => Prisma.sql`(${Prisma.raw(String(s))}::int)`);
    return Prisma.sql`
        SELECT c."srid" AS "srid",
               ST_XMin(e.ext) AS "xmin", ST_YMin(e.ext) AS "ymin",
               ST_XMax(e.ext) AS "xmax", ST_YMax(e.ext) AS "ymax"
        FROM (VALUES ${Prisma.join(sridRows)}) AS c("srid")
        CROSS JOIN LATERAL (
            SELECT ST_Extent(
                ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(g."geojson"), c."srid"), 4326)
            ) AS ext
            FROM (VALUES ${Prisma.join(geomRows)}) AS g("geojson")
        ) AS e`;
}

/**
 * SQL fragment computing the area of a geometry column in hectares,
 * using the geography cast for an accurate on-the-ellipsoid area
 * (m²) divided by 10,000. Returns NULL-safe NUMERIC.
 */
export function areaHectaresSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ROUND((ST_Area(${column}::geography) / 10000.0)::numeric, 4)`;
}

/**
 * Like `areaHectaresSql`, but `COALESCE`d to 0 so a parcel that HAS a
 * geometry can never carry a NULL `areaHa` (a degenerate `ST_MakeValid`
 * result — e.g. a drawn line collapsing to an empty polygon — yields
 * area 0, not NULL). Use on every parcel write so `areaHa` is a hard
 * invariant: geometry present ⇒ areaHa present.
 */
export function areaHectaresNonNullSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`COALESCE(ROUND((ST_Area(${column}::geography) / 10000.0)::numeric, 4), 0)`;
}

/**
 * Repair an EXISTING geometry COLUMN in place (the backfill / repair
 * path): `ST_MakeValid` → keep polygons → `ST_Multi`. The column-input
 * twin of `repairedGeometrySql` (which takes GeoJSON). Idempotent on an
 * already-valid geometry. Lives here so `ST_*` stays contained in geo.ts.
 */
export function repairedGeometryColumnSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_Multi(ST_CollectionExtract(ST_MakeValid(${column}), 3))`;
}

/**
 * SQL boolean: is an existing geometry COLUMN topologically valid? The
 * column-input twin of `isValidGeometrySql`. Used by the backfill to
 * flag (and then repair) stored parcels. Lives here so `ST_*` stays
 * contained in geo.ts.
 */
export function isValidGeometryColumnSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_IsValid(${column})`;
}

/**
 * Longitude of a representative interior point of a geometry.
 *
 * `ST_PointOnSurface`, deliberately NOT `ST_Centroid`. A centroid is the
 * average of the shape and can land OUTSIDE it: an L-shaped or crescent
 * parcel, or a MultiPolygon split by a road, puts its centroid in the
 * gap — which on a map is a marker sitting in the neighbour's field.
 * `ST_PointOnSurface` is guaranteed to lie on the geometry, which is
 * what "where is this parcel" has to mean.
 *
 * Costs slightly more than a centroid; irrelevant at one row per parcel
 * and worth it to never point at the wrong field.
 */
export function pointOnSurfaceLonSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_X(ST_PointOnSurface(${column}))`;
}

/** Latitude counterpart of `pointOnSurfaceLonSql`. See that docblock. */
export function pointOnSurfaceLatSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_Y(ST_PointOnSurface(${column}))`;
}

/** SQL fragment serializing a geometry column back to GeoJSON text. */
export function asGeoJsonSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_AsGeoJSON(${column})`;
}

/**
 * SQL fragment serializing a geometry column to SIMPLIFIED GeoJSON text —
 * `ST_AsGeoJSON(ST_Simplify(col, tolerance))`. Tolerance is in degrees
 * (the column SRID is WGS84/4326): 0.0001° ≈ 11 m at the equator. Used on
 * the export/display read path so a 50-field location ships a fraction of
 * the vertices; the exact geometry is still used for sketch/edit and for
 * area (`ST_Area`). `preserveCollapsed` is left default (collapsed slivers
 * drop out) — acceptable for display, never used for persisted area.
 */
export function simplifiedGeoJsonSql(column: Prisma.Sql, toleranceDegrees = 0.0001): Prisma.Sql {
    return Prisma.sql`ST_AsGeoJSON(ST_Simplify(${column}, ${toleranceDegrees}))`;
}

/**
 * SQL fragment yielding a geometry's centroid as WGS84 lon/lon, aliased
 * `lon` and `lat` — `ST_X(ST_Centroid(col))` / `ST_Y(ST_Centroid(col))`.
 * The column SRID is 4326, so the centroid's X is longitude and Y is
 * latitude directly (no reprojection). `ST_Centroid` returns a POINT even
 * for a MultiPolygon; on a NULL geometry both coordinates come back NULL,
 * which the soil-fetch caller treats as "no centroid, skip" (never throws).
 * Lives here so every `ST_*` call stays inside geo.ts (the containment
 * guard). Select as: `SELECT ${centroidLonLatSql(col('geometry'))} FROM …`.
 */
export function centroidLonLatSql(column: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`ST_X(ST_Centroid(${column})) AS "lon", ST_Y(ST_Centroid(${column})) AS "lat"`;
}

/**
 * SQL fragments for the `SoilSample` grid cell (integer milli-degrees) of a
 * geometry column's centroid: `latE3` / `lonE3` = round(deg × 1000). Uses
 * `floor(x + 0.5)` so it matches the soil-fetch job's JS `toE3` (Math.round)
 * for Bulgaria's positive lon/lat — read-time soil hydration must land in the
 * SAME cell the job keys on. Compare as `${cell.latE3}` / `${cell.lonE3}`.
 */
export function soilGridCellSql(column: Prisma.Sql): { latE3: Prisma.Sql; lonE3: Prisma.Sql } {
    return {
        latE3: Prisma.sql`floor(ST_Y(ST_Centroid(${column})) * 1000 + 0.5)::int`,
        lonE3: Prisma.sql`floor(ST_X(ST_Centroid(${column})) * 1000 + 0.5)::int`,
    };
}

/**
 * Full query: a Mapbox Vector Tile (MVT) for the z/x/y tile covering a
 * location's parcels. The geometry is reprojected to Web Mercator (3857),
 * clipped to the tile envelope, and quantised to a 4096-unit extent by
 * `ST_AsMVTGeom`; `ST_AsMVT` aggregates the rows into a single `bytea`
 * (the protobuf tile). The MVT layer is named `parcels` — the map's
 * vector source-layer must match.
 *
 * Tenant- AND location-scoped in the WHERE, so a tile can never leak a
 * sibling tenant's or another field's parcels. The intersection filter is
 * evaluated in 3857 (same as the tile envelope) so the GiST index on the
 * geometry is usable after the reprojection is inlined. Run via
 * `$queryRaw`; one row, `mvt` is NULL when no parcel touches the tile (the
 * caller maps that to an empty tile). Lives here so `ST_*` stays in geo.ts.
 */
export function mvtTileSql(z: number, x: number, y: number, locationId: string, tenantId: string): Prisma.Sql {
    return Prisma.sql`
        SELECT ST_AsMVT(q, 'parcels', 4096, 'geom') AS "mvt"
        FROM (
            SELECT
                "id",
                "name",
                ST_AsMVTGeom(
                    ST_Transform("geometry", 3857),
                    ST_TileEnvelope(${z}::int, ${x}::int, ${y}::int),
                    4096, 64, true
                ) AS "geom"
            FROM "Parcel"
            WHERE "locationId" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
              AND "geometry" IS NOT NULL
              AND ST_Transform("geometry", 3857) && ST_TileEnvelope(${z}::int, ${x}::int, ${y}::int)
        ) AS q
        WHERE q."geom" IS NOT NULL`;
}

/** Bare column reference helper (keeps quoting in one place). */
export function col(name: string): Prisma.Sql {
    return Prisma.raw(`"${name}"`);
}

/**
 * SQL fragment evaluating to `true` when the GeoJSON geometry is
 * topologically valid (no self-intersections, properly-closed rings).
 * `ST_GeomFromGeoJSON` accepts self-intersecting polygons that then
 * produce a meaningless `ST_Area`, so hand-drawn parcels are validated
 * with this before they're persisted.
 */
export function isValidGeometrySql(geometry: Polygon | MultiPolygon): Prisma.Sql {
    return Prisma.sql`ST_IsValid(${geometrySql(geometry)})`;
}

/**
 * Full query: of the supplied GeoJSON geometries, return the 0-based
 * indices (column `idx`) of those that are NOT topologically valid —
 * self-intersecting rings, malformed polygons, etc. The geometries are
 * passed as an unnested `VALUES` list so a bulk parcel-import's validity
 * check is ONE round-trip, never an N+1 loop of per-parcel `ST_IsValid`.
 *
 * Mirrors `geometrySql`'s construction
 * (`ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(...), 4326))`) so a geometry
 * that passes here is byte-identical to the one `addParcelsForLocation`
 * persists. Run via `$queryRaw`; the caller maps each `idx` back to its
 * parcel. Lives here so the `ST_*` stays contained in geo.ts.
 *
 * NOTE: `ST_GeomFromGeoJSON` *throws* (aborting the whole statement) on
 * structurally-malformed JSON rather than returning an invalid geometry.
 * The spatial parser only ever produces well-formed MultiPolygon
 * structures, so the realistic failure here is topological (caught by
 * `ST_IsValid`); the caller treats a thrown statement as "import
 * contains malformed geometry" and fails closed.
 */
export function invalidGeometryIndicesSql(
    geometries: ReadonlyArray<Polygon | MultiPolygon>,
): Prisma.Sql {
    const rows = geometries.map(
        (g, i) => Prisma.sql`(${i}::int, ${JSON.stringify(g)}::text)`,
    );
    return Prisma.sql`
        SELECT t."idx" AS "idx"
        FROM (VALUES ${Prisma.join(rows)}) AS t("idx", "geojson")
        WHERE NOT ST_IsValid(
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(t."geojson"), 4326))
        )`;
}

/**
 * Full query computing the WGS84 bounding box of all non-deleted parcels
 * of a location, as four corners (xmin/ymin/xmax/ymax = west/south/east/
 * north). Returns no row (or NULL corners) when the location has no
 * parcels with geometry. Run via `$queryRaw`; the caller maps the row to
 * `[w, s, e, n]`. Lives here so the `ST_*` stays contained in geo.ts.
 */
export function locationParcelBoundsSql(locationId: string, tenantId: string): Prisma.Sql {
    return Prisma.sql`
        SELECT ST_XMin(ext) AS "xmin", ST_YMin(ext) AS "ymin",
               ST_XMax(ext) AS "xmax", ST_YMax(ext) AS "ymax"
        FROM (
            SELECT ST_Extent("geometry") AS ext
            FROM "Parcel"
            WHERE "locationId" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
        ) s
        WHERE ext IS NOT NULL`;
}

/**
 * SQL fragment converting a GeoJSON LineString (the split "blade") into a
 * PostGIS `geometry(LineString, 4326)`. Used as the second argument to
 * `ST_Split` in `splitParcelGeoJsonSql`.
 */
export function lineSql(line: LineString): Prisma.Sql {
    const json = JSON.stringify(line);
    return Prisma.sql`ST_SetSRID(ST_GeomFromGeoJSON(${json}), 4326)`;
}

/**
 * Full query: the geometric UNION of the named parcels, returned as a
 * single GeoJSON MultiPolygon string (column `geojson`). Tenant- AND
 * location-scoped — only non-deleted parcels of `locationId` belonging to
 * `tenantId` are unioned, so a caller can never merge across a tenant or
 * field boundary. Run via `$queryRaw`; one row, `geojson` NULL when no
 * matching parcel has geometry.
 */
export function unionParcelsGeoJsonSql(
    locationId: string,
    tenantId: string,
    parcelIds: string[],
): Prisma.Sql {
    return Prisma.sql`
        SELECT ST_AsGeoJSON(ST_Multi(ST_Union("geometry"))) AS "geojson"
        FROM "Parcel"
        WHERE "id" IN (${Prisma.join(parcelIds)})
          AND "locationId" = ${locationId}
          AND "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
          AND "geometry" IS NOT NULL`;
}

/**
 * Full query: SPLIT a parcel's geometry along a LineString blade, dumping
 * the resulting pieces to one GeoJSON polygon per row (column `geojson`).
 * `ST_Split` returns a collection; `ST_Dump` expands it; the outer filter
 * keeps only polygonal pieces (the blade itself can surface otherwise).
 * Tenant-scoped on the source parcel. When the blade does not fully cross
 * the parcel, `ST_Split` yields a single piece — the caller treats
 * `< 2 rows` as "the cut didn't divide the parcel".
 */
export function splitParcelGeoJsonSql(
    parcelId: string,
    tenantId: string,
    line: LineString,
): Prisma.Sql {
    return Prisma.sql`
        SELECT ST_AsGeoJSON((d).geom) AS "geojson"
        FROM (
            SELECT (ST_Dump(ST_Split("geometry", ${lineSql(line)}))).*
            FROM "Parcel"
            WHERE "id" = ${parcelId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
              AND "geometry" IS NOT NULL
        ) d
        WHERE ST_GeometryType((d).geom) IN ('ST_Polygon', 'ST_MultiPolygon')`;
}

/** Parse a GeoJSON string returned by `ST_AsGeoJSON` back into a typed geometry. */
export function parseGeometry(geojson: string | null): Geometry | null {
    if (!geojson) return null;
    try {
        return JSON.parse(geojson) as Geometry;
    } catch {
        return null;
    }
}
