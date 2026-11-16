/**
 * `/api/agro-calendar` — «Агрономически календар», published agronomy with a
 * citation per window.
 *
 * Its own module rather than an addition to `agro.paths.ts`, which documents
 * the FARM's own agronomy — readings, signals, parcel analysis, all
 * tenant-scoped. This is the opposite: reference data about Bulgarian
 * agriculture, person-scoped and identical for every farm in a region. Keeping
 * them apart means the next reader can see in one place what a signed-in
 * person with no farm can reach.
 *
 * Enums are DERIVED from the dataset contract, so a new unit or group widens
 * the spec automatically rather than drifting from it.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

import { CALENDAR_UNITS } from '@/lib/agro/calendar/schema';

const Citation = z
    .object({
        source: z.string().openapi({
            description: 'A key in the `sources` map of this same response.',
            example: 'mzh-ip-2024',
        }),
        page: z.union([z.number(), z.string()]).openapi({
            description: 'The page carrying the figure. A string where the source cites a span.',
            example: 20,
        }),
    })
    .openapi('AgroCalendarCitation');

export function registerAgroCalendarPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/agro-calendar',
        operationId: 'getAgroCalendar',
        summary: 'Sowing, field-work and harvest windows for a Bulgarian region',
        description:
            'Published agronomy for field crops, vegetables and perennials: sowing windows with early/optimal/late bands plus rate and depth, field work by stage, and harvest windows. **Every window carries a citation.**' +
            '\n\n**Person-scoped and farm-free**, like `GET /api/lunar`: no `tenantSlug`, and the answer is identical for every farm in a region. It works before a farmer has created a farm, which is why it is not a tenant route.' +
            '\n\n**The REGION is chosen by the client**, from the farm\'s own blocks. It is deliberately not resolved server-side: that would need the farm this route does without, and a farm with blocks in both halves of the country has no single region to inherit. An unrecognised `region` is a **400, never a default** — defaulting would serve one half of the country\'s sowing dates to the other half silently.' +
            '\n\n**`from > to` MEANS THE WINDOW WRAPS THE YEAR.** Ten of the windows do — pruning runs 15 December to 30 March. A client comparing `from <= today <= to` lexically gets those exactly backwards and reports pruning season for the eight months it is not. Treat a wrapped window as `today >= from OR today <= to`.' +
            '\n\n**Dates are `MM-DD` with no year**, because the windows recur annually.' +
            '\n\n**Units are as the source writes them and are never converted** — `seeds/m2` for cereals, `plants/m2` for rapeseed, `plants/da` for sunflower. A converted figure is a number no cited page supports. The set is closed, so a client can switch on it exhaustively.' +
            '\n\n**`cites` is one ordered list** — the window\'s primary citation followed by any additional ones. A harvest window\'s start and completion often come from two different weekly bulletins, so there is no meaningful "primary"; rendering only the first would hide the evidence for the other endpoint.' +
            '\n\n`conventions` ships with the data and states the authoring rules it was compiled under, including that a window without a page supporting it is left OUT rather than served uncited. The server refuses to load a dataset that breaks either rule, so a window you receive always resolves to a real source.' +
            '\n\nBehind the `agro.calendar` feature flag, which 404s while off: a 404 means "not enabled", not "wrong URL".' +
            '\n\n**Stage 1 of two.** This serves the committed base. Admin corrections — global, audited, per-window, each carrying a required `basis` — arrive in stage 2, and an overridden window will be marked so «Коригирано от Agrent» can render INSTEAD of a source citation rather than beside a stale one.',
        tags: ['Agro'],
        query: z.object({
            region: z.enum(['north', 'south']).openapi({
                param: { name: 'region', in: 'query', required: true },
                description:
                    'North or South Bulgaria. A window marked `both` is returned for either.',
            }),
            group: z.enum(['field', 'vegetable', 'perennial']).optional().openapi({
                param: { name: 'group', in: 'query' },
            }),
            crop: z.string().optional().openapi({
                param: { name: 'crop', in: 'query' },
                description:
                    'A crop `key` from this calendar. An unknown key is a 400 rather than an empty list — an empty list would read as "covered, nothing to say".',
                example: 'wheat-bread',
            }),
        }),
        success: {
            status: 200,
            description:
                'The crops for that region, each with the windows that apply to it. A crop whose every window was filtered out is omitted rather than returned empty.',
            schema: z
                .object({
                    region: z.enum(['north', 'south']),
                    schemaVersion: z.number(),
                    compiledAt: z.string().openapi({
                        // DAY resolution, which `timestamps-declare-their-format`
                        // accepts as `format: date` — the dataset is compiled on a
                        // day, not at an instant, and `date-time` would invent a
                        // precision the value does not have.
                        format: 'date',
                        example: '2026-11-16',
                    }),
                    conventions: z.array(z.string()).openapi({
                        description:
                            'The authoring rules this dataset was compiled under. Shipped with the data so a reader can see what the citations are worth.',
                    }),
                    sources: z.record(
                        z.string(),
                        z.object({
                            title: z.string(),
                            publisher: z.string().openapi({ example: 'МЗХ' }),
                            url: z.string(),
                            published: z.string().optional(),
                        }),
                    ),
                    crops: z.array(
                        z.object({
                            key: z.string().openapi({ example: 'wheat-bread' }),
                            group: z.enum(['field', 'vegetable', 'perennial']),
                            commodityCanonical: z.string().optional().openapi({
                                description:
                                    'Joins `CropType.commodityCanonical` where one exists — absent for most vegetables and perennials, which have no canonical commodity.',
                            }),
                            name: z.object({ bg: z.string(), en: z.string().optional() }),
                            windows: z.array(
                                z.object({
                                    id: z.string().openapi({
                                        description:
                                            'Stable. It is how stage 2 addresses a correction, so treat it as the window\'s identity rather than its position.',
                                    }),
                                    kind: z.enum(['sowing', 'fieldwork', 'harvest']),
                                    band: z.enum(['early', 'optimal', 'late']).optional().openapi({
                                        description: 'Always present for `sowing`.',
                                    }),
                                    region: z.enum(['north', 'south', 'both']),
                                    // `MM-DD`, deliberately NOT `format: date`:
                                    // these recur annually and carry no year, so
                                    // declaring them a date would be a false
                                    // declaration a generated client would act on
                                    // by parsing them. The absence is the honest
                                    // answer here, and the format guard agrees —
                                    // it does not ask for one.
                                    from: z.string().openapi({ example: '09-25' }),
                                    to: z.string().openapi({ example: '10-10' }),
                                    title: z
                                        .object({ bg: z.string(), en: z.string().optional() })
                                        .optional()
                                        .openapi({
                                            description:
                                                "The stage as the source words it («От сеитба до братене»). `stage.bbch` alone cannot say \"before sowing\".",
                                        }),
                                    note: z
                                        .object({ bg: z.string(), en: z.string().optional() })
                                        .optional()
                                        .openapi({
                                            description:
                                                'Quoted or closely paraphrased from the cited page. It inherits the window\'s citation, so it is source text rather than advice of ours.',
                                        }),
                                    stage: z.object({ bbch: z.string().optional() }).optional(),
                                    work: z.string().optional(),
                                    seedRate: z
                                        .object({
                                            min: z.number(),
                                            max: z.number(),
                                            unit: z.enum(CALENDAR_UNITS),
                                        })
                                        .optional(),
                                    depth: z
                                        .object({
                                            min: z.number(),
                                            max: z.number(),
                                            unit: z.enum(CALENDAR_UNITS),
                                        })
                                        .optional(),
                                    density: z
                                        .object({
                                            min: z.number(),
                                            max: z.number(),
                                            unit: z.enum(CALENDAR_UNITS),
                                        })
                                        .optional(),
                                    cites: z.array(Citation).openapi({
                                        description:
                                            'Never empty. Ordered: the primary citation first, then any additional pages.',
                                    }),
                                }),
                            ),
                        }),
                    ),
                })
                .openapi('AgroCalendar'),
        },
    });
}
