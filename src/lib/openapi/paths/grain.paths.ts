/**
 * Grain — the net-worth calculator.
 *
 * The calculator came first, and it exists because the calculator had no API
 * at all: `/grain/calculator` is a Server Component that calls the usecase and
 * hands a payload straight to a client island. The native client cannot consume
 * that, so the same answer needed an HTTP door.
 *
 * ── Response shapes: 11 of 13 are now pinned, and 2 deliberately are not ──
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
 * ── Why the calculator's body stays `z.unknown()` ──
 *
 * `CalculatorData` is a deep shape — per-commodity rows each carrying
 * per-area figures, break-even figures, an uncertainty state and a cost
 * breakdown, plus farm totals, nine exclusion classes, cash-out lines and
 * two figures that sit beside the cost side. Hand-writing that as Zod would
 * make a THIRD spelling of one payload, beside the TypeScript types and the
 * mapper that builds it, free to drift from both.
 *
 * The whole point of `@/lib/grain/calculator-payload` is that the page and
 * the route cannot describe the calculator differently. Adding a Zod copy
 * here would reintroduce exactly the divergence it was written to remove, and
 * nothing would make the copy disagree out loud. So the shape is NAMED in the
 * description and its source of truth is cited; the module is the contract.
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
} from '@/lib/dto/grain.dto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

// ZodObject, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
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
            schema: z.unknown(),
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
    // for what that surfaced. Only the calculator is still prose-only, and the
    // header says why.
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
}
