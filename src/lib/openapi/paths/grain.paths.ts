/**
 * Grain — the net-worth calculator.
 *
 * One route today, and it exists because the calculator had no API at all:
 * `/grain/calculator` is a Server Component that calls the usecase and hands
 * a payload straight to a client island. The native client cannot consume
 * that, so the same answer needed an HTTP door.
 *
 * ── Why the success body is `z.unknown()` and not a Zod mirror ──
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
 * `journal.paths.ts` takes the same position for its three-shaped list
 * response, for the same reason.
 */
import { z } from '@/lib/openapi/zod';
import {
    CreateCostEntrySchema,
    UpdateCostEntrySchema,
    CreateYieldRecordSchema,
    UpdateYieldRecordSchema,
    CreateContractSchema,
} from '@/app-layer/schemas/grain.schemas';
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
    // they cannot drift from the handler. Response bodies stay `z.unknown()`
    // with the shape described in prose, for the same reason the calculator's
    // does: a mirrored response schema is a second spelling of a payload,
    // free to drift, and inventing one here would be worse than pointing at
    // the use case that produces it.
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
        success: { status: 200, description: 'Cost entries.', schema: z.unknown() },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/costs',
        operationId: 'createCostEntry',
        summary: 'Record a cost',
        description:
            'Creates one cost entry. `allocationBasis` decides how it reaches a crop — read ' +
            "the enum's own docs before choosing, because the basis is what makes a cost " +
            'attributable rather than stranded in `unallocatedToCrop` on the calculator.',
        tags: ['Grain'],
        params: TenantParams,
        body: CreateCostEntrySchema,
        success: { status: 200, description: 'The created cost entry.', schema: z.unknown() },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'getCostEntry',
        summary: 'Get one cost entry',
        tags: ['Grain'],
        params: CostEntryParams,
        success: { status: 200, description: 'The cost entry.', schema: z.unknown() },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'updateCostEntry',
        summary: 'Update a cost entry',
        tags: ['Grain'],
        params: CostEntryParams,
        body: UpdateCostEntrySchema,
        success: { status: 200, description: 'The updated cost entry.', schema: z.unknown() },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/costs/{costEntryId}',
        operationId: 'deleteCostEntry',
        summary: 'Delete a cost entry',
        tags: ['Grain'],
        params: CostEntryParams,
        success: { status: 200, description: 'Deleted.', schema: z.unknown() },
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
        success: { status: 200, description: 'Yield records.', schema: z.unknown() },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/grain/yield-records',
        operationId: 'createYieldRecord',
        summary: 'Record a yield',
        tags: ['Grain'],
        params: TenantParams,
        body: CreateYieldRecordSchema,
        success: { status: 200, description: 'The created yield record.', schema: z.unknown() },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'getYieldRecord',
        summary: 'Get one yield record',
        tags: ['Grain'],
        params: YieldRecordParams,
        success: { status: 200, description: 'The yield record.', schema: z.unknown() },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'updateYieldRecord',
        summary: 'Update a yield record',
        tags: ['Grain'],
        params: YieldRecordParams,
        body: UpdateYieldRecordSchema,
        success: { status: 200, description: 'The updated yield record.', schema: z.unknown() },
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
        success: { status: 200, description: 'The created contract.', schema: z.unknown() },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/grain/yield-records/{yieldRecordId}',
        operationId: 'deleteYieldRecord',
        summary: 'Delete a yield record',
        tags: ['Grain'],
        params: YieldRecordParams,
        success: { status: 200, description: 'Deleted.', schema: z.unknown() },
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
        success: { status: 200, description: 'Contracts.', schema: z.unknown() },
    });
}
