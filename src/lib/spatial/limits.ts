/**
 * Spatial-upload abuse limits — the cheap, PURE guards that bound the cost
 * of a parcel import before (size) and after (complexity) parsing.
 *
 * These exist because `importLocationSpatialFile` accepts an arbitrary
 * operator upload: a hostile or accidental 200 MB shapefile, or a single
 * polygon with millions of vertices, can pin a CPU and balloon PostGIS
 * `ST_Area` / `ST_GeomFromGeoJSON` cost. The size cap is checked BEFORE we
 * even parse (reject the bytes outright); the complexity cap is checked
 * AFTER parse, BEFORE persist (reject pathological geometry). Parsing
 * itself is moved off the request thread onto a time-bounded BullMQ job.
 *
 * Pure + dependency-free so it is exhaustively unit-testable.
 */
import { CodedFailureError } from '@/lib/errors/coded-failure';

import type { ParsedParcel } from './parse';
import type { Position } from 'geojson';

/** Detected spatial format (mirrors `parse.ts`'s `SpatialFormat`). */
export type SpatialUploadFormat = 'shapefile' | 'geojson' | 'kml';

/**
 * Per-format byte caps. A zipped shapefile is the densest format (binary +
 * DBF), so it gets the tightest cap; text GeoJSON/KML are larger on the
 * wire for the same content, so they get more headroom.
 */
export const SPATIAL_UPLOAD_LIMITS: Readonly<Record<SpatialUploadFormat, number>> = {
    shapefile: 5 * 1024 * 1024, // 5 MB
    geojson: 10 * 1024 * 1024, // 10 MB
    kml: 10 * 1024 * 1024, // 10 MB
};

/** Max vertices in a SINGLE parcel (summed across every ring). */
export const MAX_PARCEL_VERTICES = 50_000;
/** Max vertices across the WHOLE import. */
export const MAX_TOTAL_VERTICES = 500_000;
/** Max parcels in one import. */
export const MAX_PARCEL_COUNT = 10_000;

/** A 30s wall-clock budget for the off-thread parse job (BullMQ job timeout). */
export const SPATIAL_PARSE_TIMEOUT_MS = 30_000;

/**
 * Rejection raised by the limit guards. Carries an HTTP-ish `statusCode`
 * (413 for too-large, 422 for too-complex/invalid) so the route surfaces a
 * precise client error rather than a 500.
 *
 * `code` is the SECOND argument and is REQUIRED (#1447). It used to be an
 * optional fourth, which meant the route that re-threw one had to write
 * `err.code ?? 'SPATIAL_UPLOAD_REJECTED'` — a fallback that was already
 * unreachable from every thrower in the tree, so it documented a code the
 * server could not send and agrent-ios was right to flag it. Required by
 * the type, the fallback is gone and a new thrower cannot stay anonymous.
 *
 * Reordering rather than appending is safe here in a way worth stating: the
 * two leading arguments are now `string, string`, so a call site that kept
 * the old order passes `413 | 422` where a `string` is wanted and fails to
 * compile. There is no argument order that silently type-checks wrongly.
 */
export class SpatialLimitError extends CodedFailureError {
    constructor(
        message: string,
        /**
         * A client-switchable code for this exact refusal.
         *
         * The `message` alone was what reached a farmer, and it reached them in
         * ENGLISH on a Bulgarian screen: agrent-ios deliberately passes a
         * refusal sentence straight through, because without a code there is
         * nothing to look up a translation by. «File exceeds the 5 MB limit» on
         * a Bulgarian upload screen was the most visible instance.
         *
         * So the facts travel structurally — the size, the cap, the format —
         * and the client composes its own sentence. The message stays as the
         * English fallback for a client that does not recognise the code.
         */
        code: string,
        readonly statusCode: 413 | 422 = 422,
        params?: Readonly<Record<string, string | number>>,
    ) {
        super(message, code, params);
        this.name = 'SpatialLimitError';
    }
}

/**
 * Human megabytes for the ENGLISH fallback message only.
 *
 * Never for `params`. `toFixed(1)` writes an English decimal point, and
 * Bulgarian writes «7,2 MB» — so a client interpolating `params.limit`
 * would have had to re-parse a localised-looking string that was not
 * localised. The params carry raw integer bytes instead and the client
 * formats them (#1447, raised by agrent-ios on #1633).
 */
function mb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reject an upload whose byte length exceeds its format cap. Checked BEFORE
 * parsing so a hostile file never reaches the parser. 413 Payload Too Large.
 */
export function assertUploadWithinSize(format: SpatialUploadFormat, byteLength: number): void {
    const cap = SPATIAL_UPLOAD_LIMITS[format];
    if (byteLength > cap) {
        throw new SpatialLimitError(
            `Spatial file is too large (${mb(byteLength)}; ${format} limit is ${mb(cap)}). ` +
                `Simplify or split the upload.`,
            // NOT `SPATIAL_FILE_TOO_LARGE`. `FILE_TOO_LARGE` is a real code
            // emitted by upload/ingest, evidence and journal, and it is
            // genuinely undocumented — but #1391's guard decides "documented"
            // with `specText.includes(code)`, so a longer code CONTAINING it
            // would have made that live gap read as closed. Filed separately;
            // avoided here by not nesting one code inside another.
            'SPATIAL_UPLOAD_TOO_LARGE',
            413,
            // Raw integer BYTES, not the human strings the message uses: the
            // client formats them in its own locale. The format comes too, so
            // a client can name the right cap — they differ per format
            // (shapefile 5 MB, KML/GeoJSON 10 MB).
            { sizeBytes: byteLength, limitBytes: cap, format },
        );
    }
}

/** Count the vertices in one position ring. */
function ringVertices(ring: Position[]): number {
    return ring.length;
}

/** Total vertices across every polygon + ring of a parsed parcel. */
export function countParcelVertices(parcel: ParsedParcel): number {
    let n = 0;
    for (const polygon of parcel.geometry.coordinates) {
        for (const ring of polygon) {
            n += ringVertices(ring);
        }
    }
    return n;
}

/**
 * Reject a parsed parcel set that is pathologically complex: too many
 * parcels, any single parcel with too many vertices, or too many vertices
 * in aggregate. Checked AFTER parse, BEFORE persist. 422 Unprocessable.
 */
export function assertParcelComplexity(parcels: ReadonlyArray<ParsedParcel>): void {
    if (parcels.length > MAX_PARCEL_COUNT) {
        throw new SpatialLimitError(
            `Too many parcels (${parcels.length}; limit is ${MAX_PARCEL_COUNT}).`,
            'SPATIAL_TOO_MANY_PARCELS',
            422,
            { count: parcels.length, limit: MAX_PARCEL_COUNT },
        );
    }
    let total = 0;
    for (const parcel of parcels) {
        const v = countParcelVertices(parcel);
        if (v > MAX_PARCEL_VERTICES) {
            throw new SpatialLimitError(
                `Parcel "${parcel.name}" is too complex (${v} vertices; limit is ${MAX_PARCEL_VERTICES}). ` +
                    `Simplify the geometry before importing.`,
                'SPATIAL_PARCEL_TOO_COMPLEX',
                422,
                // The parcel's NAME stays in the English message and is
                // deliberately NOT a param. It is operator-supplied content
                // from inside the uploaded file — «Нивата на Иван» is a
                // perfectly ordinary parcel name — and `params` is the field
                // that must stay free of anything personal. The client can say
                // which parcel by echoing the message; it does not need the
                // name to compose the NUMBERS.
                { vertices: v, limit: MAX_PARCEL_VERTICES },
            );
        }
        total += v;
    }
    if (total > MAX_TOTAL_VERTICES) {
        throw new SpatialLimitError(
            `Import is too complex (${total} vertices across all parcels; limit is ${MAX_TOTAL_VERTICES}).`,
            'SPATIAL_IMPORT_TOO_COMPLEX',
            422,
            { vertices: total, limit: MAX_TOTAL_VERTICES },
        );
    }
}
