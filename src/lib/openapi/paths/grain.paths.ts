/**
 * Grain — the net-worth calculator.
 *
 * The calculator came first, and it exists because the calculator had no API
 * at all: `/grain/calculator` is a Server Component that calls the usecase and
 * hands a payload straight to a client island. The native client cannot consume
 * that, so the same answer needed an HTTP door.
 *
 * ── Response shapes: all 13 are pinned ──
 *
 * The rule below stands, but it was being applied to operations it was never
 * about. Costs and yield records are each mapped by ONE `toDto` in their
 * usecase, so their shape is already defined in exactly one place — pointing
 * the spec at a schema written against that mapper adds no second spelling of
 * anything. What the rule protects is the CALCULATOR, whose payload has no
 * single definition outside its mapper module.
 *
 * Pinning them found four things prose had been hiding, every one of which a
 * client would have met as a bug:
 *
 *   - `YieldRecord` was registered in the spec and referenced by NOTHING, and
 *     it omitted `netTonnesStd` and `tPerHaBasis`, both of which the mapper
 *     returns. `toDto`'s own comment says the DTO is what stops two t/ha
 *     figures being compared on different bases — and the published contract
 *     did not carry the basis at all. `.passthrough()` meant nothing ever went
 *     red.
 *   - All three creates return **201**; all three were documented as 200. A
 *     client written to the spec reads every successful create as a failure.
 *   - The two sibling deletes return DIFFERENT shapes — `{ id }` for a cost,
 *     `{ id, deleted }` for a yield — and both were described as "Deleted."
 *   - `Contract` omitted `commodityCanonical`, which is the key market
 *     benchmarking joins on: null there is why a contract gets no benchmark.
 *
 * ── The calculator, and why it is no longer `z.unknown()` ──
 *
 * The objection was right and is worth keeping: `CalculatorData` is deep, and
 * hand-writing it as Zod would make a THIRD spelling of one money payload,
 * beside the TypeScript types and the mapper that builds it, free to drift
 * from both, with nothing to make the copies disagree out loud.
 *
 * So the copy was not written. The payload got a single source of truth
 * instead: `CalculatorData`, `CalculatorRow` and their siblings are now
 * `z.infer` of the schemas in `@/lib/dto/grain-calculator.dto`, re-exported
 * from `calculator-payload.ts` under the names they always had. There is no
 * third spelling because there is no longer a second — one edit moves the
 * type, the validator and this document together.
 *
 * The leaf types other modules COMPUTE (`PerAreaFigures`, `BreakEvenFigures`,
 * `FarmNetWorthTotal`, `ExclusionEntry`, `UncertaintyState`) stay owned there
 * and are mirrored, but each mirror carries a compile-time equality assertion
 * against the real type — so a divergence is a TYPE ERROR, which is precisely
 * the "nothing would make the copy disagree out loud" the note asked for.
 * Mutation-proved: dropping a field, widening a nullable, or removing an enum
 * member each fails the build.
 *
 * `GET /grain/contracts` looked like the same case and is not. Its rows are the
 * model plus three COMPUTED decorations from three separate modules, plus a
 * per-currency `totals` rollup — but all four are PURE, EXPORTED functions, so
 * each has a single source of truth that a schema can be checked against by
 * running it. That is what the contract test does, which is why documenting it
 * invents nothing. The calculator is the one that genuinely differs: its
 * payload is assembled by a mapper module with no exported pure pieces to
 * check a schema against.
 *
 * `journal.paths.ts` documented its three-shaped list response as a union once
 * the shapes were known; the position it and this module share is about not
 * INVENTING a schema, never about leaving a known one unstated.
 */
import { z } from '@/lib/openapi/zod';
import {
    CreateCostEntryBatchSchema,
    CreateBinSchema,
    UpdateBinSchema,
    BlendLotsSchema,
    UpdateContractSchema,
    CreateGrainDeliverySchema,
    CreateCostEntrySchema,
    UpdateCostEntrySchema,
    CreateYieldRecordSchema,
    UpdateYieldRecordSchema,
    CreateContractSchema,
} from '@/app-layer/schemas/grain.schemas';
import {
    CostEntryBatchResponseSchema,
    CostEntryDTOSchema,
    CostEntryListSchema,
    CostSummarySchema,
    YieldRecordDTOSchema,
    YieldRecordListSchema,
    ContractDTOSchema,
    ContractListSchema,
    ContractFulfilmentSchema,
    GrainBinDTOSchema,
} from '@/lib/dto/grain.dto';
import { CalculatorDataSchema } from '@/lib/dto/grain-calculator.dto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op, codedErrorResponses } from './helpers';

// ZodObject, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

/**
 * The invoice-scan response (#482).
 *
 * `lines` is `CreateCostEntrySchema` ITSELF, not a copy of its fields. The
 * contract's whole point is that a proposal posts back to `/grain/costs/batch`
 * unchanged, so referencing the real schema makes that structural — if the
 * batch's line shape moves, this moves with it, and a drifted copy cannot
 * quietly promise a shape the batch no longer accepts.
 */
const InvoiceScanResultSchema = z
    .object({
        invoiceFileId: z
            .string()
            .openapi({ description: 'The stored invoice. Pre-filled on every proposed line.' }),
        lines: z.array(CreateCostEntrySchema).openapi({
            description:
                'Proposed lines, in the batch endpoint\'s own body shape. At most 25; attribution fields are null by design.',
        }),
        warnings: z
            .array(
                z.object({
                    code: z.string(),
                    params: z.record(z.string(), z.number()).optional(),
                }),
            )
            .openapi({
                description:
                    'Findings about the INVOICE rather than one line. A code and figures, never a sentence — the client writes the copy in the reader\'s language.',
            }),
    })
    .openapi('CostInvoiceScanResult');

const BinParams = TenantParams.extend({
    binId: z.string().openapi({ param: { name: 'binId', in: 'path' } }),
});
const ContractParams = TenantParams.extend({
    contractId: z.string().openapi({ param: { name: 'contractId', in: 'path' } }),
});

/**
 * The RAW delivery model. `tonnes` is a `Decimal` and therefore a STRING here
 * while the write side takes a number — the same asymmetry as everywhere else
 * a Decimal reaches this API.
 */
const GrainDeliverySchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        contractId: z.string(),
        deliveredAt: z.string().datetime(),
        /** Exact decimal STRING. Never parse as a float. */
        tonnes: z.string(),
        /** The ticket or weighbridge reference, when one was recorded. */
        reference: z.string().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        deletedAt: z.string().datetime().nullable(),
        retentionUntil: z.string().datetime().nullable(),
    })
    .passthrough()
    .openapi('GrainDelivery', {
        description:
            'One delivery against a contract. tonnes is an exact decimal string. Deliveries are what `fulfilment` is derived from, so adding or removing one changes the contract’s position.',
    });

/**
 * The per-CROP response of `GET /grain/costs/defaults?commodity=` (#1611),
 * and as of #1612 one of the two members of that route's 200 union.
 *
 * It used to be registered EXPLICITLY and referenced by nothing, for a
 * contract reason. The honest spec is both shapes as a `z.union` — the route
 * really does return either — but that takes `overheads` off the top level,
 * and `openapi-breaking-change.test.ts` correctly classifies it as
 * `property-removed`: a generated client's `response.overheads` stops
 * type-checking even though no byte an existing caller receives changes.
 * That break was the OWNER's to authorise rather than mine, so #1611 shipped
 * the half needing nobody's permission and #1612 tracked the rest.
 *
 * Authorised 2026-10-11 and recorded in
 * `tests/contracts/acknowledged-breaking-changes.ts` against this PR. The
 * `registry.register` call went with it: the union makes this component
 * reachable, and keeping both would leave two divergent copies of one shape.
 *
 * What was measured before asking, since "breaking" overstates it: the break
 * is codegen-only and there is NO codegen consumer. No `openapi-typescript`
 * in the tree, nothing imports generated API types, and agrent-ios reviewed
 * #1611 and confirmed they hand-write every `Decodable`.
 *
 * `anyOf`, NOT `oneOf`: `z.union` renders as `anyOf`, and the two are
 * equivalent here only because the members are disjoint on their REQUIRED
 * properties. Neither sets `additionalProperties: false`, so if either ever
 * gains an optional key the other requires, `anyOf` stops discriminating and
 * a positional read picks the wrong member silently. Branch on which key is
 * PRESENT, which is what the 200's description tells clients.
 */
const CropCostDefaults = z
    .object({
        commodity: z.string().openapi({
            description:
                'The CANONICAL commodity, echoed so you know what your spelling resolved to. ' +
                'Named `commodity`, NOT `commodityCanonical` \u2014 that is the storage column; this ' +
                'is the resolved value.',
        }),
        lines: z.array(
            z.object({
                category: z.string().openapi({
                    description:
                        'The cost category as entered. Deliberately NOT narrowed to the overhead ' +
                        'enum: a crop sheet books the categories a crop actually incurs.',
                }),
                amountPerDca: z.number().nullable().openapi({
                    description:
                        'The per-decare rate AS TYPED. `null` means the farmer entered a TOTAL, ' +
                        'not that the line is empty \u2014 show the row unfilled rather than dropping ' +
                        'it, or you hide that the farm has such a cost at all.',
                }),
                currency: z.string().openapi({
                    description:
                        'READ THIS; do not assume the form\u2019s. Bulgaria moved to EUR in 2026 and ' +
                        'older rows are BGN, so prefilling the number alone shows a 24 000 \u043b\u0432 figure ' +
                        'as \u20ac24 000 \u2014 wrong by the fixed 1.95583 and entirely plausible on screen.',
                }),
                incurredOn: z.string().datetime().openapi({
                    description:
                        'Show it, so a stale default looks like one. Every line of one sheet ' +
                        'shares this instant \u2014 that is what makes them one sheet.',
                }),
                description: z.string().nullable().openapi({
                    description:
                        'The row\u2019s NAME \u2014 what distinguishes \u041f\u0420\u0417 from \u0442\u043e\u0440\u043e\u0432\u0435 on one sheet. A ' +
                        'departure worth stating: list rows elsewhere omit `description` because ' +
                        'it is encrypted commercial free text. Returned here only because the rows ' +
                        'are the CALLER\u2019S OWN, bounded to one sheet, and without it the sheet comes ' +
                        'back as several unlabelled amounts.',
                }),
            }),
        ),
    })
    .openapi('CropCostDefaults');

/**
 * The no-`commodity` response: the farm's latest overhead figures.
 *
 * Lifted out of the 200 into a named const so the union can reference it
 * (#1612). The shape itself is unchanged.
 */
const CostDefaults = z
    .object({
        overheads: z.array(
            z.object({
                category: z
                    .enum(['PAYROLL', 'CREDIT', 'DEPRECIATION', 'OTHER'])
                    .openapi({ description: 'Which overhead this is the last value for.' }),
                amount: z.number().openapi({ description: 'The yearly figure as entered.' }),
                currency: z.string(),
                incurredOn: z.string().datetime().openapi({
                    description:
                        'When it was incurred. Show it — a default from last season should look like one.',
                }),
                payrollHeadcount: z.number().int().nullable().optional().openapi({
                    description:
                        'PAYROLL only. `null` means a plain total was entered, which is NOT the same as zero people.',
                }),
                payrollAnnualPerPerson: z.number().nullable().optional(),
            }),
        ),
    })
    .openapi('CostDefaults');

/**
 * The eleven validation refusals every cost WRITE can answer (#1712 batch 7).
 *
 * Shared deliberately: `createCostEntry`, `createCostEntryBatch` and
 * `updateCostEntry` all pass through the same two validators —
 * `prepareCostEntry` (domain link, allocation basis, incurred-on date) and
 * `writeCostEntryOn` (tenant references, invoice file) — so documenting them
 * per-operation would be three copies that drift. Traced through the call
 * graph rather than assumed: the batch reaches them via `prepareCostEntry`
 * per line and `writeCostEntryOn` per row.
 */
const COST_WRITE_REFUSALS =
    '\n\nEleven more refusals carry codes, and all of them are 400s.' +
    '\n\n**The link** — `COST_ENTRY_MULTIPLE_DOMAIN_LINKS` (more than one of the domain links set, count in `params.chosen`); ' +
    '`COST_ENTRY_LEASE_REQUIRES_RENT` (`leaseId` on a non-RENT category); ' +
    '`COST_ENTRY_PARCELS_REQUIRE_SUBSET_BASIS` (`allocationParcelIds` on a basis other than `PARCEL_SUBSET`).' +
    '\n\n**The basis** — `COST_ENTRY_BASIS_CONFLICTS_WITH_SPATIAL_LINK` (a basis that spreads across land of its own, also linking a place; the basis is in `params.basis`); ' +
    '`COST_ENTRY_PARCEL_SUBSET_NEEDS_TWO` (a `PARCEL_SUBSET` naming fewer than two distinct parcels — one parcel is a `parcelId` link, not a subset).' +
    '\n\n**The references** — `REFERENCE_NOT_IN_TENANT` covers every one of them, with which reference in `params.reference`: the six single links (`planting`, `season`, `location`, `parcel`, `lease`, `item`) and, as `parcels`, the `PARCEL_SUBSET` set. ' +
    'It is ONE code across the whole API rather than one per surface, so a client handles this refusal once. ' +
    'It answers **400 rather than 404 deliberately**: a 404 would confirm the row exists in SOME tenant, which is what a cross-tenant probe is for. The reference TYPE is returned; the id is not.' +
    '\n\n**The invoice** — `COST_ENTRY_INVOICE_FILE_NOT_FOUND`, `COST_ENTRY_INVOICE_UPLOAD_INCOMPLETE` (the upload never finished) and `COST_ENTRY_INVOICE_FILE_DELETED`.' +
    '\n\n**The date** — `COST_ENTRY_INVALID_DATE`, with the field named in `params.field`.' +
    '\n\n**The currency** — `COST_ENTRY_CURRENCY_NOT_EUR`, with the submitted code in `params.currency`. Costs are recorded in euro: every euro spelling the old free-text field produced is accepted (`EUR`, `EURO`, `EUROS`, `\u20ac`, `E`), and anything else is refused. ' +
    'Lev is refused too, which is the non-obvious part \u2014 the cost calculator CONVERTS lev at the fixed 1.95583 peg when totalling, so a lev row reads correctly on the calculator while being unsavable here. Those are deliberately different questions: \u201ccan this be totalled in euro\u201d and \u201cmay this be stored\u201d.';

/**
 * The validation refusals both contract WRITES answer (#1712 batch 7).
 *
 * Shared because `createContract` and `updateContract` run the same checks on
 * the same fields. Traced, not assumed: both call `parseDate` for the delivery
 * window and both validate counterparty, volume, price, window order and the
 * season reference.
 *
 * The STATUS-transition refusals are NOT here. They are reachable only from
 * `updateContract`, because a create has no previous status to move from, so
 * putting them in the shared block would tell a POST caller about three
 * refusals it cannot receive.
 */
/**
 * The one cost refusal reachable ONLY from `PATCH` (#2398).
 *
 * Separate from `COST_WRITE_REFUSALS` for the same reason the contract
 * status-machine refusals below are: it comes from `assertCurrencyPatch`, which
 * needs a STORED row to compare against, so a POST caller has no previous
 * currency to be refused for, and documenting it on create would describe a 400
 * that operation cannot answer.
 */
const COST_PATCH_ONLY_REFUSALS =
    '\n\n**Changing a legacy row\u2019s currency is refused** \u2014 `COST_ENTRY_LEGACY_CURRENCY_LOCKED`, with the stored code in `params.stored`. ' +
    'A row recorded before costs became euro-only keeps its own currency: it is neither converted nor relabelled. Refusing a change TO euro is the point rather than an oversight \u2014 rewriting `BGN` to `EUR` without touching `amount` would overstate the cost by the 1.95583 peg, silently. Delete and re-enter the row in euro instead. ' +
    'Omitting `currency` is the no-op, and is what the form does, so editing such a row\u2019s description or supplier needs no special handling. Restating the row\u2019s OWN code verbatim is also accepted, because an unchanged value is not a change.';

const CONTRACT_WRITE_REFUSALS =
    '\n\nValidation refusals, all 400s: `CONTRACT_COUNTERPARTY_REQUIRED`; ' +
    '`CONTRACT_VOLUME_NEGATIVE` and `CONTRACT_PRICE_NEGATIVE` (both must be zero or positive); ' +
    '`CONTRACT_DELIVERY_WINDOW_INVERTED` (end before start); ' +
    '`CONTRACT_INVALID_DATE`, with the field named in `params.field`; and ' +
    'and `REFERENCE_NOT_IN_TENANT` with `params.reference: season` — one code shared across the API, a 400 rather than a 404 deliberately because a 404 would confirm the season exists in SOME tenant.';

/**
 * The status-machine refusals, `PATCH` only.
 *
 * Three codes rather than one, because the variants have different remedies.
 * `CONTRACT_ILLEGAL_STATUS_TRANSITION` is the only one a client can act on,
 * and it is the one that carries `params.allowed`.
 */
const CONTRACT_STATUS_REFUSALS =
    '\n\nStatus-change refusals, all 400s. `CONTRACT_ILLEGAL_STATUS_TRANSITION` — a legal status from an illegal place, with `params.from`, `params.to` and `params.allowed` so a client can say what WOULD work. ' +
    '`CONTRACT_TARGET_STATUS_UNKNOWN` — an unrecognised target, in `params.to`. ' +
    '`CONTRACT_STORED_STATUS_UNKNOWN` — the STORED status is not in the transition table, in `params.from`; the one variant a client cannot act on, since nothing it sends can succeed. ' +
    '`CONTRACT_DELIVERED_NEEDS_DELIVERIES` — DELIVERED must mean grain moved, so it requires at least one recorded delivery against the contract.' +
    '\n\nRe-sending the UNCHANGED status is legal and writes nothing, because the whole form is submitted on every edit.';

/**
 * The yield-record write refusals (#1712 batch 9).
 *
 * Both writes run the same checks, so this is shared for the reason the cost
 * block is: two copies drift. Traced, not assumed — the create and update
 * paths each validate tonnes, area and the same three references.
 */
const YIELD_WRITE_REFUSALS =
    '\n\nValidation refusals, all 400s: `YIELD_RECORD_TONNES_NEGATIVE` and `YIELD_RECORD_AREA_NEGATIVE` (both must be zero or positive); ' +
    '`YIELD_RECORD_INVALID_DATE`, with the field named in `params.field`; and ' +
    '`REFERENCE_NOT_IN_TENANT` for a `planting`, `location` or `season` that is not in this farm, named in `params.reference` — the same code the cost and contract writes answer, so a client handles it once.';

export function registerGrainPaths(registry: OpenAPIRegistry): void {

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/calculator',
        operationId: 'getGrainCalculator',
        summary: 'Grain net-worth calculator',
        description:
            'The whole calculator payload, identical to what the web page renders — both call ' +
            '`buildCalculatorPayload` in `@/lib/grain/calculator-payload`, which is the contract. ' +
            'Top level: `generatedAt`, `seasonId`, `rows`, `farm`, `exclusions`, `unvalued`, ' +
            '`cashOut`, `unallocatedToCrop`, `imputedLandCharge`, `truncated`. ' +
            'Every field is a number, string, boolean or array thereof — no Decimal, no Date. ' +
            '`unallocatedToCrop` and `imputedLandCharge` sit BESIDE the cost side and must never ' +
            'be folded into a cost line: a spread is conserved across `rows + unallocatedToCrop`, ' +
            'so summing only the rows reports a cost that shrank. ' +
            'Carries a weak ETag and honours `If-None-Match` with a 304. ' +
            'Requires the GRAIN module; a tenant without it gets 403 `module_disabled: GRAIN`.',
        tags: ['Grain'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The calculator payload (see description for the top-level shape).',
            schema: CalculatorDataSchema,
        },
    });

    // ── The WRITE surface ──
    //
    // The calculator is a read. Everything it computes over is entered
    // through the routes below, and until now none of them was documented:
    // the spec carried 1 grain path against 13 real routes, so a client
    // building an input screen had to read `src/` and guess. That is not
    // hypothetical — the iOS journal list shipped decoding `items` because
    // the use case returns `{ items, pageInfo }` while the ROUTE reshapes it
    // to `{ rows, nextCursor }`, and the wire is what a client sees.
    //
    // Request bodies are the REAL Zod schemas the routes validate with, so
    // they cannot drift from the handler. Response bodies are now the DTO
    // schemas written against each usecase's single `toDto` — see the header
    // for what that surfaced. Nothing in this module is prose-only now.
    //
    // Every route requires the GRAIN module — 403 `module_disabled: GRAIN`.

    const CostEntryParams = z.object({
        tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
        costEntryId: z.string().openapi({ param: { name: 'costEntryId', in: 'path' } }),
    });
    const YieldRecordParams = z.object({
        tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
        yieldRecordId: z.string().openapi({ param: { name: 'yieldRecordId', in: 'path' } }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs',
        operationId: 'listCostEntries',
        summary: 'List cost entries',
        description:
            'Costs attributed to crops, which the calculator sums into `cashCostTotal` and ' +
            'the per-crop `attributedCropCost`. Filterable by `category` as a COMMA-SEPARATED ' +
            'list (`?category=SEED,FUEL`) — a multi-select facet arrives as ONE parameter, and ' +
            'a handler reading it with a bare `get()` and passing the string to Prisma as an ' +
            'enum throws a 500 that a list page renders as its EMPTY state. Carries a weak ETag.',
        tags: ['Grain'],
        params: TenantParams,
        success: { status: 200, description: 'A capped page of cost entries.', schema: CostEntryListSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs/summary',
        operationId: 'getCostSummary',
        summary: 'Exact cost aggregates for the expenses graphs',
        description:
            'Per-type, per-month and per-type-per-month totals over EVERY matching cost \u2014 no cap. ' +
            'It exists because both clients were computing these from `GET /grain/costs`, which IS ' +
            'capped: above the cap the number is wrong and un-disclosably so, since a farmer cannot ' +
            'tell whether their largest category is genuinely largest or merely recent.\n\n' +
            'Takes the SAME facets as the list next door so one filter state serves both: ' +
            '`?category=` comma-joined (`?category=SEED,FUEL`), and the window as ONE token ' +
            '`?incurredOn=2026-09-01|2026-10-31` with either side optional. Deliberately not ' +
            '`?from=&to=` \u2014 two conventions would mean two parsers and a chart that could ' +
            'disagree with the list beneath it about which window it describes.\n\n' +
            'All three groupings arrive in ONE response because the third is what an unfolded type ' +
            'row needs, and a second request would put a round trip behind a disclosure triangle. ' +
            'Soft-deleted costs are excluded. Carries a weak ETag.',
        tags: ['Grain'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Exact aggregates, grouped by currency.',
            schema: CostSummarySchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs',
        operationId: 'createCostEntry',
        summary: 'Record a cost',
        description:
            'Creates one cost entry. `allocationBasis` decides how it reaches a crop — read ' +
            "the enum's own docs before choosing, because the basis is what makes a cost " +
            'attributable rather than stranded in `unallocatedToCrop` on the calculator.' +
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and reused on every retry of the same logical write. The server maps it to `clientMutationId` and a replay returns the ORIGINAL row rather than booking the figure twice. These are FINANCIAL records: an undeduped retry moves net worth with nothing erroring.' +
            '\n\n**The salary breakdown is both-or-neither, and `PAYROLL` only.** `payrollHeadcount` and `payrollAnnualPerPerson` record how a salary figure was arrived at — «брой хора × годишна заплата» — so the form can show the breakdown and a defaults read can recall it. `amount` stays authoritative and is deliberately NOT cross-checked against the product: a farm whose third hire started in May will enter a total below `headcount × perPerson`, and refusing that would block a true figure to protect an identity nobody asked for. Sending one without the other is `PAYROLL_BREAKDOWN_INCOMPLETE`, with the absent field named in `params.missing`; sending either on a non-PAYROLL category is `PAYROLL_BREAKDOWN_NOT_APPLICABLE`.' +
            '\n\n**`allocationBasis: CROP` scopes the whole cost to ONE crop** (#1530) and is the farmer\u2019s own per-crop figure rather than a spread across land. It requires `commodityCanonical` \u2014 any spelling the crop vocabulary resolves, stored canonical, so `Canola` is persisted as `rapeseed`. A commodity the vocabulary does not cover is REFUSED rather than stored as null: such a row has no commodity to sum onto and would be accepted, listed, and absent from every figure. ' +
            '\n\nThree refusals carry codes. `CROP_COST_NEEDS_COMMODITY` \u2014 basis `CROP` with no crop named. `COMMODITY_NOT_APPLICABLE` \u2014 a crop named on any other basis, with the basis in `params.basis`; refused rather than ignored because a crop left on a row whose basis later returns to `CROP` would start carrying the cost with nobody having chosen it. `CROP_COST_HAS_SPATIAL_LINK` \u2014 a `CROP` entry also linking a planting, parcel or location, with the offending fields in `params.links`; such an entry answers \u201cwhich crop\u201d, not \u201cwhich land\u201d, so a place link would store an instruction the allocator ignores. ' +
            '\n\nA `CROP` cost **supersedes** the consumption-derived cost for its (commodity, season) rather than adding to it \u2014 the farmer\u2019s figure wins, and the season is the one containing `incurredOn`, else its calendar year. So it is a fourth slice of `cashCostTotal` on the calculator, never a second count of the same crop-year.' +
            COST_WRITE_REFUSALS,
        tags: ['Grain'],
        params: TenantParams,
        body: CreateCostEntrySchema,
        success: { status: 201, description: 'The created cost entry.', schema: CostEntryDTOSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs/batch',
        operationId: 'createCostEntryBatch',
        summary: 'Record a whole cost sheet, all-or-nothing',
        description:
            'Creates up to 25 cost entries in ONE transaction. Either every line is booked or none is \u2014 a half-saved sheet is worse than one that failed, because the farmer cannot tell which lines landed. Each line is exactly the `POST /grain/costs` body, so every rule documented there applies per line, including the `CROP` basis refusals and the salary breakdown.' +
            '\n\n**`lines` must contain at least one entry.** An empty batch is refused rather than absorbed as a no-op: a 201 for a write that did nothing is what makes an offline outbox believe it has synced and drop the sheet.' +
            '\n\n**A line that violates any rule refuses the WHOLE sheet, before anything is written.** Every line is validated up front, so the batch cannot book six rows and then discover line 7 carries a contradictory allocation basis.' +
            '\n\n**Honours `Idempotency-Key`, and it is the SHEET\u2019s key.** Send one minted before the first attempt and reused on every retry of the same sheet. Note the server derives a per-line key from it internally \u2014 `CostEntry` carries a unique index on `(tenantId, clientMutationId)`, so the lines cannot literally share your key \u2014 and a replay returns the ORIGINAL rows, in the order you sent them, rather than booking the sheet twice. Do not construct or depend on the derived form; it is an implementation detail and is deliberately not read back by prefix.' +
            '\n\nThe 25-line bound is not politeness: the sheet is one interactive transaction, and an unbounded batch is a transaction whose size the client chooses.' +
            COST_WRITE_REFUSALS,
        tags: ['Grain'],
        params: TenantParams,
        body: CreateCostEntryBatchSchema,
        success: {
            status: 201,
            description:
                'Every created entry, in the order the lines were sent. On a replay, the originally created rows.',
            schema: CostEntryBatchResponseSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'getCostEntry',
        summary: 'Get one cost entry',
        description: 'Refusal code: `COST_ENTRY_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: CostEntryParams,
        success: {
            status: 200,
            description:
                'The cost entry. This is the only read that carries `description` — it is ' +
                'ABSENT on list rows, which is a different claim from null.',
            schema: CostEntryDTOSchema,
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'updateCostEntry',
        summary: 'Update a cost entry',
        description: 'Refusal code: `COST_ENTRY_NOT_FOUND` (404).' +
            COST_WRITE_REFUSALS +
            COST_PATCH_ONLY_REFUSALS,
        tags: ['Grain'],
        params: CostEntryParams,
        body: UpdateCostEntrySchema,
        success: { status: 200, description: 'The updated cost entry.', schema: CostEntryDTOSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'deleteCostEntry',
        summary: 'Delete a cost entry',
        description: 'Refusal code: `COST_ENTRY_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: CostEntryParams,
        success: {
            status: 200,
            description:
                'Soft-deleted. The body is `{ id }` ONLY — the sibling ' +
                '`DELETE /grain/yield-records/{id}` answers `{ id, deleted }` instead. ' +
                'They are genuinely different shapes, so one decoder cannot serve both.',
            schema: z.object({ id: z.string() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/yield-records',
        operationId: 'listYieldRecords',
        summary: 'List yield records',
        description:
            'Harvested yield per planting. `netTonnesStd` is deliberately NULL when ' +
            '`moisturePct` is unmeasured — that is "not known", never "zero", and a consumer ' +
            'that folds it into a sum as 0 understates the harvest while still looking like a ' +
            'real number.',
        tags: ['Grain'],
        params: TenantParams,
        success: { status: 200, description: 'A capped page of yield records.', schema: YieldRecordListSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/yield-records',
        operationId: 'createYieldRecord',
        summary: 'Record a yield',
        description:
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and reused on every retry of the same logical write. The server maps it to `clientMutationId` and a replay returns the ORIGINAL row rather than booking the figure twice. These are FINANCIAL records: an undeduped retry moves net worth with nothing erroring.' +
            YIELD_WRITE_REFUSALS,
        tags: ['Grain'],
        params: TenantParams,
        body: CreateYieldRecordSchema,
        success: { status: 201, description: 'The created yield record.', schema: YieldRecordDTOSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'getYieldRecord',
        summary: 'Get one yield record',
        description: 'Refusal code: `YIELD_RECORD_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: YieldRecordParams,
        success: {
            status: 200,
            description:
                'The yield record. This is the only read that carries `valuationNotes` — the ' +
                'list projection omits it, so its absence there means it was not sent, not ' +
                'that the record has none.',
            schema: YieldRecordDTOSchema,
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'updateYieldRecord',
        summary: 'Update a yield record',
        description: 'Refusal code: `YIELD_RECORD_NOT_FOUND` (404).' +
            YIELD_WRITE_REFUSALS,
        tags: ['Grain'],
        params: YieldRecordParams,
        body: UpdateYieldRecordSchema,
        success: { status: 200, description: 'The updated yield record.', schema: YieldRecordDTOSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/contracts',
        operationId: 'createGrainContract',
        summary: 'Create a grain contract',
        description:
            'A forward sale. The calculator prices a contracted tonnage against the contract ' +
            'rather than the market reference, so this is an INPUT to net worth, not a record ' +
            'kept beside it.' +
            CONTRACT_WRITE_REFUSALS,
        tags: ['Grain'],
        params: TenantParams,
        body: CreateContractSchema,
        success: { status: 201, description: 'The created contract.', schema: ContractDTOSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'deleteYieldRecord',
        summary: 'Delete a yield record',
        description: 'Refusal code: `YIELD_RECORD_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: YieldRecordParams,
        success: {
            status: 200,
            description:
                'Soft-deleted. `{ id, deleted }` — NOT the `{ id }` its cost-entry sibling ' +
                'returns. `deleted` is always true; it is in the payload because it shipped ' +
                'that way, not because false is reachable.',
            schema: z.object({ id: z.string(), deleted: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/contracts',
        operationId: 'listGrainContracts',
        summary: 'List grain contracts',
        description:
            'Filterable by `status` as a COMMA-SEPARATED list. Same parsing rule as `category` ' +
            'on costs, and the same failure if it is read with a bare `get()`.',
        tags: ['Grain'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'A capped page of contracts. Each row is the model plus computed ' +
                '`fulfilment`, `valueAmount` and `benchmark`; `totals` rolls the PAGE up ' +
                'per currency and is not the whole book when `truncated` is true. Every ' +
                'money and tonnage figure is an exact decimal STRING — parsing them as ' +
                'floats undoes the reason they are strings.',
            schema: ContractListSchema,
        },
    });

    // ── Bins, blend, deliveries and the invoice attachment ──
    //
    // The rest of the GRAIN surface. Two things here are worth reading before
    // writing a client, and neither is guessable:
    //
    //   `GET /grain/bins/{binId}` is NOT the list row. It carries the bin's
    //   LOTS and a `lotsTruncated` flag; the list carries neither.
    //
    //   Detaching an invoice does NOT delete the file. The FileRecord survives
    //   the detach on purpose — a document that was once attached to a
    //   financial record is evidence, and unlinking it is not a reason to
    //   destroy it.

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/bins',
        operationId: 'listGrainBins',
        summary: 'List grain bins and stores',
        description:
            'Bins with their computed fill. Carries a weak ETag; send `If-None-Match` and handle **304**. ' +
            '\n\nARCHIVED bins ARE listed. That is deliberate: this page cannot change a Location’s status, so hiding them would make a bin vanish with no way back. Org capacity metrics exclude them; this list does not.',
        tags: ['Grain'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The bins.',
            schema: z.array(GrainBinDTOSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/bins',
        operationId: 'createGrainBin',
        summary: 'Create a bin or store',
        description:
            'Answers with the id, name, kind and capacity ONLY — not the computed fill, which requires reading the stock.',
        tags: ['Grain'],
        params: TenantParams,
        body: CreateBinSchema,
        success: {
            status: 201,
            description: 'The created bin.',
            schema: z
                .object({
                    id: z.string(),
                    name: z.string(),
                    kind: z.enum(['BIN', 'STORAGE']),
                    capacityTonnes: z.number().nullable(),
                })
                .openapi('GrainBinWriteAck', {
                    description:
                        'What create and update answer with. NOT the fill-computed bin — storedTonnes, fillPct and the rest require a read of the stock, so fetch the bin if you need them.',
                }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/bins/{binId}',
        operationId: 'getGrainBin',
        summary: 'Get one bin with its lots',
        description:
            'The list row PLUS `lots` and `lotsTruncated`. The lots are capped, and `lotsTruncated: true` says rows were dropped — unlike most of this API, this one tells you.' +
            '\n\nRefusal code: `GRAIN_BIN_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: BinParams,
        success: {
            status: 200,
            description: 'The bin and its stored lots.',
            schema: GrainBinDTOSchema.extend({
                lots: z.array(
                    z.object({
                        id: z.string(),
                        lotCode: z.string(),
                        itemName: z.string(),
                        quantity: z.number(),
                        unitSymbol: z.string(),
                        expiresAt: z.string().datetime().nullable(),
                        /** Quality attributes carried on the lot, when any. */
                        attributes: z.record(z.string(), z.unknown()).nullable(),
                    }),
                ),
                /** TRUE when the lot list was capped and rows were dropped. */
                lotsTruncated: z.boolean(),
            }).openapi('GrainBinDetail', {
                description:
                    'A bin with its stored lots. lotsTruncated is a real truncation marker — a rarity in this API — so a lot count taken from `lots.length` is wrong when it is true; use `lotCount`.',
            }),
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/bins/{binId}',
        operationId: 'updateGrainBin',
        summary: 'Update a bin',
        description: 'Refusal code: `GRAIN_BIN_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: BinParams,
        body: UpdateBinSchema,
        success: {
            status: 200,
            description: 'The updated bin’s id, name, kind and capacity.',
            schema: z.object({
                id: z.string(),
                name: z.string(),
                kind: z.enum(['BIN', 'STORAGE']),
                capacityTonnes: z.number().nullable(),
            }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/bins/{binId}',
        operationId: 'deleteGrainBin',
        summary: 'Delete a bin',
        description: 'Refusal code: `GRAIN_BIN_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: BinParams,
        success: {
            status: 200,
            description: 'Deleted.',
            schema: z.object({ id: z.string(), deleted: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/blend',
        operationId: 'blendGrainLots',
        summary: 'Blend source lots into one output lot',
        description:
            'Merges several lots into a new one, recording a MERGE edge per source pair so the blend stays traceable in both directions — `/inventory/lots/{id}/trace` walks those edges. ' +
            '\n\nA lot may NOT appear twice in one blend (the edge is per-pair), every quantity must be positive, and at least one source is required. Each is a 400 with its own message. ' +
            '\n\n`attributes` is the blended quality result — a weighted combination of the sources, or the overrides supplied.',
        tags: ['Grain'],
        params: TenantParams,
        body: BlendLotsSchema,
        success: {
            status: 201,
            description: 'The output lot and what went into it.',
            schema: z
                .object({
                    outputLotId: z.string(),
                    outputLotCode: z.string(),
                    blendedQuantity: z.number(),
                    sourceCount: z.number(),
                    /** MERGE edges written — one per source lot. */
                    mergeLinks: z.number(),
                    attributes: z.record(z.string(), z.number()),
                })
                .openapi('BlendLotsResult', {
                    description:
                        'The blend’s outcome. mergeLinks is how many genealogy edges were written, which is what makes the result traceable back to its sources.',
                }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}',
        operationId: 'getGrainContract',
        summary: 'Get one contract',
        description:
            'The RAW model plus its season — NOT the list row, which additionally carries computed fulfilment, value and benchmark.' +
            '\n\nRefusal code: `CONTRACT_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: ContractParams,
        success: { status: 200, description: 'The contract.', schema: ContractDTOSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}',
        operationId: 'updateGrainContract',
        summary: 'Update a contract',
        description:
            'Partial update. The whole form is submitted on every edit, so re-sending the ' +
            'current status is a legal no-op that writes nothing.' +
            '\n\nRefusal code: `CONTRACT_NOT_FOUND` (404).' +
            CONTRACT_WRITE_REFUSALS +
            CONTRACT_STATUS_REFUSALS,
        tags: ['Grain'],
        params: ContractParams,
        body: UpdateContractSchema,
        success: { status: 200, description: 'The updated contract.', schema: ContractDTOSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}',
        operationId: 'deleteGrainContract',
        summary: 'Delete a contract',
        description: 'Refusal code: `CONTRACT_NOT_FOUND` (404).',
        tags: ['Grain'],
        params: ContractParams,
        success: {
            status: 200,
            description: 'Deleted.',
            schema: z.object({ id: z.string(), deleted: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}/deliveries',
        operationId: 'listContractDeliveries',
        summary: 'Deliveries against a contract',
        description:
            'The delivery ledger for one contract, WITH the computed fulfilment position beside it — so a client does not have to re-derive "how much is left" from the rows and risk a different answer than the contract list shows.',
        tags: ['Grain'],
        params: ContractParams,
        success: {
            status: 200,
            description: 'The deliveries and the resulting fulfilment.',
            schema: z.object({
                rows: z.array(GrainDeliverySchema),
                fulfilment: ContractFulfilmentSchema,
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}/deliveries',
        operationId: 'createGrainDelivery',
        summary: 'Record a delivery',
        description:
            'Appends to the contract’s delivery ledger. Over-delivery is ACCEPTED — the tickets say what they say — and shows up as a complete fulfilment with a `remainingTonnes` floored at zero rather than a negative.',
        tags: ['Grain'],
        params: ContractParams,
        body: CreateGrainDeliverySchema,
        success: { status: 201, description: 'The created delivery.', schema: GrainDeliverySchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/deliveries/{deliveryId}',
        operationId: 'deleteGrainDelivery',
        summary: 'Delete a delivery',
        description:
            'Removing a delivery changes the contract’s fulfilment. Re-read the contract or its deliveries afterwards rather than adjusting a cached figure.' +
            '\n\nRefusal code: `DELIVERY_NOT_FOUND` (404) — the delivery does not exist, or belongs to another farm. The two are one answer on purpose.',
        tags: ['Grain'],
        params: TenantParams.extend({
            deliveryId: z.string().openapi({ param: { name: 'deliveryId', in: 'path' } }),
        }),
        success: {
            status: 200,
            description: 'Deleted.',
            schema: z.object({ id: z.string(), deleted: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}/invoice',
        operationId: 'attachCostEntryInvoice',
        summary: 'Attach an invoice to a cost entry',
        description:
            'MULTIPART. Uploads the file, mints the FileRecord through the shared storage pipeline, and points the entry at it. There is no generic upload endpoint in this repo — every multipart route mints its own FileRecord as part of an entity write. ' +
            '\n\nTo attach an ALREADY-stored file by id, PATCH the cost entry instead; it runs the same tenant + STORED + not-deleted gate.',
        tags: ['Grain'],
        params: CostEntryParams,
        bodyContentType: 'multipart/form-data',
        body: z
            .object({ file: z.string().openapi({ format: 'binary' }) })
            .openapi('CostEntryInvoiceUpload'),
        success: {
            status: 201,
            description: 'The cost entry, now carrying its invoice.',
            schema: CostEntryDTOSchema,
        },
    });

    /**
     * «Сканирай фактура» (#482). PROPOSES lines; writes no cost entry.
     *
     * The response's `lines` are `CreateCostEntry`'s shape VERBATIM, so a
     * client posts them back to `/grain/costs/batch` unchanged. That is the
     * contract's load-bearing property: a proposal that needed reshaping
     * before saving would put the model's guess into the client's error.
     */
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs/invoice-scan',
        operationId: 'scanCostInvoice',
        summary: 'Read an invoice and propose cost lines',
        description:
            'Reads an invoice photo or PDF with a vision model and answers with proposed cost-sheet lines. ' +
            '\n\n**It creates nothing.** The farmer checks the proposal and saves it with `POST /grain/costs/batch`; ' +
            'a misread amount must never reach the calculator unseen.' +
            '\n\nSend EXACTLY ONE of `file` (the bytes), `fileId` (a FileRecord already stored) or `documentId` ' +
            '(a «Документи» row — the server resolves it to that document\'s FileRecord, because `fileRecordId` is ' +
            'not on the document DTO). More than one, or none, is `INVOICE_SCAN_INPUT_AMBIGUOUS`. A `documentId` ' +
            'naming a purged tombstone answers `DOCUMENT_PURGED`, and an unknown one `DOCUMENT_NOT_FOUND`.' +
            '\n\nAmounts come back in **EUR** whatever the invoice says: лев is converted at the fixed peg ' +
            '(1 EUR = 1.95583 BGN) and the original figure is prefixed to `description`, because the cost schema has ' +
            'no column for an original amount and the save path refuses a non-EUR currency. A genuinely foreign ' +
            'currency is refused per line rather than relabelled.' +
            '\n\nEvery attribution field (`plantingId`, `seasonId`, `locationId`, `parcelId`, `leaseId`, `itemId`) and ' +
            '`commodityCanonical` come back NULL by design — the model cannot know which planting a drum of diesel ' +
            'belongs to, and a guess would put a wrong attribution into the calculator.' +
            '\n\n`warnings` carry a CODE and figures, never a sentence: the client writes the copy in the reader\'s ' +
            'language. `INVOICE_LINES_TRUNCATED` (the invoice has more than the batch\'s 25-line bound — reported, ' +
            'never silently dropped), `INVOICE_LINES_UNREADABLE`, `INVOICE_LINE_FOREIGN_CURRENCY` and ' +
            '`INVOICE_LINE_AMOUNT_UNREADABLE`.' +
            '\n\nGated on the tenant AI budget and, for the `file` path, on the `upload` past-due capability; the ' +
            'bytes are AV-scanned before a single token is spent.',
        tags: ['Grain'],
        params: TenantParams,
        bodyContentType: 'multipart/form-data',
        body: z
            .object({
                file: z.string().openapi({ format: 'binary' }).optional(),
                fileId: z.string().optional(),
                documentId: z.string().optional(),
            })
            .openapi('CostInvoiceScanRequest'),
        success: {
            status: 200,
            description: 'Proposed cost lines, plus the stored invoice file id.',
            schema: InvoiceScanResultSchema,
        },
        extraResponses: codedErrorResponses({
            413: 'INVOICE_SCAN_TOO_LARGE — the document is larger than the reader will accept.',
            415: 'INVOICE_SCAN_MEDIA_UNSUPPORTED — the RESOLVED type is neither a supported image nor a PDF. The shared upload allowlist is wider than what the model can read, so this is checked on what the bytes ARE, not what the client claimed.',
            422: 'INVOICE_NOT_RECOGNISED — the document could not be read as an invoice, which is an ORDINARY outcome (a photo of a delivery note, or into the sun) and deliberately not a 500: the remedy is "take it again in better light", which a 500 cannot say. `INVOICE_NO_USABLE_LINES` is the separate case where the invoice WAS read but no line can be recorded as a cost. Both carry `invoiceFileId` so a retry needs no re-upload.',
            503: 'INVOICE_SCAN_UNAVAILABLE — no vision model is configured on this installation. A statement about the deployment, not about the farmer\'s document.',
        }),
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}/invoice',
        operationId: 'detachCostEntryInvoice',
        summary: 'Detach the invoice from a cost entry',
        description:
            'Unlinks the invoice. **The FileRecord SURVIVES** — a document once attached to a financial record is evidence, and unlinking it is not a reason to destroy it. So this is reversible by re-attaching the same file id via PATCH.',
        tags: ['Grain'],
        params: CostEntryParams,
        success: {
            status: 200,
            description: 'The cost entry, without its invoice.',
            schema: CostEntryDTOSchema,
        },
    });

    const MachineryDepreciationCharge = z.object({
        assetId: z.string(),
        assetKey: z.string().nullable().optional(),
        assetName: z.string(),
        purchaseCost: z.number(),
        purchaseDate: z.string().datetime().nullable().optional(),
        usefulLifeYears: z.number(),
        annualCharge: z.number().openapi({
            description: 'Straight-line: `purchaseCost ÷ usefulLifeYears`.',
        }),
        yearsElapsed: z.number().nullable().optional().openapi({
            description:
                'Whole years since purchase, capped at the useful life. **`null` when `purchaseDate` is unset** — what a year costs is knowable without knowing when it started; how much life remains is not.',
        }),
        remainingValue: z.number().nullable().optional().openapi({
            description: 'Remaining book value. `null` whenever `yearsElapsed` is.',
        }),
        fullyDepreciated: z.boolean(),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/costs/machinery',
        operationId: 'getMachineryDepreciation',
        summary: 'Straight-line depreciation of the machine register',
        description:
            'Annual depreciation per machine, plus the farm total. `totalAnnualCharge` is the yearly figure to prefill an «Амортизация» cost line with.' +
            '\n\n**Reported ALONGSIDE the crop rollup, never folded into it.** A tractor is not consumed by one planting, so adding it to `/grain/costs` would move every existing figure there.' +
            '\n\n**`method: "NONE"` is not zero cost.** A tenant that has not opted in gets `NONE` with an empty `charges` array — "not computed" and "costs nothing" must not render identically, so branch on `method` before showing a total.' +
            '\n\n**`unallocated` is the honesty field and is worth rendering.** Those are machines carrying a `purchaseCost` that produced NO charge, each with a `reason` (today only `NO_USEFUL_LIFE`). `unallocatedCost` is the value the figures above do NOT represent — a farm with a large `unallocatedCost` has an understated `totalAnnualCharge`, and nothing else in the response says so.' +
            '\n\n**`truncated: true` means the register hit the read bound**, so the totals are partial. Treat it like `unallocatedCost`: a number worth showing rather than a flag to ignore.' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**.',
        tags: ['Grain'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'The depreciation view. Never an error for a tenant that has not opted in — that is `method: "NONE"`.',
            schema: z
                .object({
                    method: z.enum(['NONE', 'STRAIGHT_LINE']).openapi({
                        description:
                            '`STRAIGHT_LINE` when the tenant has opted in, `NONE` otherwise. `NONE` carries no charges.',
                    }),
                    charges: z.array(MachineryDepreciationCharge),
                    totalAnnualCharge: z.number().openapi({
                        description: 'Sum of `charges[].annualCharge`. `0` when there are none.',
                    }),
                    unallocated: z.array(
                        z.object({
                            assetId: z.string(),
                            assetKey: z.string().nullable().optional(),
                            assetName: z.string(),
                            purchaseCost: z.number(),
                            reason: z.enum(['NO_USEFUL_LIFE']).openapi({
                                description:
                                    'Why it produced no charge. A growing union — show an unrecognised value as "not depreciated" rather than treating it as an error.',
                            }),
                        }),
                    ),
                    unallocatedCost: z.number().openapi({
                        description:
                            'Sum of `unallocated[].purchaseCost` — the capital value NOT represented in `totalAnnualCharge`.',
                    }),
                    truncated: z.boolean().openapi({
                        description: 'True when the register hit the read bound, so the totals are partial.',
                    }),
                })
                .openapi('MachineryDepreciation'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs/defaults',
        operationId: 'getCostDefaults',
        summary: '«Последни стойности» — what the farm last entered',
        description:
            'The farm\'s own last value for each OVERHEAD category, so «Нов разход» opens prefilled rather than empty.' +
            '\n\n**The farm\'s own history, never a benchmark.** There is no Agrent-wide table behind this — the owner\'s decision was explicit. A farm with no history gets an empty `overheads` array, and that is the correct first-run state rather than an error.' +
            '\n\n**Yearly overheads only** — `PAYROLL`, `CREDIT`, `DEPRECIATION`, `OTHER`. `RENT` is deliberately absent: it is a per-decare crop line in the owner\'s split, not an overhead, however fixed it is.' +
            '\n\n**`payrollHeadcount` / `payrollAnnualPerPerson` are `null`, never `0`, when a plain total was entered.** Zero people earning a salary is a different claim from "they typed a total", and a prefill that wrote zeros over that distinction would overwrite real figures with a number nobody typed.' +
            '\n\n**`incurredOn` is returned so a STALE default is visible.** Last year\'s salary figure prefilled silently is worse than one shown with its date beside it.' +
            '\n\n**`?commodity=<any spelling>` returns the per-CROP sheet instead** — the farm\'s last «Култура» lines for that crop, as `{ commodity, lines: [{ category, amountPerDca, currency, incurredOn, description }] }`. Send no `commodity` and you get the overhead payload above, unchanged. The spelling is normalised, so `Canola` resolves to `rapeseed`, and the canonical value is echoed back so you know what was looked up. A commodity the vocabulary does not cover is a **400** carrying `code: \"UNKNOWN_COMMODITY\"` and the value you sent in `params.commodity`, not an empty sheet: an empty answer is indistinguishable from "this crop has no history", so a typo would read as a fact about the farm.' +
            '\n\n**It returns the latest SET, not the latest line.** A sheet is several lines entered together — ПРЗ, торове, seed — so every row sharing the most recent `incurredOn` for that crop comes back, each with its own `description` as the row\'s name. Prefilling only the newest line would collapse a sheet into one and the farmer would retype the rest without noticing.' +
            '\n\n**`amountPerDca: null` means the farmer entered a TOTAL, not that the line is empty.** The line is returned rather than dropped, so a client can show the row unfilled instead of implying the farm never recorded that cost.' +
            '\n\n**Read each line\'s `currency`; do not assume the form\'s.** Bulgaria moved to EUR in 2026 and older rows are stored in BGN, so prefilling the NUMBER alone shows a 24 000 лв figure as €24 000 — wrong by the fixed 1.95583, and entirely plausible on screen. Convert, or leave a foreign-currency line out and say so.' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**.',
        tags: ['Grain'],
        params: TenantParams,
        query: z.object({
            commodity: z.string().optional().openapi({
                param: { name: 'commodity', in: 'query' },
                description:
                    'Any spelling the crop vocabulary resolves \u2014 `Canola`, `rapeseed`, \u00abрапица\u00bb. ' +
                    'Send it and the 200 is the per-CROP sheet, component `CropCostDefaults`; omit ' +
                    'it and the 200 is the overhead payload below, unchanged. The two shapes are ' +
                    'DISJOINT, so branch on which key is present rather than on what you sent. A ' +
                    'spelling the vocabulary does not cover is a 400 `UNKNOWN_COMMODITY`, never an ' +
                    'empty sheet.',
            }),
        }),
        success: {
            status: 200,
            description:
                'TWO disjoint shapes, and `commodity` decides which (#1612). Omit it and the ' +
                'response is `CostDefaults`: the farm\'s latest overhead figures, in a fixed ' +
                'category order so the form\'s fields do not reorder between visits, empty when ' +
                'the farm has no overhead history. Send it and the response is ' +
                '`CropCostDefaults`, that crop\'s own sheet.\n\n' +
                'BRANCH ON WHICH KEY IS PRESENT — `overheads` or `lines` — never on the `anyOf` ' +
                'order. The members are disjoint on their REQUIRED properties, which is the only ' +
                'reason `anyOf` discriminates at all; neither sets `additionalProperties: false`, ' +
                'so a member that later gains an optional key the other requires would make a ' +
                'positional read pick the wrong one with nothing failing.',
            schema: z.union([CostDefaults, CropCostDefaults])
        },
    });

}
