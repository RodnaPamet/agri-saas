/**
 * Farm Risk — the per-parcel Sentinel-2 readings and the insurance ask.
 *
 * Documented because the native client is porting this screen, and three of
 * its four calls carry a trap that a read of the response shape would not
 * reveal: an irreversible write, a 409 that means "already done" rather than
 * "failed", and a level vocabulary that is not a free-text string.
 *
 * The fourth call, `GET /locations/{id}/parcels`, is already described in
 * `locations.paths.ts`.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ApiErrorResponseSchema } from '@/lib/dto/common';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const ParcelParams = TenantParams.extend({
    parcelId: z.string().openapi({ param: { name: 'parcelId', in: 'path' } }),
});

/**
 * Four levels, not three. `unknown` is a real state — no cloud-free pass in
 * the window, or Earth Engine not configured — and it is NOT an error: the
 * request succeeded and there is nothing to report. A client that maps it to
 * a colour alongside the other three is asserting a reading it does not have.
 */
const RiskLevel = z.enum(['good', 'watch', 'stress', 'unknown']).openapi('RiskLevel', {
    description:
        'good | watch | stress | unknown. `unknown` means no usable satellite reading, ' +
        'not a failure — render it as absence, never as a fourth severity.',
});

const ParcelRisk = z
    .object({
        parcelId: z.string(),
        name: z.string(),
        areaHa: z.number().nullable(),
        cropType: z.string().nullable(),
        configured: z.boolean(),
        ndvi: z.number().nullable(),
        ndmi: z.number().nullable(),
        vegetation: RiskLevel,
        moisture: RiskLevel,
        overall: RiskLevel,
        acquiredDate: z.string().nullable(),
        generatedAt: z.string(),
    })
    .openapi('ParcelRisk');

export function registerFarmRiskPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/analysis',
        operationId: 'getParcelRiskAnalysis',
        summary: 'Vegetation and moisture risk for one parcel',
        description:
            'Sentinel-2-derived NDVI/NDMI means and traffic-light levels. Cached server-side ' +
            'per (tenant, parcel, day) for 6h and served with a weak ETag — send ' +
            '`If-None-Match` and expect 304, because the first call of the day is a live ' +
            'Earth Engine query and the rest are free.\n\n' +
            '`configured: false` means Earth Engine has no credentials on this deployment: ' +
            'every level is `unknown` and no imagery was analysed. Say so rather than ' +
            'showing an empty chart — this field exists so a client never claims an ' +
            'analysis it did not get.\n\n' +
            '`acquiredDate` is the date of the SATELLITE PASS, not of the request. The ' +
            'composite falls back to the latest usable window, so it can be weeks old ' +
            'while `generatedAt` is now. Show the acquisition date; a farmer reading a ' +
            'three-week-old reading as today plans against weather that has since changed.\n\n' +
            'The parcel id is a PATH segment, deliberately. iOS writes the full request ' +
            'URL — query included — to the unified log from its own networking layer, ' +
            'below anything an app can suppress.',
        tags: ['Farm risk'],
        params: ParcelParams,
        success: { status: 200, description: 'Risk readings for the parcel.', schema: ParcelRisk },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/insurance/leads',
        operationId: 'listInquiredParcelIds',
        summary: 'Parcels this tenant has already asked about',
        description:
            'Ids only, ETagged. **Read this before rendering an "ask for offer" control.** ' +
            'A lead is unique per (parcel, tenant), so a second POST is refused — and the ' +
            'web page originally tracked "sent" in component state, which died on unmount, ' +
            'so navigating away and back re-enabled a button whose POST the database then ' +
            'rejected. The operator was told off for retrying something they could not see ' +
            'they had done. This endpoint exists because of that.',
        tags: ['Farm risk'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Parcel ids with an existing lead.',
            schema: z.object({ parcelIds: z.array(z.string()) }).openapi('InquiredParcelIds'),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/insurance/leads',
        operationId: 'createInsuranceLead',
        summary: 'Ask an insurer for an offer on a parcel',
        description:
            '**Irreversible.** There is no DELETE and no withdraw: a lead is unique per ' +
            '(parcel, tenant) and persists, so a parcel can be asked about exactly once, ' +
            'ever. Do not fire this against a real parcel to test the wiring — it ' +
            'permanently disables the control for that parcel.\n\n' +
            'Lead-gen only: the row is stored and a confirmation notification is written ' +
            'for the REQUESTER. No insurer API is called and no other tenant is contacted, ' +
            'which is what separates this from an exchange inquiry.\n\n' +
            'A duplicate returns **409** — treat that as "already asked", not as a failure. ' +
            'Rate-limited on the inquiry tier.',
        tags: ['Farm risk'],
        params: TenantParams,
        body: z
            .object({
                parcelId: z.string().min(1),
                locationId: z.string().min(1).nullable().optional(),
                message: z.string().min(1).max(2000),
                risk: z
                    .object({
                        overall: z.string().max(20).optional(),
                        ndvi: z.number().nullable().optional(),
                        ndmi: z.number().nullable().optional(),
                    })
                    .optional()
                    .openapi({ description: 'Snapshot of what the farmer was shown when asking.' }),
            })
            .openapi('CreateInsuranceLeadRequest'),
        success: {
            status: 201,
            description: 'The lead was recorded.',
            schema: z.object({ id: z.string() }).passthrough(),
        },
        extraResponses: {
            409: {
                description: 'A lead already exists for this parcel — already asked, not an error.',
                content: { 'application/json': { schema: ApiErrorResponseSchema } },
            },
        },
    });
}
