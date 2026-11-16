/**
 * `/api/agro-calendar` — «Агрономически календар», published Bulgarian
 * agronomy by crop and region.
 *
 * ## Citations are NOT served (owner instruction 2026-11-16)
 *
 * Every window in the DATASET is cited and the loader refuses one that is
 * not — that rule is unchanged and lives in `calendar/schema.ts`. What this
 * endpoint no longer returns is the citation itself: no `cites` on a window,
 * no `cite` on a costs block, and no `sources` map. The references were
 * rendering as «МЗХ, 2024, стр. 190» under each window on the phone and the
 * owner asked for them off the screen; the payload is the only place that
 * settles it for every client at once.
 *
 * So "published WITH SOURCES" still describes how the data is AUTHORED, and
 * no longer describes what is displayed. Those read as opposites at a glance,
 * which is why it is written down here rather than left to inference.
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
import { CALENDAR_COST_LINES } from '@/lib/agro/calendar/costs';

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
            '\n\n**No citations are returned** (owner instruction 2026-11-16). A window used to carry `cites` and the response a `sources` map, which clients rendered as «МЗХ, 2024, стр. 190» under each entry. The dataset is still cited per window and the loader still refuses an uncited one — the provenance is internal now, not displayed. Do not reintroduce a source line from any other field.' +
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
                    crops: z.array(
                        z.object({
                            key: z.string().openapi({ example: 'wheat-bread' }),
                            group: z.enum(['field', 'vegetable', 'perennial']),
                            commodityCanonical: z.string().optional().openapi({
                                description:
                                    'Joins `CropType.commodityCanonical` where one exists — absent for most vegetables and perennials, which have no canonical commodity.',
                            }),
                            name: z.object({ bg: z.string(), en: z.string().optional() }),
                            costs: z
                                .object({
                                    basis: z.object({
                                        areaDa: z.number().int().openapi({ example: 100 }),
                                        currency: z.literal('BGN'),
                                        unit: z.literal('stotinki'),
                                    }).openapi({
                                        description:
                                            'The area and units the card prints its figures for. `published` values below are for THIS area, in these units — nothing is pre-divided.',
                                    }),
                                    lines: z.array(
                                        z.object({
                                            key: z.enum(CALENDAR_COST_LINES),
                                            published: z.number().int().openapi({
                                                example: 417779,
                                                description:
                                                    'Integer стотинки exactly as the card prints it, for `basis.areaDa`. `417779` is 4 177,79 лв.',
                                            }),
                                            perDaEurCents: z.number().int().nullable().openapi({
                                                example: 2136,
                                                description:
                                                    'Euro cents per decare, derived server-side so no client holds the lev peg and two clients cannot round differently. Null if the basis is unusable.',
                                            }),
                                        }),
                                    ),
                                    publishedTotal: z.number().int().openapi({ example: 11109297 }),
                                    perDaEurCentsTotal: z.number().int().nullable().openapi({
                                        example: 56801,
                                        description:
                                            'Rounded ONCE from `publishedTotal`, not summed from the rounded lines — the card states that total in its own right. The lines are required to sum to it in стотинки, and on the current card the two agree exactly (56801 either way); rounding is not additive in general, so a future card may leave them a cent or two apart, and neither is adjusted to tidy the arithmetic.',
                                    }),
                                })
                                .optional()
                                .openapi({
                                    description:
                                        'Published direct costs, where the МЗХ card prints them — **only the vine card does**. The 2024 field, vegetable, legume and perennial cards are blank templates giving quantities with every price cell empty, so those crops carry no `costs` rather than an estimate. Figures are stored as printed, in lev, and converted to euro only for display (owner ruling 2026-11-16, a narrow exception to EUR-everywhere for published reference data). The lev figure is the traceable one; show the euro.',
                                }),
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
                                }),
                            ),
                        }),
                    ),
                })
                .openapi('AgroCalendar'),
        },
    });
}
