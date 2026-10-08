/**
 * Shared DTO schemas and types for API responses.
 * All schemas use z.infer<> for type derivation.
 */
import { z } from '@/lib/openapi/zod';

// ─── Shared Refs ───

/** Minimal user reference returned in most includes */
/**
 * A geographic bounding box, as every map-bearing response sends it (#1391).
 *
 * Raised by agrent-ios, which decodes a four-number array and had to infer the
 * arity and the axis order from the values: the property was published as an
 * untyped `{}`, so one unexpected value failed the whole Локации list rather
 * than one row.
 *
 * ## The axis order is the contract, and it is the easy half to get wrong
 *
 * `[west, south, east, north]` — equivalently `[minLon, minLat, maxLon,
 * maxLat]`. LONGITUDE FIRST, which is GeoJSON's order and the opposite of the
 * `lat, lon` a human quotes. A client that swaps them gets a box that is
 * plausible in Bulgaria (roughly 22–28°E, 41–44°N, so the numbers do not look
 * obviously wrong) and silently positioned over Africa. Stated here because a
 * description is the only place it CAN be stated — the types are identical
 * either way round.
 *
 * `minItems`/`maxItems` are declared explicitly: Zod's `.length(4)` does not
 * reach the OpenAPI output, so a bare `.length(4)` publishes an unbounded
 * number array and the arity a client needs is lost. Measured.
 */
export const BoundingBoxSchema = z
    .array(z.number())
    .openapi('BoundingBox', {
        minItems: 4,
        maxItems: 4,
        description:
            'A bounding box as `[west, south, east, north]` — equivalently `[minLon, minLat, maxLon, maxLat]`. **Longitude first**, per GeoJSON, which is the reverse of the `lat, lon` order a human quotes: swapping them yields a box that looks plausible for Bulgaria and is positioned wrongly. Exactly four numbers, in WGS84 degrees.',
        example: [22.35, 41.24, 28.61, 44.22],
    });

/**
 * Parcel geometry, as the read paths send it (#1391).
 *
 * ## It is ALWAYS a MultiPolygon, and that is enforced twice
 *
 * agrent-ios asked whether a bare `Polygon` can arrive, because it decodes
 * MultiPolygon only and one `Polygon` would fail the whole parcel array.
 * Measured, and the answer is no:
 *
 *   * the column is `geometry(MultiPolygon, 4326)` — PostGIS refuses anything
 *     else at write time (migration `20260613090735_ag_feature1_spray_map`);
 *   * every write path in `src/lib/db/geo.ts` ends in `ST_Multi(…)`, which
 *     normalises a Polygon — and a GEOMETRYCOLLECTION out of a bowtie repair —
 *     into a MultiPolygon before it is stored.
 *
 * So a MultiPolygon-only decoder is correct, and this schema says so rather
 * than leaving the client to infer it from the rows it happens to have seen.
 *
 * The PUBLISHED description deliberately does not name `ST_AsGeoJSON`,
 * `ST_Multi` or the column's PostGIS type. Two reasons, and the second is the
 * better one: `tests/guardrails/geo-raw-sql-containment.test.ts` flags those
 * tokens anywhere outside `src/lib/db/geo.ts` — it strips COMMENTS, so this
 * docblock is fine, but a `description` is a string and was flagged — and more
 * to the point, a client has no use for the name of our serialisation
 * function. What it needs is the guarantee; how the guarantee is produced is
 * ours. The mechanism stays here, where it is checkable against the code.
 * The `type` is a single-value enum deliberately: it is a guarantee, not a
 * default.
 *
 * Coordinates are left untyped below the ring level. A GeoJSON position array
 * is four levels of nesting and spelling it out buys a client nothing it does
 * not already get from `type` plus the GeoJSON spec, while making every future
 * change to this schema a large diff.
 */
export const MultiPolygonGeometrySchema = z
    .object({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(z.unknown()),
    })
    .openapi('MultiPolygonGeometry', {
        description:
            'GeoJSON MultiPolygon in WGS84 (EPSG:4326). **Always a MultiPolygon, never a bare `Polygon`** — the storage column admits only MultiPolygon and every write normalises to it, so a single-ring parcel arrives as a MultiPolygon containing one polygon. A MultiPolygon-only decoder is therefore correct. Simplified when a read passed `?simplify=`; never for sketch/edit, which needs exact geometry.',
    });

export const UserRefSchema = z
    .object({
        id: z.string().openapi({ example: 'usr_01HG7…' }),
        name: z.string().nullable().openapi({ example: 'Alice Admin' }),
        email: z.string().nullable().optional().openapi({ example: 'admin@acme.com' }),
    })
    .openapi('UserRef', {
        description: 'User identity reference embedded inside other resources (id + display name + optional email).',
    });
export type UserRef = z.infer<typeof UserRefSchema>;

/** Short user reference (id + name only, no email) */
export const UserRefShortSchema = z
    .object({
        id: z.string().openapi({ example: 'usr_01HG7…' }),
        name: z.string().nullable().openapi({ example: 'Alice Admin' }),
    })
    .openapi('UserRefShort', {
        description: 'User identity reference without email — used in audit-log entries and other places where leaking the email would be inappropriate.',
    });
export type UserRefShort = z.infer<typeof UserRefShortSchema>;

// ─── Standard Error Shape ───

/** Matches ApiErrorResponse from src/lib/errors/types.ts */
export const ApiErrorResponseSchema = z
    .object({
        error: z.object({
            code: z.string().openapi({ example: 'NOT_FOUND' }),
            message: z.string().openapi({ example: 'Practice not found' }),
            requestId: z.string().optional().openapi({ example: 'req_01HG7…' }),
            details: z.unknown().optional(),
            /**
             * Interpolation values for the client's OWN translated sentence.
             *
             * `toApiErrorResponse` has always emitted this (`types.ts:273`,
             * `if (error.params) payload.error.params = error.params`) and the
             * envelope has never documented it — so a client translating a code
             * had no contract for the values the sentence needs, and the native
             * client was left parsing them out of `message`. Raised by
             * agrent-ios in #1391.
             *
             * This is the field that makes a CODE usable. `FARM_NAME_TOO_LONG`
             * carries `{ max: 120 }` so a Bulgarian sentence can say the bound
             * without the server interpolating English; the insurance refusals
             * do the same. Keys are per-code and documented on the throw, not
             * here.
             *
             * It is NOT a place for anything personal — `ErrorParams` is
             * policed by `tests/guards/error-params-carry-no-pii.test.ts`,
             * which matches on the KEY name precisely because this value
             * leaves the server in the clear and lands on a phone.
             */
            params: z
                // `string | number`, matching `ErrorParams` exactly — NOT
                // `unknown`. The first draft used `z.unknown()` and the guard
                // added in #1384 caught it: a map whose value type is
                // undescribed "accepts anything while describing nothing", and
                // it was right. `ErrorParams` is
                // `Readonly<Record<string, string | number>>` — "ids and
                // quantities only" — so the narrower type is the HONEST one and
                // happens to satisfy the guard rather than needing a waiver.
                //
                // Interpolation values into a sentence are scalars by nature;
                // you cannot interpolate an object into a translated string.
                .record(z.string(), z.union([z.string(), z.number()]))
                .optional()
                .openapi({
                    description:
                        'Values for the client to interpolate into its own translated message, keyed per `code` — e.g. `{ "max": 120 }` for `FARM_NAME_TOO_LONG`. Ids and quantities only: strings and numbers, never an object and never personal data. Absent for codes that need no values.',
                    example: { max: 120 },
                }),
        }),
    })
    .openapi('ErrorResponse', {
        description: 'Canonical error envelope returned by every error path. `code` is a stable string clients can branch on; `message` is human-readable ENGLISH and is a fallback, not UI copy; `params` carries the values a client interpolates into its own translated sentence; `requestId` correlates with server logs; `details` is optional structured context (validation issues, rate-limit info, etc.).',
    });
export type ApiErrorResponseDTO = z.infer<typeof ApiErrorResponseSchema>;

// ─── Pagination ───

export interface PaginatedResponse<T> {
    items: T[];
    nextCursor?: string;
    total?: number;
}

// ─── Audit Log Entry ───

export const AuditLogEntrySchema = z
    .object({
        id: z.string(),
        action: z.string().openapi({ example: 'CONTROL_CREATED' }),
        entity: z.string().optional().openapi({ example: 'Practice' }),
        entityId: z.string().optional(),
        details: z.string().nullable(),
        createdAt: z.string().datetime().openapi({ example: '2026-04-28T07:42:11.000Z' }),
        user: UserRefShortSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('AuditLogEntry', {
        description: 'A single audit-log row. Hash-chained at the DB layer; this DTO is the read view exposed via the audit/activity endpoints.',
    });
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ─── Success Responses ───

export const SuccessResponseSchema = z
    .object({
        success: z.literal(true),
    })
    .openapi('SuccessResponse', {
        description: 'Empty success envelope. Returned by mutation endpoints that have no resource to echo back (e.g. status changes, links, deletes).',
    });
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
