/**
 * `/api/lunar` — «Лунен календар», the one read in this API that is about the
 * sky rather than about a farm.
 *
 * ## Why it is DOCUMENTED rather than baselined
 *
 * `UNDOCUMENTED_BASELINE` holds 216 routes that predate the rule; the house
 * culture is that a new one joins the spec instead (`ASSET_NOT_FOUND` was the
 * first entry ever DELETED from that list rather than added to it). This
 * endpoint is also the first thing agrent-ios builds «Лунен календар»
 * against — a client contract with no schema is one the phone has to infer
 * from a sample response.
 *
 * ## Every enum here is DERIVED from the engine, never retyped
 *
 * `SIGNS`, `ELEMENTS`, `DAY_TYPES`, `CROP_GROUPS` and `RECOMMENDATIONS` are
 * imported and spread. A spec that restated them would be a second catalogue
 * that goes stale the day a rule is added — and the direction of that drift is
 * the bad one: the phone decodes against the spec, so a missing
 * `Recommendation` member is a decode failure on a day the web renders fine.
 * Adding a rule to `rules.ts` therefore widens this automatically.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

import { SIGNS, ELEMENTS, DAY_TYPES } from '@/lib/lunar/zodiac';
import { CROP_GROUPS, RECOMMENDATIONS } from '@/lib/lunar/rules';
import { MAX_LUNAR_DAYS } from '@/lib/lunar/lunar-day';

const DAY_KEY = z.string().openapi({
    description: 'A calendar day in `Europe/Sofia`, `YYYY-MM-DD`.',
    example: '2026-03-21',
});

const RECOMMENDATION = z.enum([...RECOMMENDATIONS]).openapi({
    description:
        'A rule-table verdict. Render it through the `lunar.rec*` message key for the recommendation — the server sends no prose, so the catalogue is the only copy. Treat an unrecognised member as "no advice" rather than as an error: this list grows.',
    example: RECOMMENDATIONS[0],
});

export function registerLunarPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/lunar',
        operationId: 'getLunarCalendar',
        summary: 'The lunar sowing calendar for a date range',
        description:
            'Sidereal Moon position per day, with the traditional root/leaf/flower/fruit day type and the rule table\'s advice per crop group.' +
            '\n\n**Person-scoped and farm-free.** There is no `tenantSlug` in the path and no farm in the answer: the result is identical for every caller in the country on a given date. That is deliberate — «Лунен календар» must work before a farmer has created a farm, and without Google.' +
            '\n\n**It does NOT flag agro-signal conflicts, and that is a measurement rather than an omission.** `AgroSignal` is keyed `(tenantId, locationId, kind, signalDate)` — per BLOCK — so a farm with twelve blocks can have frost on two. A day-level boolean would either over-suppress every block or say nothing about which one, so the conflict is composed client-side where the location is held.' +
            `\n\n**The range is capped at ${MAX_LUNAR_DAYS} days** (a month view with both neighbours). Each day costs a Moon position plus a bisection for its sign change, so a longer span is refused rather than served slowly.` +
            '\n\n**SIDEREAL, not tropical.** The day type follows the constellation the Moon is actually in; the tropical zodiac has drifted about 24° — roughly one sign — since it was fixed, so a tropical reading disagrees with this for most of any month. That is the tradition this calendar comes from, and the discrepancy is expected rather than a bug.' +
            '\n\n**ETagged and deterministic.** The same range returns the same bytes for ever — send `If-None-Match` and expect 304.' +
            '\n\nBehind the `lunar.enabled` feature flag, which 404s while off: a 404 here means "not enabled", not "wrong URL".',
        tags: ['Agronomy'],
        query: z.object({
            from: DAY_KEY.openapi({
                param: { name: 'from', in: 'query', required: true },
                description: 'First day, inclusive. `YYYY-MM-DD`.',
                example: '2026-03-01',
            }),
            to: DAY_KEY.openapi({
                param: { name: 'to', in: 'query', required: true },
                description:
                    `Last day, inclusive. \`YYYY-MM-DD\`. At most ${MAX_LUNAR_DAYS} days after \`from\`; a wider span is a 400, as is a date that does not exist (\`2026-02-30\` is refused rather than silently read as 2 March).`,
                example: '2026-03-31',
            }),
        }),
        success: {
            status: 200,
            description: 'One entry per day in the range, in ascending date order.',
            schema: z
                .object({
                    days: z.array(
                        z.object({
                            date: DAY_KEY,
                            phase: z.enum(['waxing', 'waning']).openapi({
                                description:
                                    'Which way the illuminated fraction is going. The rule table keys on this, not on `phaseName`.',
                            }),
                            phaseName: z
                                .enum([
                                    'new',
                                    'waxingCrescent',
                                    'firstQuarter',
                                    'waxingGibbous',
                                    'full',
                                    'waningGibbous',
                                    'lastQuarter',
                                    'waningCrescent',
                                ])
                                .openapi({
                                    description:
                                        'The named phase, for display. The four quarter names cover a ±6° window around the exact instant, so two consecutive days can both read `full`.',
                                }),
                            illumination: z.number().openapi({
                                description: 'Illuminated fraction of the disc, 0..1.',
                                example: 0.52,
                            }),
                            sign: z.enum([...SIGNS]).openapi({
                                description:
                                    'The SIDEREAL sign the Moon occupies at farm-local noon.',
                            }),
                            element: z.enum([...ELEMENTS]),
                            dayType: z.enum([...DAY_TYPES]).openapi({
                                description:
                                    'The traditional day type, derived from the sign\'s element: fire→fruit, earth→root, air→flower, water→leaf. Measured at farm-local NOON, so a day holding a sign change is labelled by whichever sign holds the middle of it — `transitions` is what says the boundary exists.',
                            }),
                            transitions: z
                                .array(
                                    z.object({
                                        at: z.string().datetime().openapi({
                                            description: 'UTC instant of the sign change.',
                                        }),
                                        toSign: z.enum([...SIGNS]),
                                        toDayType: z.enum([...DAY_TYPES]),
                                    }),
                                )
                                .openapi({
                                    description:
                                        'Sign changes falling inside this local day, if any. Usually empty — the Moon spends about 2.2 days per sign — and never more than one in practice. Present so a client can show that the day is split rather than implying the noon reading held all day.',
                                }),
                            recommendations: z
                                .object(
                                    Object.fromEntries(
                                        CROP_GROUPS.map((g) => [g, z.array(RECOMMENDATION)]),
                                    ) as Record<(typeof CROP_GROUPS)[number], z.ZodArray<typeof RECOMMENDATION>>,
                                )
                                .openapi({
                                    description:
                                        'The rule table\'s advice for this `(dayType, phase)`, per crop group. An empty array means the tradition offers nothing for that group that day — which is a real answer, not a gap.',
                                }),
                        }),
                    ),
                    timeZone: z.string().openapi({
                        description:
                            'The zone every `date` is labelled in. Fixed to the farm zone, and sent so a client never has to assume it.',
                        example: 'Europe/Sofia',
                    }),
                    maxDays: z.number().openapi({
                        description:
                            'The server\'s range cap, so a client can bound its own request instead of discovering the limit with a 400.',
                        example: MAX_LUNAR_DAYS,
                    }),
                })
                .openapi('LunarCalendar'),
        },
    });
}
