/**
 * КАИС cadastre overlays, and the farm reports.
 *
 * Two small surfaces with one thing in common: most of what they return is NOT
 * JSON, and a client that assumes it is gets bytes it cannot parse.
 *
 * ── the cadastre is an OPTIONAL integration ──
 *
 * `GET /cadastre/config` answers `{ configured }` and everything else depends
 * on it. When it is false the parcels route returns an EMPTY FeatureCollection
 * rather than an error — a map with no cadastre overlay still works, and
 * failing the request would break the map for a deployment that simply has no
 * КАИС credentials. A client should read `configured` once and hide the layer,
 * not infer absence from an empty result.
 *
 * ── reports: four routes, four different content types ──
 *
 *   GET  /reports/rent-roll       JSON by default, ?format=csv, ?format=pdf
 *   GET  /reports/season-recap    JSON
 *   POST /reports/season-diary    application/pdf
 *   POST /reports/year-on-farm    application/pdf
 *
 * The two PDFs are POST because generating one is a job with a body, not a
 * lookup. They return BYTES — a client must not try to decode JSON from them,
 * and the browser download path is `Content-Disposition`.
 *
 * `rent-roll` is the interesting one: the same URL answers three media types
 * chosen by a query parameter. Its CSV carries a UTF-8 BOM deliberately, so
 * that Excel opens Cyrillic lessor names correctly rather than as mojibake.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const FeatureCollectionSchema = z
    .object({
        type: z.literal('FeatureCollection'),
        features: z.array(z.unknown()),
    })
    .openapi('CadastreFeatureCollection', {
        description:
            'GeoJSON. EMPTY rather than an error when the cadastre integration is not configured or the viewport holds nothing — a map with no overlay still works.',
    });

export function registerCadastreAndReportPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/cadastre/config',
        operationId: 'getCadastreConfig',
        summary: 'Whether the cadastre integration is available',
        description:
            'Read this ONCE and hide the layer when false. The other cadastre routes degrade to empty rather than failing, so an empty result is not evidence that the integration is missing.',
        tags: ['Cadastre'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Availability.',
            schema: z.object({ configured: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/cadastre/parcels/config',
        operationId: 'getCadastreParcelsConfig',
        summary: 'Cadastre parcel-layer availability',
        description: 'The same availability answer, scoped to the parcel layer.',
        tags: ['Cadastre'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Availability.',
            schema: z.object({ configured: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/cadastre/parcels',
        operationId: 'getCadastreParcels',
        summary: 'Cadastre parcels in a viewport',
        description:
            'GeoJSON for the requested `bbox`. Cached, and EMPTY when the integration is unconfigured or nothing falls in the box — never an error for either. A malformed `bbox` is a 400.',
        tags: ['Cadastre'],
        params: TenantParams,
        query: z.object({
            bbox: z
                .string()
                .optional()
                .openapi({ description: 'minLon,minLat,maxLon,maxLat. Malformed → 400.' }),
        }),
        success: {
            status: 200,
            description: 'A FeatureCollection, possibly empty.',
            schema: FeatureCollectionSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/cadastre/wms/{z}/{x}/{y}',
        operationId: 'getCadastreWmsTile',
        summary: 'Cadastre WMS raster tile',
        description:
            'A PNG proxied from the КАИС WMS service. Raster, not GeoJSON — this is the basemap-style overlay, while `/cadastre/parcels` is the queryable vector one.',
        tags: ['Cadastre'],
        params: TenantParams.extend({
            z: z.string().openapi({ param: { name: 'z', in: 'path' } }),
            x: z.string().openapi({ param: { name: 'x', in: 'path' } }),
            y: z.string().openapi({ param: { name: 'y', in: 'path' } }),
        }),
        success: {
            status: 200,
            description: 'The tile image.',
            content: { 'image/png': z.string().openapi({ format: 'binary' }) },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/reports/rent-roll',
        operationId: 'getRentRoll',
        summary: 'Rent roll and obligations',
        description:
            'THREE media types from one URL, chosen by `format`. Default is JSON; `?format=csv` is a UTF-8 CSV **with a BOM** so Excel renders Cyrillic lessor names rather than mojibake; `?format=pdf` is the Cyrillic PDF. Both file formats set `Content-Disposition: attachment`. ' +
            '\n\nRemember that rent settled in GRAIN and rent settled in MONEY are separate obligations here — the roll reports them side by side rather than summing them.',
        tags: ['Reports'],
        params: TenantParams,
        query: z.object({
            format: z.enum(['csv', 'pdf']).optional().openapi({ description: 'Omit for JSON.' }),
            locationId: z.string().optional(),
        }),
        success: {
            status: 200,
            description: 'The rent roll, in the requested representation.',
            content: {
                'application/json': z
                    .object({})
                    .passthrough()
                    .openapi('RentRoll', { description: 'Rent by lessor with obligations and payments.' }),
                'text/csv': z.string().openapi({ description: 'UTF-8 with a BOM, for Excel.' }),
                'application/pdf': z.string().openapi({ format: 'binary' }),
            },
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/reports/season-recap',
        operationId: 'getSeasonRecap',
        summary: 'Season recap figures',
        description:
            'The season’s totals. `seasonName` is NULL when the recap is all-time rather than scoped to a season — that is a mode, not a missing name. ' +
            '\n\nRead `totalYieldTonnes` and `totalNetTonnesStd` as different things: the first is GROSS, the second is moisture-standardised, and `recordsWithMoisture` says how many records could be standardised at all. `costPerHa` is null when NO row carried a cost, which is different from a cost of zero.',
        tags: ['Reports'],
        params: TenantParams,
        query: z.object({ seasonId: z.string().optional(), locationId: z.string().optional() }),
        success: {
            status: 200,
            description: 'The recap.',
            schema: z
                .object({
                    seasonId: z.string().nullable(),
                    /** Null means ALL-TIME, not a missing name. */
                    seasonName: z.string().nullable(),
                    year: z.number().nullable(),
                    totalAreaHa: z.number(),
                    harvestedAreaHa: z.number(),
                    /** GROSS tonnage. */
                    totalYieldTonnes: z.number(),
                    /** Moisture-standardised tonnage. */
                    totalNetTonnesStd: z.number(),
                    unadjustedTonnes: z.number(),
                    /** How many records could be standardised at all. */
                    recordsWithMoisture: z.number(),
                    yieldRecordCount: z.number(),
                    avgYieldTPerHa: z.number().nullable(),
                    /** NULL when no row carried a cost — not a cost of zero. */
                    costPerHa: z.number().nullable(),
                    topFields: z.array(
                        z.object({
                            locationId: z.string(),
                            name: z.string(),
                            yieldTonnes: z.number(),
                            areaHa: z.number().nullable(),
                            tPerHa: z.number().nullable(),
                        }),
                    ),
                    activityCount: z.number(),
                })
                .openapi('SeasonRecap', {
                    description:
                        'A season’s headline figures. GROSS and moisture-standardised tonnage are both reported and are not interchangeable; costPerHa is null when nothing carried a cost, which a client must not render as zero.',
                }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/reports/season-diary',
        operationId: 'generateSeasonDiaryPdf',
        summary: 'Generate the season diary PDF',
        description:
            'POST because generating the document is a job with a body, not a lookup. Returns PDF BYTES with `Content-Disposition` — do not attempt to decode JSON from it.',
        tags: ['Reports'],
        params: TenantParams,
        body: z.object({}).passthrough().openapi('SeasonDiaryRequest'),
        success: {
            status: 200,
            description: 'The PDF.',
            content: { 'application/pdf': z.string().openapi({ format: 'binary' }) },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/reports/year-on-farm',
        operationId: 'generateYearOnFarmPdf',
        summary: 'Generate the year-on-the-farm PDF',
        description:
            'POST for the same reason as the diary. Returns PDF BYTES. Its Certification section was removed deliberately — it was always empty, and an empty section on a printed record reads as missing data rather than as absent data.',
        tags: ['Reports'],
        params: TenantParams,
        body: z.object({}).passthrough().openapi('YearOnFarmRequest'),
        success: {
            status: 200,
            description: 'The PDF.',
            content: { 'application/pdf': z.string().openapi({ format: 'binary' }) },
        },
    });
}
