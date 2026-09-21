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
}
