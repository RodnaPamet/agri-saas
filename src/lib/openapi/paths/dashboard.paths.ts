/**
 * Dashboard and briefing reads.
 *
 * Documented because a second client is being written against them and the
 * alternative was inferring field names from this repo's TypeScript — which is
 * how the iOS side arrived at seven `CostEntry` fields it could not verify
 * against anything. These four routes were on the undocumented baseline; they
 * are described here so they come off it.
 *
 * Two things in here a schema cannot say on its own, so they are said in prose:
 *
 *   1. `enabledModules` is always PRESENT and always an array. A disabled module
 *      is ABSENT FROM IT — not present-and-empty, not flagged. Client gating is
 *      membership in that array, and the array is the plan ceiling intersected
 *      with the tenant's own switches, so absence does not distinguish "turned
 *      off" from "not in the plan".
 *   2. `achievements` and `briefing` are null for ordinary reasons, not error
 *      ones. A tenant with no ag module has no achievements; a tenant with no
 *      satellite configuration has no briefing. Hide the card rather than
 *      treating null as a failure.
 *
 * A third thing is deliberately NOT here: `certification` used to ride on the
 * ag payload, typed `AgDashboardCertification | null` with a docblock promising
 * it appeared once the CERTIFICATION module was on. Nothing ever populated it —
 * the scheme catalogue was removed with the compliance uproot — so the type and
 * the comment described a world that no longer existed. It is gone rather than
 * documented as reserved, because a documented fiction is still a fiction.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const DaysQuery = (dflt: number) =>
    z.object({
        days: z.coerce.number().int().positive().optional().openapi({
            param: { name: 'days', in: 'query' },
            description:
                `Window length in days. Defaults to ${dflt}. A non-numeric value falls back ` +
                'to the default rather than erroring, so a malformed client cannot break the ' +
                'chart — it silently gets the default window.',
        }),
    });

// ─── /dashboard/ag ────────────────────────────────────────────────────

const JournalItem = z
    .object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
        occurredAt: z.string().nullable(),
    })
    .openapi('AgDashboardJournalItem');

const LowStockItem = z
    .object({
        id: z.string(),
        name: z.string(),
        quantityOnHand: z.number(),
        unitSymbol: z.string(),
    })
    .openapi('AgDashboardLowStockItem');

const DashboardTaskItem = z
    .object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        dueAt: z.string().nullable(),
    })
    .openapi('AgDashboardTaskItem');

const MILESTONE_KEYS = [
    'framework-100',
    'evidence-all-current',
    'audit-pack-complete',
    'first-practice-mapped',
    'first-field-mapped',
    'spray-job-complete',
    'first-harvest',
    'season-closed',
] as const;

const Achievements = z
    .object({
        milestones: z.array(
            z.object({
                key: z.enum(MILESTONE_KEYS),
                earned: z.boolean(),
                earnedAt: z.string().nullable(),
            }),
        ),
        streak: z.object({ current: z.number().int(), best: z.number().int() }),
    })
    .openapi('AgDashboardAchievements', {
        description:
            'Every milestone is returned with `earned` false rather than omitted, so a client ' +
            'renders the full set and does not have to know the list. `earnedAt` is null ' +
            'exactly when `earned` is false.',
    });

const AgDashboard = z
    .object({
        /**
         * The vocabulary, not just the mechanism. Absence from this array is
         * the gating signal, so a client that cannot see the value set cannot
         * act on it — it was documented as `string[]` and the module names
         * appeared nowhere in the spec.
         *
         * Mirrors `ALL_MODULES` in `src/lib/modules.ts`. A client should treat
         * an unrecognised name as NOT-enabled rather than failing: the set can
         * grow, and a new module is by definition one the client has no panel
         * for.
         */
        enabledModules: z.array(
            z.enum([
                'JOURNAL',
                'INVENTORY',
                'PLANNING',
                'CERTIFICATION',
                'AUTOMATION',
                'PROCESSES',
                'AI',
                'GRAIN',
                'EXCHANGE',
            ]),
        ),
        recentJournal: z.array(JournalItem),
        lowStock: z.array(LowStockItem),
        myTasks: z.array(DashboardTaskItem),
        achievements: Achievements.nullable(),
    })
    .openapi('AgDashboardPayload');

// ─── /dashboard/trends ────────────────────────────────────────────────

const TrendDataPoint = z
    .object({
        date: z.string(),
        evidenceOverdue: z.number().int(),
        evidenceDueSoon7d: z.number().int(),
        evidenceCurrent: z.number().int(),
        tasksOpen: z.number().int(),
        tasksOverdue: z.number().int(),
        assetsTotal: z.number().int(),
        assetsActive: z.number().int(),
        assetsHighCriticality: z.number().int(),
        assetsRetired: z.number().int(),
    })
    .openapi('TrendDataPoint');

const TrendPayload = z
    .object({
        dataPoints: z.array(TrendDataPoint),
        daysRequested: z.number().int(),
        daysAvailable: z.number().int(),
        rangeStart: z.string(),
        rangeEnd: z.string(),
    })
    .openapi('TrendPayload', {
        description:
            '`daysAvailable` can be SMALLER than `daysRequested` — a young tenant has fewer ' +
            'days of history than you asked for. Plot the range you were given, not the one ' +
            'you requested: a chart that pads the difference with zeroes shows a collapse ' +
            'that never happened.',
    });

// ─── /dashboard/task-trend ────────────────────────────────────────────

const FarmTaskTrendPoint = z
    .object({ date: z.string(), created: z.number().int(), completed: z.number().int() })
    .openapi('FarmTaskTrendPoint');

// ─── /reports/field-briefing ──────────────────────────────────────────

const BriefingAction = z
    .object({
        field: z.string().nullable(),
        action: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
    })
    .openapi('BriefingAction', {
        description: '`field` is null for an action that applies to the whole farm.',
    });

const FieldBriefing = z
    .object({
        headline: z.string(),
        summary: z.string(),
        actions: z.array(BriefingAction),
    })
    .openapi('FieldBriefing');

const FieldBriefingPayload = z
    .object({
        aiConfigured: z.boolean(),
        satelliteConfigured: z.boolean(),
        satelliteAvailable: z.boolean(),
        generatedAt: z.string(),
        date: z.string(),
        fieldCount: z.number().int(),
        /**
         * ALWAYS PRESENT, and null whenever there is no briefing to give —
         * which is an ordinary state, not an error.
         *
         * Written as an explicit union, which yields
         * `anyOf: [{$ref}, {type: null}]` at the use site.
         *
         * ── Three correct forms, and why this file uses this one ──
         *
         * A nullable object ref is expressed three ways in this spec, and the
         * choice is not arbitrary:
         *
         *   `UserRef` is reused by five payloads, so it cannot bake a null into
         *   itself — the nullability goes at each reference site, as
         *   `allOf: [{$ref}, {type: ["object","null"]}]`.
         *
         *   `AgDashboardAchievements` below is single-use, so `.nullable()` puts
         *   the null in the TARGET's own type and the reference stays bare. That
         *   is correct and admits null, but you have to resolve the ref to see
         *   it — which misread as a missing `.nullable()` by two readers
         *   independently, one of whom then "fixed" it.
         *
         *   This one says it at the site. Nothing to resolve.
         *
         * `.nullable().optional()` is the wrong tool here whichever form you
         * pick: `.optional()` also drops the property out of `required`, and
         * `briefing` is never absent.
         */
        briefing: z.union([FieldBriefing, z.null()]),
    })
    .openapi('FieldBriefingPayload', {
        description:
            'The three `*Configured` / `*Available` booleans exist so a client can say WHY ' +
            'there is no briefing instead of showing an empty card. `aiConfigured` false means ' +
            'the deployment has no model; `satelliteConfigured` false means no Earth Engine ' +
            'credentials; `satelliteAvailable` false means configured but the imagery call did ' +
            'not return. Those are three different messages to a farmer, and `briefing: null` ' +
            'alone cannot tell them apart.',
    });

export function registerDashboardPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/dashboard/ag',
        operationId: 'getAgDashboard',
        summary: 'The farm dashboard aggregate',
        description:
            'One request for the whole dashboard: recent journal entries, low stock, the ' +
            "caller's open tasks, and achievements.\n\n" +
            '**`enabledModules` is the gating contract.** Always present, always an array, and ' +
            'a disabled module is ABSENT from it — never present-and-empty, never flagged. ' +
            'Several sections are legitimately empty for a tenant with modules off, so "empty ' +
            'because gated" and "empty because there is no data" are not distinguishable from ' +
            'the arrays alone; read the module list to tell them apart.\n\n' +
            '`achievements` is null for a tenant with no ag module enabled. That is an ordinary ' +
            'state, not an error — hide the card.',
        tags: ['Dashboard'],
        params: TenantParams,
        success: { status: 200, description: 'The dashboard aggregate.', schema: AgDashboard },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/dashboard/trends',
        operationId: 'getMetricTrends',
        summary: 'Compliance and asset metrics over time',
        description:
            'One point per day over the requested window.\n\n' +
            '**`daysAvailable` can be smaller than `daysRequested`.** A tenant younger than the ' +
            'window has fewer days of history, and the payload says so rather than padding. ' +
            'Plot what you were given.',
        tags: ['Dashboard'],
        params: TenantParams,
        query: DaysQuery(90),
        success: { status: 200, description: 'The trend series.', schema: TrendPayload },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/dashboard/task-trend',
        operationId: 'getFarmTaskTrend',
        summary: 'Farm tasks created and completed per day',
        description:
            'Created versus completed per day — the shape of whether work is keeping up with ' +
            'itself. Note the envelope: the series is under `trend`, unlike ' +
            '`/dashboard/trends` which returns its series under `dataPoints` alongside range ' +
            'metadata. Two sibling endpoints, two envelopes; this one is documented so nobody ' +
            'has to discover that at runtime.',
        tags: ['Dashboard'],
        params: TenantParams,
        query: DaysQuery(14),
        success: {
            status: 200,
            description: 'The task series.',
            schema: z.object({ trend: z.array(FarmTaskTrendPoint) }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/reports/field-briefing',
        operationId: 'getFieldBriefing',
        summary: "An AI briefing over the farm's fields",
        description:
            'Generated from satellite index means plus the farm\'s own records. Cached, so two ' +
            'calls in a day return the same `generatedAt`.\n\n' +
            '**Read the three booleans before rendering an absence.** `briefing: null` with ' +
            '`aiConfigured: false` is "this deployment has no model"; with ' +
            '`satelliteConfigured: false` it is "no Earth Engine credentials"; with ' +
            '`satelliteAvailable: false` it is "configured, but the imagery call did not ' +
            'return". Those are three different things to tell a farmer, and the null alone ' +
            'says none of them.',
        tags: ['Dashboard'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The briefing, or the reasons there is none.',
            schema: FieldBriefingPayload,
        },
    });
}
