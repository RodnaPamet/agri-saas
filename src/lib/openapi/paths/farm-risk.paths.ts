/**
 * Farm Risk — the per-parcel Sentinel-2 readings and the insurance ask.
 *
 * Documented because the native client is porting this screen, and three of
 * its four calls carry a trap that a read of the response shape would not
 * reveal: a write that cannot be undone, a "have they asked already" list that
 * must NOT be used to disable the ask, and a level vocabulary that is not a
 * free-text string.
 *
 * The fourth call, `GET /locations/{id}/parcels`, is already described in
 * `locations.paths.ts`.
 */
import { z } from '@/lib/openapi/zod';
import { LOCALES } from '@/lib/i18n/locales';
import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
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
        generatedAt: z.string().datetime(),
    })
    .openapi('ParcelRisk');

/**
 * `?locale=` on the catalogue.
 *
 * Optional, because the endpoint has a defined fallback — but DECLARED, because
 * a generated client only sends what the document names. The enum is derived
 * from `LOCALES` rather than restated, so adding a locale cannot leave this
 * behind.
 */
const CatalogueQuery = z.object({
    locale: z
        .enum(LOCALES)
        .optional()
        .openapi({
            description:
                'Which language to resolve `name` and `blurb` in. DECLARE it — ' +
                '`Accept-Language` is deliberately ignored, and the fallback is the ' +
                '`NEXT_LOCALE` cookie then `en`. A client whose UI is Bulgarian by ' +
                'declaration rather than by device setting must send `bg` on every ' +
                'request; a device reporting English-language/Bulgarian-region would ' +
                'otherwise be served English names for an entirely Bulgarian screen.',
        }),
});

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
            'Ids only, ETagged. **Informational — do NOT use it to disable the ask.**\n\n' +
            'It was written when a lead was unique per (parcel, tenant): the web page had ' +
            'tracked "sent" in component state, which died on unmount, so navigating away ' +
            'and back re-enabled a button whose POST the database then rejected, and the ' +
            'operator was told off for retrying something they could not see they had ' +
            'done.\n\n' +
            'Since the unique was dropped on 2026-09-24 a parcel may be asked about more ' +
            'than once, so the right use is to TELL the farmer they have asked before ' +
            'while leaving the control active. A client that still suppresses the trigger ' +
            'makes the re-ask unreachable.',
        tags: ['Farm risk'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Parcel ids with an existing lead.',
            schema: z.object({ parcelIds: z.array(z.string()) }).openapi('InquiredParcelIds'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/insurance/products',
        operationId: 'listInsuranceProducts',
        summary: 'The insurance product catalogue and its tariffs',
        description:
            'For clients that cannot import the pricing engine. The web app does not ' +
            'need this — it imports the same constant the engine uses — so it exists ' +
            'for a SEPARATE codebase, where a compiled-in tariff is a second ' +
            'description of one thing.\n\n' +
            'That duplication is worse than most, because it is asymmetric: the SERVER ' +
            'recompute is what gets stored and emailed, so a stale local tariff shows ' +
            'the farmer one figure and the operator another, with nothing on either ' +
            'side saying so. Fetch this rather than hardcoding `tariffBp`.\n\n' +
            '`engineVersion` is the rounding rules the tariffs belong to. Do not send ' +
            'it anywhere — compare it, so a preview built against version N notices ' +
            'the server has moved to N+1.\n\n' +
            'Language is DECLARED, not negotiated: pass `?locale=bg` (or rely on the ' +
            '`NEXT_LOCALE` cookie). `Accept-Language` is deliberately ignored — a ' +
            'device set to English-language/Bulgarian-region would otherwise pull ' +
            'English product names onto an entirely Bulgarian screen. Absent both, ' +
            'the answer is English, so a client that wants Bulgarian must say so.\n\n' +
            'The labels here are the SOURCE for native clients; where five of them ' +
            'overlap a client\'s own commodity names, that equality is intentional — ' +
            'change `insurance.products.<key>.name` in `messages/` and both follow.',
        tags: ['Farm risk'],
        params: TenantParams,
        // Declared, so a GENERATED client sends it. Omitting it left the
        // document describing an endpoint whose only parameter was the tenant —
        // so a generated client never asked for a language, fell through to the
        // deliberate `en` default, and was served English product names as DATA.
        // That is the same hole as `required: ['parcelId']`: a contract the
        // document does not carry is one every new client gets wrong, and "we
        // always send it" is luck rather than a contract. Reported by the iOS
        // client after building against the document.
        query: CatalogueQuery,
        success: {
            status: 200,
            description: 'The catalogue, with copy resolved for the declared locale.',
            schema: z
                .object({
                    engineVersion: z.number().int(),
                    currencySymbol: z.string(),
                    products: z.array(
                        z.object({
                            key: z.string(),
                            kind: z.enum(['crop', 'peril']),
                            commodity: z.string().optional(),
                            tariffBp: z.number().int(),
                            name: z.string(),
                            blurb: z.string(),
                        }),
                    ),
                })
                .openapi('InsuranceCatalogue'),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/insurance/leads',
        operationId: 'createInsuranceLead',
        summary: 'Ask an insurer for an offer on a parcel',
        description:
            '**Irreversible, and now repeatable.** There is still no DELETE and no ' +
            'withdraw — a lead persists once written. What changed on 2026-09-24 is that ' +
            'the unique on (parcel, tenant) was dropped, so a parcel may carry SEVERAL ' +
            'leads: the form collects the farmer\'s own land size, and a figure they got ' +
            'wrong the first time could not otherwise be corrected.\n\n' +
            'Consequences for a client:\n' +
            '- A second POST no longer returns 409. It creates another lead and emails the ' +
            'operator again.\n' +
            '- **Do not disable the control** because `GET /insurance/leads` lists the ' +
            'parcel. That endpoint is now INFORMATIONAL — suppressing the trigger makes ' +
            'the re-ask this change exists to allow unreachable.\n' +
            '- Still do not fire it against a real parcel to test wiring: every lead is an ' +
            'email to the platform operator, who has to reconcile duplicates by hand.\n\n' +
            'Lead-gen only: the row is stored, a confirmation notification is written for ' +
            'the REQUESTER and a copy is sent to the operator. No insurer API is called ' +
            'and no other tenant is contacted, which is what separates this from an ' +
            'exchange inquiry. Opened by the three-step calculator on Farm risk, '  +
            'which previews the premium and posts only the four quote INPUTS. '  +
            'Rate-limited on its OWN tier (INSURANCE_LEAD_LIMIT, 20 per hour): '  +
            'every lead emails the operator, and the inquiry tier\'s per-minute '  +
            'window allowed 600 of those an hour.',
        tags: ['Farm risk'],
        params: TenantParams,
        // The route's OWN schema, not a copy. The inline redeclaration this
        // replaces had already drifted: it still required `message`, which is
        // optional when a quote is present, and knew nothing about `quote` at
        // all. A second spelling of a contract is a contract that goes stale
        // silently.
        // `required` alone says `parcelId` and stops, because the "a message OR a
        // quote" rule is a Zod refine and `required` cannot express an either-or.
        // A generated client therefore read this document, sent `{ parcelId }`,
        // and got a 400 on every request — which is not hypothetical: the iOS
        // client did exactly that from the day the ask shipped, and every
        // enquiry a Bulgarian farmer made failed for weeks before anyone noticed.
        //
        // The `anyOf` below states the rule in the document, so a generator
        // carries it; the description states it in words, for the human who
        // reads the schema and never opens the refine.
        body: CreateInsuranceLeadSchema.openapi('CreateInsuranceLeadRequest', {
            description:
                'Send a non-blank `message`, a `quote`, or both — `required` lists ' +
                '`parcelId` only because an either-or cannot be expressed there, and a ' +
                'body with neither is a 400. `quote.coveredParcelCount` is required ' +
                'when `quote.areaScope` is `crop-at-location`. Never send a premium, ' +
                'tariff or instalment amount: there is no such field and one is ' +
                'stripped if present, because the server recomputes the price.',
            anyOf: [{ required: ['message'] }, { required: ['quote'] }],
        }),
        success: {
            status: 201,
            description:
                'The lead was recorded. **Honours `Idempotency-Key`** \u2014 replaying a ' +
                'request with the same key returns the ORIGINAL lead, with no second ' +
                'row, no second audit entry and no second operator email. The key is ' +
                'scoped to the requesting tenant and must be 1-128 characters of ' +
                '`[A-Za-z0-9_-]`.\n\n' +
                'When the body carried a `quote`, the response echoes the figures the ' +
                'SERVER computed. A premium sent by the client is ignored: the request ' +
                'schema has no price field and strips one if present.',
            schema: z
                .object({
                    id: z.string(),
                    status: z.string(),
                    quote: z
                        .object({
                            premiumCents: z.number().int(),
                            instalmentsCents: z.array(z.number().int()),
                            tariffBp: z.number().int(),
                            engineVersion: z.number().int(),
                        })
                        .optional()
                        .openapi({
                            description:
                                'Present when the lead carries a quote. Integer cents and ' +
                                'basis points, so nothing rounds a float in transit.',
                        }),
                })
                .openapi('CreateInsuranceLeadResponse'),
        },
    });
}
