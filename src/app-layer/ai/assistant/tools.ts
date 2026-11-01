/**
 * The assistant's tools — a CLOSED set, each reading through a usecase that
 * enforces its own permission — #2578.
 *
 * ## This is where the permission question actually lives
 *
 * `api-permission-coverage` carries a carve-out for the stream route, and its
 * reason is that a single route-level permission would have to be the UNION of
 * every tool's — too WIDE, granting through one gate what four gates refuse
 * separately. That reason is only honest if the per-tool checks exist, so the
 * carve-out carries a revisit trigger saying this PR must touch it.
 *
 * Each tool's `run` calls a USECASE, never a repository. The usecase asserts
 * its own policy — `listTasks` opens with `assertCanReadTasks(ctx)` — so a
 * READER who may not see tasks gets a refusal from the same code path the
 * HTTP route would have used. `tests/guards/assistant-tools-go-through-usecases.test.ts`
 * holds that: a tool reaching a repository directly would bypass the policy
 * and is what the guard refuses.
 *
 * ## Arguments come from the MODEL, so they are validated like a request body
 *
 * Every tool declares a Zod schema and `.strict()`. A hallucinated argument is
 * a refused tool call, not a query. Two narrower decisions inside that:
 *
 * - **No free-text search parameter.** `TaskFilters.q` exists and is
 *   deliberately not exposed. It is parameterised so there is no injection,
 *   but handing a model a free-text channel into a database query buys
 *   little — "what is overdue" needs `due`, not prose — and it is the one
 *   argument whose content cannot be bounded by a charset. Same reasoning as
 *   the page context excluding the toolbar's search term.
 * - **No encrypted free-text columns in the result.** `Task.description` and
 *   `Task.resolution` are in `ENCRYPTED_FIELDS`; the extension decrypts them
 *   on read, so a projection that names them would hand the model the farm's
 *   longest and most sensitive free text to answer a list-level question. A
 *   later single-task tool can fetch one deliberately.
 */
import { ExchangeKind, ExchangeSide, type ModuleKey, WorkItemStatus } from '@prisma/client';
import { z } from 'zod';

import { listCostEntries } from '@/app-layer/usecases/cost-entry';
import { listActiveListings } from '@/app-layer/usecases/exchange';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';
import { listTasks } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';
import type { AiToolDef } from '@/app-layer/ai/provider/types';
import { linksFromRows, type AssistantLink, type LinkShape } from './links';
import {
    ACTIVITY_KIND_VALUES,
    proposeDraft,
    ProposeActivityArgs,
    ProposeTreatmentArgs,
    TREATMENT_KIND_VALUES,
    type AssistantProposal,
    type ProposalKind,
} from './propose';
import { toPublicListing } from '@/lib/exchange/public-listing';
import { LOG_ENTRY_TYPE_VALUES } from '@/lib/schemas';

/** How much of one tool result may reach the model. */
export const TOOL_RESULT_MAX_CHARS = 4000;

export interface ToolOutcome {
    readonly ok: boolean;
    /** Serialised for the model. Already truncated if it had to be. */
    readonly content: string;
    readonly truncated: boolean;
    /**
     * The links this result supports, built HERE from the rows rather than
     * parsed back out of `content` — which would have to survive truncation
     * and would reintroduce the fabrication risk the server-built design
     * removes.
     */
    readonly links: readonly AssistantLink[];
    /**
     * A prepared draft, when the tool was a PROPOSE tool. Nothing is written —
     * see `propose.ts` and the guard that holds it.
     */
    readonly proposal: AssistantProposal | null;
}

interface AssistantTool {
    readonly def: AiToolDef;
    readonly args: z.ZodType<unknown>;
    readonly run: (ctx: RequestContext, args: unknown) => Promise<unknown>;
    /**
     * How this tool's rows become links the answer can offer.
     *
     * Declared here rather than inferred, and checked against the generated
     * page-template set by `assistant-tools-go-through-usecases` — a tool
     * whose template is not a real screen would produce links that 404 on a
     * phone rather than failing in CI.
     */
    readonly link?: LinkShape;
    /** A PROPOSE tool: its result becomes a draft on the answer. */
    /**
     * The per-tenant MODULE this tool's surface sits behind, asserted by
     * `runTool` before `run` — #2629.
     *
     * Declared here rather than called inside each `run` so it cannot be
     * forgotten in a body, and so a guard can read the mapping off the
     * registry. Absent means the surface gates no module, which is TRUE of
     * `/farm-tasks` — measured, not assumed.
     *
     * It belongs on the TOOL and not pushed down into the usecase: 52 route
     * files already assert it and 2 usecases do, so moving it would make
     * every one of those 52 a second copy of one policy. A tool is a new
     * CONSUMER of a route-level gate, and carries it the way a route does.
     */
    readonly module?: ModuleKey;
    /**
     * The proposal KIND this tool prepares, read by `runTool` — #2632.
     *
     * The kind rather than a boolean, so the kind is declared once on the
     * registry instead of hard-wired into `runTool`. It was `proposes: true`
     * with `proposeJournalEntry` named at the call site, which is why adding a
     * second kind meant editing the loop.
     */
    readonly proposes?: ProposalKind;
}

/**
 * Status values DERIVED from the schema enum, never retyped.
 *
 * I hand-wrote `['OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED']` first and
 * two of those are not members — `DONE` and `CANCELLED` do not exist, while
 * `TRIAGED`, `PENDING_REVIEW` and `RESOLVED` do. `tsc` caught it as a type
 * mismatch against `TaskFilters.status`, but the runtime cost would have been
 * worse than a rejected argument: the JSON-Schema below is what the MODEL is
 * told the valid values are, so it would have been invited to send `DONE` and
 * the tool would have passed it to Prisma.
 *
 * `z.nativeEnum` and `Object.values` mean a schema change reaches both the
 * validator and the model's instructions without anybody editing this file —
 * `a-number-that-does-not-move`, applied to a vocabulary.
 */
const STATUS_VALUES = Object.values(WorkItemStatus);

const ListFarmTasksArgs = z
    .object({
        status: z.array(z.nativeEnum(WorkItemStatus)).max(STATUS_VALUES.length).optional(),
        due: z.enum(['overdue', 'next7d']).optional(),
    })
    .strict();

/**
 * Дневник filters the model may set — and the OMISSIONS are the decision.
 *
 * `LogEntryFilters` also carries `q`, `locationId`, `cropPlanId` and
 * `includeTaskWritten`. None is exposed:
 *
 * - `q` is free text into a query, excluded for the reason the task tool
 *   excludes it and the page context excludes the toolbar's search term;
 * - `locationId` and `cropPlanId` are record references the model would have
 *   to fabricate — the `links.ts` provenance problem, with no derivation to
 *   fall back on;
 * - **`includeTaskWritten` is excluded on an OWNER RULING**, not on taste. Its
 *   own docblock records it: «journal should be entered manually only and
 *   tasks list should appear only in tasks» (2026-10-10). The filter defaults
 *   to manual-only *because that is what the journal now means*, and exactly
 *   one caller opts out — `satellite-briefing`, whose job is to summarise the
 *   farm. A tool setting it would quietly widen the register against a ruling,
 *   and nothing in a prompt would show it. Asserted in the guard, not just
 *   left unwritten.
 */
const ListJournalArgs = z
    .object({
        type: z.array(z.string().min(1).max(64)).max(8).optional(),
        status: z.array(z.enum(['PLANNED', 'DONE'])).max(2).optional(),
        occurredFrom: z.string().max(40).optional(),
        occurredTo: z.string().max(40).optional(),
    })
    .strict();

/**
 * Expense filters the model may set. Same omissions, same reasons: no `q`, and
 * none of the six id arrays (`plantingIds`, `seasonIds`, `locationIds`,
 * `parcelIds`, `leaseIds`, `itemIds`).
 *
 * The dates arrive as STRINGS and the usecase takes `Date`, so they are parsed
 * here and a value that does not parse is refused — rather than handed on as
 * `Invalid Date`, which Prisma reports far from its cause.
 */
const ListCostsArgs = z
    .object({
        categories: z.array(z.string().min(1).max(64)).max(12).optional(),
        incurredFrom: z.string().max(40).optional(),
        incurredTo: z.string().max(40).optional(),
    })
    .strict();

/**
 * Борса facets. Every field mirrors a `ListingFilters` field that is an
 * ENUM or a NUMBER, and the omissions are the design:
 *
 * - `search` / `searchRegionCodes` / `searchCommodities` — free text into a
 *   query, which a browse question does not need and whose content cannot be
 *   bounded by a charset. The last two are additionally RESOLVED BY THE ROUTE
 *   from the oblast and crop catalogues, so a value invented here would not
 *   even be a region or commodity code.
 * - `excludeSellerTenantIds` — usecase-INTERNAL. `listActiveListings`
 *   computes it from `sellerTenantsWithExchangeOff()`, so accepting one from
 *   a caller would let a model UNHIDE sellers who switched the exchange off,
 *   or hide farms that did not. It is a privacy control shaped like a filter.
 *
 * The two enums come from Prisma rather than being written out, for the
 * reason the task tool's status list does: I once hand-wrote five work-item
 * statuses and three were wrong, and a JSON-Schema enum of values the
 * database does not have is a refusal the model cannot diagnose.
 */
const ListExchangeArgs = z.object({
    sides: z.array(z.nativeEnum(ExchangeSide)).max(2).optional(),
    kinds: z.array(z.nativeEnum(ExchangeKind)).max(4).optional(),
    commodities: z.array(z.string().min(1).max(64)).max(12).optional(),
    regionCodes: z.array(z.string().min(1).max(16)).max(28).optional(),
    minTonnes: z.number().nonnegative().max(1_000_000).optional(),
    maxTonnes: z.number().nonnegative().max(1_000_000).optional(),
}).strict();

const parseDay = (v: string | undefined): Date | undefined => {
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${v.slice(0, 20)}`);
    return d;
};

export const ASSISTANT_TOOLS: Readonly<Record<string, AssistantTool>> = {
    list_farm_tasks: {
        def: {
            name: 'list_farm_tasks',
            description:
                "The farm's own task list. Use it to answer what is open, overdue or due soon. "
                + 'Returns at most 20 tasks, newest first, without their long descriptions.',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'array',
                        items: { type: 'string', enum: STATUS_VALUES },
                        description: 'Narrow to these statuses.',
                    },
                    due: {
                        type: 'string',
                        enum: ['overdue', 'next7d'],
                        description: 'Narrow to overdue tasks, or those due within seven days.',
                    },
                },
                additionalProperties: false,
            },
        },
        args: ListFarmTasksArgs,
        link: { template: '/farm-tasks/[taskId]', idField: 'id', labelField: 'title' },
        run: async (ctx, args) => {
            const a = ListFarmTasksArgs.parse(args);
            // The USECASE, which opens with `assertCanReadTasks(ctx)`. A
            // repository call here would read the farm's tasks for a role the
            // policy refuses.
            const rows = await listTasks(ctx, a, { take: 20 });
            // A projection, and the omissions are the decision — see the
            // header on `description`/`resolution`.
            return (rows as Array<Record<string, unknown>>).map((r) => ({
                id: r.id,
                title: r.title,
                status: r.status,
                priority: r.priority,
                dueDate: r.dueDate,
            }));
        },
    },
    list_journal_entries: {
        def: {
            name: 'list_journal_entries',
            description:
                "The farm's ДНЕВНИК — the field journal of work already carried out, which is "
                + 'also the БАБХ compliance register. Manually-entered entries only. Returns at '
                + 'most 20, newest first, without their long notes.',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'array',
                        items: { type: 'string', enum: [...LOG_ENTRY_TYPE_VALUES] },
                        description: 'Narrow to these entry kinds.',
                    },
                    status: { type: 'array', items: { type: 'string', enum: ['PLANNED', 'DONE'] } },
                    occurredFrom: { type: 'string', description: 'ISO date, inclusive.' },
                    occurredTo: { type: 'string', description: 'ISO date, inclusive.' },
                },
                additionalProperties: false,
            },
        },
        module: 'JOURNAL',
        args: ListJournalArgs,
        link: { template: '/journal/[id]', idField: 'id', labelField: 'title' },
        run: async (ctx, args) => {
            const a = ListJournalArgs.parse(args);
            // The PAGINATED form, because `listLogEntries` takes no limit and
            // a tool must be bounded. `includeTaskWritten` is not passed, so
            // the usecase's own manual-only default applies — see the schema's
            // docblock for whose ruling that is.
            const page = await listLogEntriesPaginated(ctx, {
                limit: 20,
                filters: {
                    ...(a.type ? { type: a.type as never } : {}),
                    ...(a.status ? { status: a.status as never } : {}),
                    ...(a.occurredFrom ? { occurredFrom: a.occurredFrom } : {}),
                    ...(a.occurredTo ? { occurredTo: a.occurredTo } : {}),
                },
            });
            const rows = (page as { rows?: unknown[] }).rows ?? [];
            // `notes` omitted: sanitised rich-text HTML, by far the largest
            // field, and a list-level question does not need it. A later
            // single-entry tool can fetch one deliberately — the same line the
            // task tool draws at `description`.
            return (rows as Array<Record<string, unknown>>).map((r) => ({
                id: r.id,
                title: r.title,
                type: r.type,
                status: r.status,
                occurredAt: r.occurredAt,
            }));
        },
    },
    list_cost_entries: {
        def: {
            name: 'list_cost_entries',
            description:
                "The farm's recorded expenses. Use it for what has been spent, and on what. "
                + 'Returns at most 20, newest first.',
            parameters: {
                type: 'object',
                properties: {
                    categories: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Narrow to these cost categories.',
                    },
                    incurredFrom: { type: 'string', description: 'ISO date, inclusive.' },
                    incurredTo: { type: 'string', description: 'ISO date, inclusive.' },
                },
                additionalProperties: false,
            },
        },
        module: 'GRAIN',
        args: ListCostsArgs,
        run: async (ctx, args) => {
            const a = ListCostsArgs.parse(args);
            // `{ rows, totalCount, truncated }`, NOT an array. I treated it as
            // one and the test passed, because my own mock returned an array —
            // a double whose shape was wrong told me nothing about the
            // dependency. `tsc` caught it; jest could not.
            const page = await listCostEntries(
                ctx,
                {
                    ...(a.categories ? { categories: a.categories as never } : {}),
                    ...(a.incurredFrom ? { incurredFrom: parseDay(a.incurredFrom) } : {}),
                    ...(a.incurredTo ? { incurredTo: parseDay(a.incurredTo) } : {}),
                },
                { take: 20 },
            );
            const rows = page.rows;
            // No link shape: `/grain/costs` is a LIST template with no record
            // parameter, so there is nothing for `linksFromRows` to substitute.
            // A link to the list would be an affordance the person already has.
            return (rows as Array<Record<string, unknown>>).map((r) => ({
                id: r.id,
                category: r.category,
                amountCents: r.amountCents ?? r.amount,
                currency: r.currency,
                incurredOn: r.incurredOn ?? r.incurredAt,
                note: typeof r.note === 'string' ? r.note.slice(0, 120) : undefined,
            }));
        },
    },
    list_exchange_listings: {
        def: {
            name: 'list_exchange_listings',
            description:
                'Борса — ACTIVE listings across every farm on the platform, both offers to sell '
                + 'and wanted-to-buy. Use it for what is on the market, at what price, and where. '
                + 'Returns at most 20.',
            parameters: {
                type: 'object',
                properties: {
                    sides: {
                        type: 'array',
                        items: { type: 'string', enum: Object.values(ExchangeSide) },
                        description: 'SELL for offers, BUY for wanted.',
                    },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: Object.values(ExchangeKind) },
                        description: 'What class of good.',
                    },
                    commodities: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Canonical commodity slugs, e.g. "wheat". Stored canonical, so a '
                            + 'Bulgarian crop name will not match — omit this rather than guess.',
                    },
                    regionCodes: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Oblast codes. Omit rather than guess.',
                    },
                    minTonnes: { type: 'number' },
                    maxTonnes: { type: 'number' },
                },
                additionalProperties: false,
            },
        },
        module: 'EXCHANGE',
        args: ListExchangeArgs,
        run: async (ctx, args) => {
            const a = ListExchangeArgs.parse(args);
            // `{ rows, nextCursor }`, NOT an array — the same shape mistake
            // `listCostEntries` cost me, so it is read off `.rows` here.
            //
            // The policy and the ENTITLEMENT both live inside this usecase:
            // `assertCanRead(ctx)` and `assertNotPastDueRestricted(ctx,
            // 'exchange')`. That is why this tool is a plain usecase call,
            // where a prices tool cannot be — `getPriceTrends` takes no
            // RequestContext at all and its gate sits in the three trends
            // ROUTES, so calling it from here would answer a tenant whose
            // trends surface is closed. Tracked on #2626; do not copy this
            // tool's shape onto that one without reading it.
            const page = await listActiveListings(
                ctx,
                {
                    ...(a.sides ? { sides: a.sides } : {}),
                    ...(a.kinds ? { kinds: a.kinds } : {}),
                    ...(a.commodities ? { commodities: a.commodities } : {}),
                    ...(a.regionCodes ? { regionCodes: a.regionCodes } : {}),
                    ...(a.minTonnes != null ? { minTonnes: a.minTonnes } : {}),
                    ...(a.maxTonnes != null ? { maxTonnes: a.maxTonnes } : {}),
                },
                { limit: 20 },
            );
            // Project through `toPublicListing`, never by hand. It is the ONE
            // place that applies the seller's own disclosure choice:
            //
            //     row.publishAsFarm && row.farm ? row.farm.displayName : row.sellerDisplayName
            //
            // `withFarmAttribution` resolves a farm brand for EVERY seller
            // regardless of that flag, so a hand-rolled projection reading
            // `row.farm.displayName` would name a farm that deliberately did
            // not publish — a privacy regression with the data sitting right
            // there in the return value. It also already withholds
            // `sellerContact`, which is a third party's phone or email and
            // which no egress scan would recognise as sensitive.
            //
            // Then NARROWED: `lat`/`lon` are dropped. The public projection
            // carries them because the browse UI draws a map; an answer in
            // prose has no use for coordinates, and they are a third party's
            // precise location. Narrowing a published projection is safe —
            // widening one would not be.
            return page.rows.map((row) => {
                const pub = toPublicListing(row, ctx.tenantId);
                return {
                    id: pub.id,
                    side: pub.side,
                    kind: pub.kind,
                    commodity: pub.commodity,
                    quantityTonnes: pub.quantityTonnes,
                    pricePerTonne: pub.pricePerTonne,
                    priceCurrency: pub.priceCurrency,
                    regionName: pub.regionName,
                    seller: pub.sellerDisplayName,
                    farmHandle: pub.farmHandle,
                    isOwn: pub.isOwn,
                    expiresAt: pub.expiresAt,
                    description:
                        typeof pub.description === 'string'
                            ? pub.description.slice(0, 160)
                            : null,
                };
            });
        },
    },
    propose_treatment: {
        def: {
            name: 'propose_treatment',
            description:
                'PREPARE a ДНЕВНИК treatment record — spraying, fertilising or sowing — for the '
                + 'person to confirm. Writes NOTHING: it returns a draft the app prefills into the '
                + 'real form, which the person submits themselves. Use it when asked to record a '
                + 'treatment. Send only what was said; every field is optional. Do NOT include '
                + 'parcels, products as ids, or a dose unit — the person picks those in the form.',
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: [...TREATMENT_KIND_VALUES],
                        description: 'SPRAY fills химични обработки, FERTILIZE fills торове, SEED is сеитба.',
                    },
                    occurredOn: { type: 'string', description: 'The calendar day, YYYY-MM-DD.' },
                    productName: { type: 'string', description: 'The product as NAMED. Never an id.' },
                    fertilizerName: { type: 'string', description: 'The fertiliser as named.' },
                    doseValue: { type: 'number', description: 'The dose as a number. The person picks the unit.' },
                    targetNote: { type: 'string', description: 'The pest or target treated.' },
                    phenophase: { type: 'string', description: 'BBCH phenophase, if stated.' },
                    pppRegistrationNo: { type: 'string', description: 'Registration number, if stated.' },
                    quarantinePeriodDays: {
                        type: 'integer',
                        description: 'Quarantine in DAYS, 0-365 — a number, not text.',
                    },
                    applicationTechnique: { type: 'string', description: 'The rig used.' },
                    title: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        module: 'JOURNAL',
        args: ProposeTreatmentArgs,
        run: async (_ctx, args) => {
            // No ctx use and no write: this validates and echoes. The policy
            // that matters is the one on the route the PERSON posts to, which
            // is unchanged.
            const outcome = proposeDraft('treatment', args);
            if (!outcome.ok) throw new Error(outcome.message);
            return { prepared: true, kind: outcome.proposal?.kind, draft: outcome.proposal?.draft };
        },
        proposes: 'treatment',
    },
    propose_activity: {
        def: {
            name: 'propose_activity',
            description:
                'PREPARE a farm activity record — pruning, cultivation or harvest — for the person '
                + 'to confirm. Writes NOTHING. Сеитба is NOT an activity: use propose_treatment '
                + 'with kind SEED. Do NOT include parcels; the person picks them in the form.',
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: [...ACTIVITY_KIND_VALUES],
                        description: 'Pruning, cultivation or harvest.',
                    },
                    occurredOn: { type: 'string', description: 'The calendar day, YYYY-MM-DD.' },
                    harvestKg: { type: 'number', description: 'Harvested kilograms, for a HARVEST.' },
                    title: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        module: 'JOURNAL',
        args: ProposeActivityArgs,
        run: async (_ctx, args) => {
            const outcome = proposeDraft('activity', args);
            if (!outcome.ok) throw new Error(outcome.message);
            return { prepared: true, kind: outcome.proposal?.kind, draft: outcome.proposal?.draft };
        },
        proposes: 'activity',
    },
};

/** The definitions handed to the model. */
export function toolDefs(): AiToolDef[] {
    return Object.values(ASSISTANT_TOOLS).map((t) => t.def);
}

/**
 * Execute one tool call.
 *
 * Never throws. A hallucinated tool name, malformed arguments or a refusal
 * from the usecase's own policy all come back as `ok: false` with a short
 * reason the model can act on — because the alternative is a thrown error
 * ending a stream that has already sent a 200, and the model cannot learn
 * from a dead socket.
 */
export async function runTool(
    ctx: RequestContext,
    name: string,
    rawArgs: string,
): Promise<ToolOutcome> {
    const tool = ASSISTANT_TOOLS[name];
    if (!tool) {
        return { ok: false, content: `No such tool: ${name}`, truncated: false, links: [], proposal: null };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArgs === '' ? '{}' : rawArgs);
    } catch {
        return { ok: false, content: 'Arguments were not valid JSON.', truncated: false, links: [], proposal: null };
    }
    const check = tool.args.safeParse(parsed);
    if (!check.success) {
        return {
            ok: false,
            content: `Arguments rejected: ${check.error.issues[0]?.message ?? 'invalid'}`,
            truncated: false,
            links: [],
            proposal: null,
        };
    }
    try {
        // The module gate, BEFORE the usecase — #2629. The gate for every
        // surface these tools read lives in the ROUTE, not the usecase
        // (measured: 52 route files call it, 2 usecases do), so a tool
        // calling the usecase directly read data for a tenant whose module
        // is switched off — or whose PLAN does not include it, since
        // `assertModuleEnabled` checks `planAllowsModule` first and reports
        // `reason: 'plan'` separately for exactly that case.
        //
        // Inside the `try` deliberately: a MODULE_DISABLED refusal must reach
        // the model as a FAILED TOOL, so it can say it cannot see that data,
        // rather than killing a stream that has already sent a 200.
        if (tool.module) await assertModuleEnabled(ctx, tool.module);
        const result = await tool.run(ctx, check.data);
        // A propose tool's validated draft, lifted onto the outcome so the
        // loop can attach it to the answer. Re-validated rather than trusted
        // from `result`: one source of truth for what a draft may contain.
        const proposal = tool.proposes
            ? (proposeDraft(tool.proposes, check.data).proposal ?? null)
            : null;
        // Built from the ROWS, before serialising — so truncation below cannot
        // silently drop the links for records the model was still shown.
        const links = tool.link ? linksFromRows(tool.link, result) : [];
        const full = JSON.stringify(result);
        if (full.length <= TOOL_RESULT_MAX_CHARS) {
            return { ok: true, content: full, truncated: false, links, proposal };
        }
        // Truncated rather than dropped: a partial list is useful and the
        // `truncated` flag is what makes the answer's incompleteness
        // reportable as `ASSISTANT_TRUNCATED_RESULT` instead of silent.
        return {
            ok: true,
            content: full.slice(0, TOOL_RESULT_MAX_CHARS),
            truncated: true,
            links,
            proposal,
        };
    } catch (err) {
        // Includes the usecase's own policy refusal. Reported to the model as
        // a failed tool rather than raised, so it can say it cannot see that
        // data instead of the turn dying.
        return {
            ok: false,
            content: err instanceof Error ? err.message.slice(0, 200) : 'Tool failed.',
            truncated: false,
            links: [],
            proposal: null,
        };
    }
}
