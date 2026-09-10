/**
 * Spatial-file parser — converts an uploaded parcel-boundary file into
 * a normalized list of parcels ready to persist.
 *
 * Supported inputs (normalized to WGS84 / EPSG:4326 GeoJSON):
 *   • GeoJSON  (.geojson / .json)  — assumed 4326 per RFC 7946.
 *   • KML / KMZ (.kml / .kmz)      — 4326 by the KML spec; via @tmcw/togeojson.
 *   • ESRI Shapefile ZIP (.zip)    — via shpjs. Bulgarian КАИС / КВС / КККР
 *     cadastre exports in EPSG:7801 (BGS2005 / CCS2005 Lambert) or EPSG:32635
 *     (UTM 35N) are detected from the `.prj` (or, prj-less, a Bulgarian metre
 *     bbox) and carry a `ParseResult.srid` so the repo reprojects them via
 *     PostGIS `ST_Transform` on write — geometry then lands as 4326.
 *
 * Pure module: no Prisma, no I/O beyond the provided Buffer/string, so
 * it is unit-testable in isolation. The repository layer is responsible
 * for persisting the result (geometry through src/lib/db/geo.ts) and
 * for computing area via PostGIS ST_Area.
 *
 * Licensing: shpjs (MIT) and @tmcw/togeojson (BSD-2) are permissively
 * licensed; no GPL/AGPL farm-repo code is used here.
 */
import bbox from '@turf/bbox';
import { DOMParser } from '@xmldom/xmldom';
import { DOC_AREA_DCA_KEY } from '@/lib/agriculture/cadastre';
import type {
    Feature,
    FeatureCollection,
    Geometry,
    MultiPolygon,
    Polygon,
} from 'geojson';

export type SpatialFormat = 'geojson' | 'kml' | 'shapefile';

/**
 * Source SRIDs the importer can ingest via a PostGIS `ST_Transform` on
 * write (Bulgarian КАИС / КВС / КККР cadastre exports):
 *   • 7801  — BGS2005 / CCS2005 (the official Bulgarian Lambert cadastre CRS).
 *   • 32635 — WGS84 / UTM zone 35N (some КВС exports).
 * 4326 is the WGS84 GeoJSON default and needs no reprojection. Only these
 * two projected CRSs are accepted; any other projected CRS is rejected (see
 * `parseSpatialFile`), so a mystery projection is never silently mis-stored.
 */
export const SUPPORTED_SOURCE_SRIDS = [7801, 32635] as const;
export type SupportedSourceSrid = (typeof SUPPORTED_SOURCE_SRIDS)[number];

/** The Bulgarian cadastre default when a projected shapefile carries no `.prj`. */
export const DEFAULT_BG_CADASTRE_SRID: SupportedSourceSrid = 7801;

// Normalized propertiesJson key for the documentary area (площ по документ) —
// single source of truth in the dependency-light cadastre module (imported at
// top), re-exported here for the parser's callers/tests.
export { DOC_AREA_DCA_KEY };

/** One normalized parcel extracted from the source file. */
export interface ParsedParcel {
    /** Best-effort name from common property keys, else a positional fallback. */
    name: string;
    /** Always a MultiPolygon — WGS84 already, OR in the file's source SRID when
     *  `ParseResult.srid` is set (the repo reprojects those via PostGIS). */
    geometry: MultiPolygon;
    /** Source-feature properties, JSON-sanitised (Dates→ISO, NaN→null). */
    properties: Record<string, unknown>;
    /**
     * Cadastral identifier `EKATTE.masiv.parcel` (e.g. `68134.8360.729`) when
     * parseable, else null. Optional in the type so hand-built fixtures need
     * not spell it — `normalizeToParcels` always sets it (possibly null).
     */
    cadastralId?: string | null;
    /** The 5-digit EKATTE settlement prefix of `cadastralId`; else null. */
    ekatte?: string | null;
}

export interface ParseResult {
    format: SpatialFormat;
    parcels: ParsedParcel[];
    /** [west, south, east, north] in WGS84, or null when no geometry. */
    bounds: [number, number, number, number] | null;
    /** Features skipped because they had no polygonal geometry. */
    skipped: number;
    /**
     * Source SRID of `parcels[].geometry` when it is NOT WGS84 and must be
     * reprojected on write (`ST_Transform → 4326`). `undefined` means the
     * geometry is already WGS84 (4326) — the common GeoJSON/KML path.
     */
    srid?: SupportedSourceSrid;
    /**
     * Part A (PR2) — set when the geometry is in PROJECTED metres that fall in
     * the Bulgarian cadastre band but the exact source CRS could NOT be
     * resolved from a `.prj` (absent or unparseable — cadastre archive exports
     * frequently ship no `.prj`). 7801 (КС2005/BGS2005) and 32635 (UTM 35N)
     * are indistinguishable by raw metre magnitude over Bulgaria, so the parser
     * defers: it leaves `srid` UNDEFINED and stamps this flag. The write path
     * (spatial-import job) then PROBES both candidates via PostGIS — the
     * candidate whose TRANSFORMED bounds land inside Bulgaria's WGS84 envelope
     * wins (`ParcelRepository.probeSourceSrid`). Never disambiguated by raw
     * metre heuristics — those two CRSs overlap in magnitude over Bulgaria.
     */
    sourceCrs?: 'projected-candidate';
}

export class SpatialParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpatialParseError';
    }
}

/**
 * Coerce a parsed source value into something that survives JSON
 * serialization into `Parcel.propertiesJson`. DBF parsers (shpjs) emit
 * native `Date` objects for date columns — blank cells become
 * `new Date('Invalid Date')` — and numeric columns can yield `NaN`.
 * Prisma rejects BOTH inside a JSON value, which previously failed the
 * whole import. We normalize: valid Date → ISO string, invalid Date →
 * null, non-finite number → null, recursing through arrays/objects.
 */
function toJsonSafe(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isNaN(t) ? null : value.toISOString();
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(toJsonSafe);
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = toJsonSafe(v);
        }
        return out;
    }
    // functions / symbols → drop
    return null;
}

const NAME_KEYS = ['name', 'Name', 'NAME', 'title', 'label', 'parcel', 'PARCEL', 'field', 'FIELD', 'id', 'ID'];
// Cadastral / area-code keys. When one is present alongside a NAME_KEYS value it
// PREFIXES the name (EKATTE 15655 + NAME 3 → "15655-3"), so cadastral exports
// get a unique, human-meaningful label instead of a bare block number. The
// composition is Unicode-safe — a Cyrillic name is preserved verbatim.
const CODE_KEYS = ['EKATTE', 'ekatte', 'CADASTRE', 'cadastre', 'KVS', 'kvs', 'REGION', 'region', 'BLOCK', 'block', 'ZONE', 'zone'];

/** First non-empty string/number value among `keys`, trimmed; else null. */
function pickValue(properties: Record<string, unknown>, keys: readonly string[]): string | null {
    for (const key of keys) {
        const v = properties[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
}

function pickName(properties: Record<string, unknown>, index: number): string {
    const name = pickValue(properties, NAME_KEYS);
    const code = pickValue(properties, CODE_KEYS);
    if (code && name && code !== name) return `${code}-${name}`;
    return name ?? code ?? `Parcel ${index + 1}`;
}

// --- Cadastral identity (Bulgarian КАИС) ---------------------------------
// A cadastral identifier is `EKATTE.masiv.parcel`, e.g. `68134.8360.729`:
// a 5-digit EKATTE settlement code, then dot-separated block + parcel
// numbers. Leading zeros are significant (EKATTE `00134` ≠ `134`), so the
// prefix is validated as a 5-DIGIT string and never coerced through Number.
const EKATTE_RE = /^\d{5}$/;
/** A full identifier: 5-digit EKATTE, then at least two more dot-parts. */
const CADASTRAL_ID_RE = /^(\d{5})\.\d+(?:\.\d+)+$/;
// Property keys КАИС/КВС exports use for a WHOLE pre-composed identifier.
const CADASTRAL_ID_KEYS = ['CADNUM', 'cadnum', 'IDENT', 'ident', 'PIN', 'pin', 'KI', 'ki', 'IDENTIFIER', 'identifier', 'CAD_ID', 'cad_id'];
// Component keys, when the export splits the identifier across columns.
const MASIV_KEYS = ['MASIV', 'masiv', 'MASSIV', 'massiv', 'BLOCK', 'block'];
const PARCEL_NUM_KEYS = ['PARCEL', 'parcel', 'IMOT', 'imot', 'PARC', 'parc', 'PARCELNO', 'NOMER', 'nomer'];
const EKATTE_KEYS = ['EKATTE', 'ekatte', 'Ekatte', 'EKNM', 'eknm'];

/** Trimmed string form of a property value, leading zeros preserved; else null. */
function rawStr(properties: Record<string, unknown>, keys: readonly string[]): string | null {
    for (const key of keys) {
        const v = properties[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
        // A number can't carry leading zeros — but is still a valid component.
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
}

/**
 * Parse a validated cadastral identifier from a feature's attributes.
 * Two paths, in order of trust:
 *   1. A whole `EKATTE.masiv.parcel` value already present in one of the
 *      known id columns (or, as a fallback, ANY string value that matches).
 *   2. Composed from separate EKATTE + masiv + parcel columns.
 * Returns `{ cadastralId, ekatte }` on a format match, else `{ null, null }`.
 * The `EKATTE` prefix must be exactly 5 digits (leading zeros preserved).
 */
export function parseCadastralIdentity(
    properties: Record<string, unknown>,
): { cadastralId: string | null; ekatte: string | null } {
    // 1a — an explicit id column.
    const explicit = rawStr(properties, CADASTRAL_ID_KEYS);
    if (explicit) {
        const m = CADASTRAL_ID_RE.exec(explicit);
        if (m) return { cadastralId: explicit, ekatte: m[1] };
    }
    // 1b — any string value that IS a full identifier (some exports put it
    //      in an unlabelled column). Numbers are skipped: `68134.8360` could
    //      never survive as a number with a trailing zero intact.
    for (const v of Object.values(properties)) {
        if (typeof v === 'string') {
            const m = CADASTRAL_ID_RE.exec(v.trim());
            if (m) return { cadastralId: v.trim(), ekatte: m[1] };
        }
    }
    // 2 — compose from components.
    const ekatte = rawStr(properties, EKATTE_KEYS);
    const masiv = rawStr(properties, MASIV_KEYS);
    const parcel = rawStr(properties, PARCEL_NUM_KEYS);
    if (ekatte && EKATTE_RE.test(ekatte) && masiv && parcel) {
        const composed = `${ekatte}.${masiv}.${parcel}`;
        if (CADASTRAL_ID_RE.test(composed)) return { cadastralId: composed, ekatte };
    }
    return { cadastralId: null, ekatte: null };
}

// Documentary area (площ по документ) — the area of RECORD from the cadastre
// register, distinct from the geometric ST_Area. Stored in decares (декар,
// the Bulgarian agricultural unit) under `DOC_AREA_DCA_KEY` for the >5%
// reconciliation badge. Geometry-derived area columns (SHAPE_AREA / ST_AREA
// / GEOM_*) are deliberately NOT treated as documentary.
const DOC_AREA_DCA_KEYS = ['AREA_DKA', 'area_dka', 'PLOSHT_DKA', 'plosht_dka', 'POV_DKA', 'pov_dka', 'DKA', 'dka'];
const DOC_AREA_GENERIC_KEYS = ['PLOSHT', 'plosht', 'ПЛОЩ', 'площ', 'DOC_AREA', 'doc_area', 'AREA_DOC', 'area_doc', 'POV', 'pov'];

/**
 * The documentary parcel area in DECARES, when a recognised attribute
 * carries it; else null. Decare-unit keys are trusted directly; generic
 * area keys are ALSO assumed decares (the agricultural-cadastre standard).
 * Returns null for a non-positive / non-finite value.
 */
export function pickDocumentaryAreaDca(properties: Record<string, unknown>): number | null {
    for (const keys of [DOC_AREA_DCA_KEYS, DOC_AREA_GENERIC_KEYS]) {
        for (const key of keys) {
            const v = properties[key];
            const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    return null;
}

/** Coerce a Polygon or MultiPolygon into MultiPolygon; reject anything else. */
function toMultiPolygon(geometry: Geometry | null | undefined): MultiPolygon | null {
    if (!geometry) return null;
    if (geometry.type === 'MultiPolygon') {
        return geometry as MultiPolygon;
    }
    if (geometry.type === 'Polygon') {
        return { type: 'MultiPolygon', coordinates: [(geometry as Polygon).coordinates] };
    }
    if (geometry.type === 'GeometryCollection') {
        // Merge any polygonal members into a single MultiPolygon.
        const polys: Polygon['coordinates'][] = [];
        for (const g of geometry.geometries) {
            if (g.type === 'Polygon') polys.push((g as Polygon).coordinates);
            else if (g.type === 'MultiPolygon') polys.push(...(g as MultiPolygon).coordinates);
        }
        return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
    }
    return null;
}

/**
 * Normalize a GeoJSON FeatureCollection / Feature / geometry into parcels,
 * counting features dropped for lacking polygonal geometry (`skipped`) so the
 * caller can tell the user a partial import happened instead of silently
 * losing points/lines.
 */
export function normalizeToParcels(input: unknown): { parcels: ParsedParcel[]; skipped: number } {
    const features: Feature[] = collectFeatures(input);
    const parcels: ParsedParcel[] = [];
    let skipped = 0;
    for (const feature of features) {
        const mp = toMultiPolygon(feature.geometry);
        if (!mp) {
            skipped++;
            continue;
        }
        const properties = toJsonSafe(
            (feature.properties ?? {}) as Record<string, unknown>,
        ) as Record<string, unknown>;
        const { cadastralId, ekatte } = parseCadastralIdentity(properties);
        // Normalize the documentary area into propertiesJson (площ по документ,
        // in decares) for the >5% area-reconciliation badge. Display-only —
        // the persisted areaHa always derives from PostGIS ST_Area.
        const docAreaDca = pickDocumentaryAreaDca(properties);
        if (docAreaDca !== null) properties[DOC_AREA_DCA_KEY] = docAreaDca;
        parcels.push({
            name: pickName(properties, parcels.length),
            geometry: mp,
            properties,
            cadastralId,
            ekatte,
        });
    }
    return { parcels, skipped };
}

function collectFeatures(input: unknown): Feature[] {
    if (!input || typeof input !== 'object') return [];
    const obj = input as { type?: string };
    if (obj.type === 'FeatureCollection') {
        return ((input as FeatureCollection).features ?? []).filter(Boolean);
    }
    if (obj.type === 'Feature') {
        return [input as Feature];
    }
    // Bare geometry → synthesize a feature.
    if (typeof obj.type === 'string') {
        return [{ type: 'Feature', properties: {}, geometry: input as Geometry }];
    }
    // shpjs may return an array of FeatureCollections (one per layer).
    if (Array.isArray(input)) {
        return input.flatMap((part) => collectFeatures(part));
    }
    return [];
}

function computeBounds(parcels: ParsedParcel[]): [number, number, number, number] | null {
    if (!parcels.length) return null;
    const fc: FeatureCollection = {
        type: 'FeatureCollection',
        features: parcels.map((p) => ({ type: 'Feature', properties: {}, geometry: p.geometry })),
    };
    const [w, s, e, n] = bbox(fc);
    if ([w, s, e, n].some((v) => !Number.isFinite(v))) return null;
    return [w, s, e, n];
}

/** Detect the spatial format from a filename + optional MIME type. */
export function detectFormat(filename: string, mimeType?: string): SpatialFormat | null {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.geojson') || lower.endsWith('.json')) return 'geojson';
    if (lower.endsWith('.kml') || lower.endsWith('.kmz')) return 'kml';
    if (lower.endsWith('.zip')) return 'shapefile';
    if (mimeType === 'application/geo+json' || mimeType === 'application/json') return 'geojson';
    if (mimeType === 'application/vnd.google-earth.kml+xml' || mimeType === 'application/vnd.google-earth.kmz') {
        return 'kml';
    }
    if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') return 'shapefile';
    return null;
}

export function parseGeoJson(text: string): { parcels: ParsedParcel[]; skipped: number } {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new SpatialParseError('File is not valid JSON.');
    }
    return normalizeToParcels(json);
}

export function parseKml(text: string): { parcels: ParsedParcel[]; skipped: number } {
    // togeojson needs a DOM Document; @xmldom/xmldom provides one in Node.
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    // Lazy require keeps the CJS build out of the module's static graph.
    const { kml } = require('@tmcw/togeojson') as typeof import('@tmcw/togeojson');
    const fc = kml(doc as unknown as Document);
    return normalizeToParcels(fc);
}

/**
 * Detect a supported source SRID from a shapefile `.prj` WKT string.
 * Recognises the EPSG authority code (`AUTHORITY["EPSG","7801"]`) first,
 * then falls back to CRS-name / projection signatures so a `.prj` that
 * omits the authority still resolves. Returns null for anything else —
 * including WGS84, which needs no reprojection.
 *
 * Exported for unit testing and Phase-2 reuse.
 */
export function detectSridFromPrj(wkt: string): SupportedSourceSrid | null {
    if (!wkt) return null;
    const upper = wkt.toUpperCase();
    // Authority code — the strongest signal.
    if (/EPSG"?\s*,\s*"?7801/.test(upper)) return 7801;
    if (/EPSG"?\s*,\s*"?32635/.test(upper)) return 32635;
    // Name / datum signatures for the Bulgarian Lambert cadastre CRS.
    if (upper.includes('CCS2005') || upper.includes('BGS2005') || upper.includes('CS2005')) return 7801;
    // UTM zone 35N (WGS84) name signature.
    if (/UTM[_ ]?ZONE[_ ]?35N?/.test(upper) || upper.includes('32635')) return 32635;
    return null;
}

/** Read the `.prj` WKT text from a shapefile zip (JSZip); null when absent. */
async function readPrjFromZip(buffer: Buffer): Promise<string | null> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
        if (name.toLowerCase().endsWith('.prj') && !name.includes('__MACOSX')) {
            return (await zip.files[name].async('string')).trim();
        }
    }
    return null;
}

/**
 * Rebuild the zip WITHOUT its `.prj` entries so shpjs (which reprojects via
 * proj4 whenever a `.prj` is present) leaves geometry in the RAW source
 * coordinates. We do this once we have recognised the CRS ourselves, so the
 * authoritative reprojection is PostGIS `ST_Transform` — deterministic and
 * independent of proj4's WKT handling for the Bulgarian Lambert CRS.
 */
async function stripPrjFromZip(buffer: Buffer): Promise<Buffer> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
        if (name.toLowerCase().endsWith('.prj')) zip.remove(name);
    }
    return zip.generateAsync({ type: 'nodebuffer' });
}

export async function parseShapefileZip(
    buffer: Buffer,
): Promise<{ parcels: ParsedParcel[]; skipped: number; srid?: SupportedSourceSrid }> {
    // shpjs is a browser-oriented bundle that references the `self`
    // global; polyfill it before loading so it runs server-side. Dynamic
    // import (after the polyfill) avoids static-hoisting the reference.
    const g = globalThis as unknown as { self?: unknown };
    if (typeof g.self === 'undefined') g.self = globalThis;
    const mod = (await import('shpjs')) as unknown as {
        default?: (b: ArrayBuffer | Buffer) => Promise<unknown>;
    };
    const shp = mod.default ?? (mod as unknown as (b: ArrayBuffer | Buffer) => Promise<unknown>);

    // Detect the source CRS from the `.prj` ourselves. When it is a supported
    // projected cadastre CRS (7801 / 32635), STRIP the `.prj` so shpjs yields
    // raw metre coordinates and PostGIS does the reprojection on write.
    const prjWkt = await readPrjFromZip(buffer);
    const detected = prjWkt ? detectSridFromPrj(prjWkt) : null;
    const inputBuffer = detected ? await stripPrjFromZip(buffer) : buffer;

    const geojson = await shp(inputBuffer);
    const { parcels, skipped } = normalizeToParcels(geojson);
    return { parcels, skipped, srid: detected ?? undefined };
}

/**
 * Part A — does a projected-metre bbox look like a Bulgarian cadastre export
 * that shipped WITHOUT a resolvable `.prj`? Eastings within ~[80k, 1M] and
 * northings within ~[4.4M, 5.1M] cover BOTH candidate CRSs (7801 КС2005 Lambert
 * and 32635 UTM 35N) over Bulgaria. Crucially we do NOT try to pick between the
 * two here: their metre magnitudes overlap, so a raw-magnitude guess would be a
 * coin-flip. Instead we return `true` and let the caller stamp
 * `sourceCrs: 'projected-candidate'`; the write path disambiguates by which
 * candidate's TRANSFORMED bounds land inside Bulgaria (PostGIS probe). Returns
 * `false` when the coordinates are outside the Bulgarian metre band, so a
 * truly-unknown projection still fails the WGS84-range guard.
 */
function looksLikeBulgarianProjectedMetres(
    bounds: [number, number, number, number],
): boolean {
    const [w, s, e, n] = bounds;
    const eastingsOk = w >= 80_000 && e <= 1_000_000;
    const northingsOk = s >= 4_400_000 && n <= 5_100_000;
    return eastingsOk && northingsOk;
}

/**
 * Top-level entry: parse an uploaded spatial file into normalized
 * parcels + a bounding box. Throws SpatialParseError on unsupported
 * format or when no polygonal features are found.
 */
export async function parseSpatialFile(args: {
    filename: string;
    buffer: Buffer;
    mimeType?: string;
}): Promise<ParseResult> {
    const format = detectFormat(args.filename, args.mimeType);
    if (!format) {
        throw new SpatialParseError(
            'Unsupported file type. Upload a shapefile (.zip), KML (.kml), or GeoJSON (.geojson).',
        );
    }

    let extraction: { parcels: ParsedParcel[]; skipped: number; srid?: SupportedSourceSrid };
    if (format === 'geojson') {
        extraction = parseGeoJson(args.buffer.toString('utf8'));
    } else if (format === 'kml') {
        extraction = parseKml(args.buffer.toString('utf8'));
    } else {
        extraction = await parseShapefileZip(args.buffer);
    }
    const { parcels, skipped } = extraction;
    const srid = extraction.srid;
    let sourceCrs: 'projected-candidate' | undefined;

    if (!parcels.length) {
        throw new SpatialParseError('No polygon parcels found in the uploaded file.');
    }

    const bounds = computeBounds(parcels);
    // Coordinate-range guard. When `srid` is set (a `.prj` resolved the CRS),
    // the geometry is deliberately in the source CRS's metres (the repo
    // reprojects via ST_Transform), so a metre-scale bbox is EXPECTED — skip
    // the guard. Otherwise, out-of-range coordinates mean shpjs could not
    // reproject. Part A: a Bulgarian cadastre export that shipped WITHOUT a
    // resolvable `.prj` (КС2005 archives frequently do) is NOT auto-assumed to
    // be one CRS — 7801 and 32635 overlap by magnitude, so we stamp
    // `sourceCrs: 'projected-candidate'` and defer the choice to the write-path
    // PostGIS probe. Anything outside the Bulgarian metre band is still
    // rejected with an actionable message.
    if (bounds && srid === undefined) {
        const [w, s, e, n] = bounds;
        if (w < -180 || e > 180 || s < -90 || n > 90) {
            if (looksLikeBulgarianProjectedMetres(bounds)) {
                sourceCrs = 'projected-candidate';
            } else {
                throw new SpatialParseError(
                    `Coordinates fall outside the valid WGS84 range (bounds [${w.toFixed(1)}, ${s.toFixed(1)}, ${e.toFixed(1)}, ${n.toFixed(1)}]; expected longitude -180..180, latitude -90..90). ` +
                        `The file's projection could not be reprojected to WGS84. Re-export the layer as WGS84 / EPSG:4326 (or a Bulgarian cadastre CRS — КС2005 / EPSG:7801, or EPSG:32635 UTM 35N — with a .prj) and upload again.`,
                );
            }
        }
    }

    return { format, parcels, bounds, skipped, srid, sourceCrs };
}
