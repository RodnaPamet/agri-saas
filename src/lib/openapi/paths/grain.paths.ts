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
    CostEntryDTOSchema,
    CostEntryListSchema,
    YieldRecordDTOSchema,
    YieldRecordListSchema,
    ContractDTOSchema,
    ContractListSchema,
    ContractFulfilmentSchema,
    GrainBinDTOSchema,
} from '@/lib/dto/grain.dto';
import { CalculatorDataSchema } from '@/lib/dto/grain-calculator.dto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

// ZodObject, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

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
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs',
        operationId: 'createCostEntry',
        summary: 'Record a cost',
        description:
            'Creates one cost entry. `allocationBasis` decides how it reaches a crop — read ' +
            "the enum's own docs before choosing, because the basis is what makes a cost " +
            'attributable rather than stranded in `unallocatedToCrop` on the calculator.' +
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and reused on every retry of the same logical write. The server maps it to `clientMutationId` and a replay returns the ORIGINAL row rather than booking the figure twice. These are FINANCIAL records: an undeduped retry moves net worth with nothing erroring.',
        tags: ['Grain'],
        params: TenantParams,
        body: CreateCostEntrySchema,
        success: { status: 201, description: 'The created cost entry.', schema: CostEntryDTOSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'getCostEntry',
        summary: 'Get one cost entry',
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
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and reused on every retry of the same logical write. The server maps it to `clientMutationId` and a replay returns the ORIGINAL row rather than booking the figure twice. These are FINANCIAL records: an undeduped retry moves net worth with nothing erroring.',
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
            'kept beside it.',
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
            'The list row PLUS `lots` and `lotsTruncated`. The lots are capped, and `lotsTruncated: true` says rows were dropped — unlike most of this API, this one tells you.',
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
            'The RAW model plus its season — NOT the list row, which additionally carries computed fulfilment, value and benchmark.',
        tags: ['Grain'],
        params: ContractParams,
        success: { status: 200, description: 'The contract.', schema: ContractDTOSchema },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/contracts/{contractId}',
        operationId: 'updateGrainContract',
        summary: 'Update a contract',
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
            'Removing a delivery changes the contract’s fulfilment. Re-read the contract or its deliveries afterwards rather than adjusting a cached figure.',
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
}
