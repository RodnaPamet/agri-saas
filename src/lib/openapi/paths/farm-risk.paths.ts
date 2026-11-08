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

/**
 * How NDVI is DISTRIBUTED across the parcel — #2837 stage 2.
 *
 * The phone shows this for the LATEST reading only (`agrent-ios`, 2026-11-07):
 * the full p10/p50/p90 on the parcel card, and at most `belowThresholdShare`
 * charted over time from the history endpoint.
 */
const WithinField = z
    .object({
        ndviP10: z.number().nullable(),
        ndviP50: z.number().nullable(),
        ndviP90: z.number().nullable(),
        belowThresholdShare: z.number().nullable(),
        threshold: z.number(),
        coverage: z.number().nullable(),
    })
    .openapi('ParcelWithinField', {
        description:
            'NDVI distribution across the parcel. **Every figure is over the CLEAR ' +
            'area, not the whole field** — cloud, shadow, cirrus and snow are masked ' +
            'out and masked pixels are not counted, so `belowThresholdShare: 0.3` ' +
            'means "30% of what the satellite could see is in stress", NOT "30% of ' +
            'the field". Nothing can be said about ground under cloud, and the ' +
            'alternatives both invent a reading: counting cloud as healthy makes a ' +
            'mostly-clouded parcel look fine, counting it as stressed cries wolf.\n\n' +
            '`threshold` is echoed rather than assumed — it is the same NDVI value ' +
            'the `vegetation` level uses for its `stress` boundary, so the share and ' +
            'the level on the same screen cannot disagree.\n\n' +
            'Read `ndviP50` against `ndvi` (the mean): a mean well below the median ' +
            'means a minority of very poor pixels is dragging it down, which is a ' +
            'different problem from a uniformly mediocre crop and wants a different ' +
            'action.\n\n' +
            '`coverage` is the DENOMINATOR made explicit: what share of the parcel the ' +
            'composite could see at all, 0..1. It is the share of parcel pixels with ' +
            'at least one clear observation across the whole window — NOT one pass\u2019s ' +
            'clear share, which would describe a different picture from these numbers, ' +
            'since they are a 30-day median over many passes. Near 1 is the normal ' +
            'case and is not worth telling anyone; well below 1 is when saying how ' +
            'much of the field was visible stops the other figures from being read as ' +
            'statements about the whole parcel.\n\n' +
            '**`coverage < 1` has THREE causes and only two of them are weather**, which ' +
            'matters for the sentence a client shows. (1) Cloud, cloud shadow or thin ' +
            'cirrus — SCL 3, 8, 9, 10. (2) **Snow or ice** — SCL 11, masked exactly like ' +
            'cloud, and on arable land in a Bulgarian winter this is the common case, not ' +
            'an edge one. (3) No qualifying scene covered that part of the parcel at all: ' +
            'a pass is kept on its own clear share over the geometry, so a granule ' +
            'clipping one end of a field can contribute while the other end gets zero ' +
            'observations — nothing to do with the sky.\n\n' +
            'So do NOT render the uncovered remainder as "under cloud". A farmer looking ' +
            'at a field they know is under SNOW, told it was under cloud, has been given ' +
            'a reason to distrust the number the sentence is attached to. Say the ' +
            'satellite had no clear view of the rest, and leave the cause out.',
    });

/**
 * The nine compass cells of a 3x3 grid over a parcel's bounding box.
 *
 * Declared as an ENUM so a client's switch can be exhaustive — `agrent-ios`
 * asked for exactly that, 2026-11-08.
 */
const ZoneCode = z
    .enum(['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'])
    .openapi('ParcelZoneCode', {
        description:
            'Which ninth of the parcel, on a 3x3 grid. `C` is the centre. The compass is ' +
            'GEOGRAPHIC: the grid is cut from the parcel\u2019s WGS84 lat/lon bounding box, so ' +
            '`SE` means the south-east of the FIELD and does not depend on how any map is ' +
            'rotated or oriented.',
    });

const Weakest = z
    .object({
        zone: ZoneCode,
        ndvi: z.number(),
        delta: z.number(),
        bounds: z.array(z.number()).length(4),
    })
    .openapi('ParcelWeakestZone', {
        description:
            'The weakest ninth of the parcel. `delta` is the zone\u2019s mean NDVI minus the ' +
            'field median, so it is always NEGATIVE — a zone is only reported when it is ' +
            'materially below.\n\n' +
            '**`null` means "cannot localise", NOT "the field is even."** Three different ' +
            'situations all return null and are not distinguishable from the outside: a ' +
            'parcel too small to subdivide usefully (a cell needs ~1 ha of clear pixels, so ' +
            'the floor is roughly 9 ha of bounding box, more for an irregular shape), a pass ' +
            'too cloudy for any cell to qualify, and a genuinely uniform field. So say ' +
            'nothing on null \u2014 a sentence like "no weak area" asserts the third when it ' +
            'could be any of them.\n\n' +
            'The floors are deliberate and both agronomic: a cell must hold at least 25 ' +
            'clear 20 m pixels, or the weakest cell is whichever corner the cloud left ' +
            'smallest; and it must sit at least 0.10 NDVI below the median, which is about a ' +
            'third of the width of the `watch` band, so a uniformly mediocre field nominates ' +
            'no arbitrary corner.\n\n' +
            '`bounds` is `[west, south, east, north]` in WGS84 \u2014 the GRID CELL\u2019s box, one ' +
            'ninth of the parcel\u2019s bounding box. It is **not** the parcel\u2019s shape inside ' +
            'that cell: a rectangle drawn from it will extend past an irregular outline. ' +
            'Clip it against the parcel before drawing, or use it as a marker rather than a ' +
            'region.',
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
        withinField: WithinField.nullable(),
        weakest: Weakest.nullable(),
        generatedAt: z.string().datetime(),
    })
    .openapi('ParcelRisk');

/**
 * One satellite pass. Structurally `ParcelRisk` minus the parcel identity, and
 * that is deliberate — the levels are computed by the SAME functions the card
 * uses, so a chart point cannot be coloured by a different scale from the
 * reading above it.
 */
const ParcelRiskPass = z
    .object({
        /** `YYYY-MM-DD` of the ACQUISITION. */
        date: z.string(),
        ndvi: z.number().nullable(),
        ndmi: z.number().nullable(),
        vegetation: RiskLevel,
        moisture: RiskLevel,
        overall: RiskLevel,
        source: z
            .enum(['stored', 'earthengine'])
            .openapi({
                description:
                    'Where this pass came from. `stored` is FINAL — computed on an ' +
                    'earlier request and read back from our own record. `earthengine` ' +
                    'was computed during THIS request, which is the only case in which ' +
                    'a slow or failing Earth Engine can shorten the series. So if a ' +
                    'window returns fewer passes than you expect, this is what tells ' +
                    'you whether retrying is worth anything.',
            }),
    })
    .openapi('ParcelRiskPass');

const ParcelRiskHistory = z
    .object({
        parcelId: z.string(),
        /** The window actually used, after clamping — not necessarily what you sent. */
        days: z.number().int(),
        configured: z.boolean(),
        /** Oldest first. */
        passes: z.array(ParcelRiskPass),
        truncated: z.boolean(),
        generatedAt: z.string().datetime(),
    })
    .openapi('ParcelRiskHistory');

/**
 * `?days=` on the history.
 *
 * Declared although it is optional, for `CatalogueQuery`'s reason: a generated
 * client sends only what the document names.
 */
const HistoryQuery = z.object({
    days: z.coerce
        .number()
        .int()
        .optional()
        .openapi({
            description:
                'Window length in days. CLAMPED to 7-120 rather than refused, and the ' +
                'response echoes the value actually used — read `days` off the body ' +
                'rather than assuming you got what you asked for. An unparseable value ' +
                'is treated as absent (14, matching the phone\u2019s default).',
        }),
});

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
            '`withinField` is the NDVI DISTRIBUTION across the parcel, and it is the ' +
            'reason a single mean is not enough: 0.5 can be a uniformly mediocre crop ' +
            'or an excellent one with a failing corner. `null` when there was no ' +
            'usable imagery. Its figures are over the CLEAR area rather than the whole ' +
            'field — see the schema.\n\n' +
            '`weakest` names the weakest ninth of the parcel, and costs a SECOND Earth ' +
            'Engine call \u2014 per-cell means need a nine-geometry reduction that cannot ride ' +
            'the whole-parcel one. That is why it is here and not on every pass of the ' +
            'history endpoint. It is `null` far more often than not, and `null` means ' +
            '\u201ccannot localise\u201d rather than \u201ceven\u201d \u2014 see the schema.\n\n' +
            'The parcel id is a PATH segment, deliberately. iOS writes the full request ' +
            'URL — query included — to the unified log from its own networking layer, ' +
            'below anything an app can suppress.',
        tags: ['Farm risk'],
        params: ParcelParams,
        success: { status: 200, description: 'Risk readings for the parcel.', schema: ParcelRisk },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/agro/parcels/{parcelId}/analysis/history',
        operationId: 'getParcelRiskHistory',
        summary: 'The per-pass NDVI/NDMI series for one parcel',
        description:
            'The trend behind the sibling `/analysis` card: one entry per cloud-masked ' +
            'Sentinel-2 pass in the window, oldest first, each carrying the same ' +
            '`RiskLevel` vocabulary the card uses.\n\n' +
            '**`ndvi` and `ndmi` are nullable PER PASS, and a null is a real answer.** A ' +
            'pass can be in the collection and still be fully cloud-masked over this ' +
            'parcel — clear over the next field, not over this one. Plot it as a GAP. A ' +
            'client that renders null as 0 draws a cliff to bare soil that never ' +
            'happened, which on a crop chart reads as a failed field.\n\n' +
            'Dates are unique: two orbits can image the same ground on consecutive days, ' +
            'and the server keeps the first non-null reading per date so a chart has one ' +
            'point per x.\n\n' +
            '`truncated: true` means the pass cap was reached and older passes exist ' +
            'beyond what is returned — ask for a shorter window to see them in full.\n\n' +
            '`configured: false` is `/analysis`\u2019s meaning verbatim: Earth Engine has no ' +
            'credentials here, so `passes` is empty because nothing was analysed rather ' +
            'than because the satellite saw nothing. An empty `passes` with ' +
            '`configured: true` is the genuine "no usable pass in this window" case, and ' +
            'the two must not be shown the same way.\n\n' +
            'Readings are STORED, not merely cached: every pass this endpoint computes ' +
            'is kept per (parcel, acquisition date), so a period question answers from ' +
            'our own record rather than a live Earth Engine call. That is what makes it ' +
            'keep working while Earth Engine is slow or down, and what makes a 120-day ' +
            'question cost the same as a 14-day one. Earth Engine is consulted only for ' +
            'dates never searched before, plus a short recent tail — Sentinel-2 L2A for ' +
            'the last few days is still being processed, so a pass can appear after the ' +
            'fact.\n\n' +
            'Also cached per (tenant, parcel, days, day) for 6h and ETagged — send ' +
            '`If-None-Match`. A new pass arrives every ~5 days, so a 304 is the normal ' +
            'answer.',
        tags: ['Farm risk'],
        params: ParcelParams,
        query: HistoryQuery,
        success: {
            status: 200,
            description: 'The pass series for the parcel.',
            schema: ParcelRiskHistory,
        },
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
