import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ContractStatus, ContractType } from '@prisma/client';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listContracts, createContract } from '@/app-layer/usecases/contract';
import { CreateContractSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { parseCsvEnumParam } from '@/lib/validation/query-params';
import { summariseContractBook } from '@/lib/grain/contract-value';
import { CONTRACTED_COMMITMENT_STATUSES } from '@/app-layer/domain/contract-status';
import { jsonResponse } from '@/lib/api-response';

/**
 * Contracts — grain marketing / supply contracts (GRAIN module).
 *   GET  → `{ rows, totals, totalCount, truncated }` — contracts newest
 *          first (?status= / ?type= / ?seasonId= / ?q= filters), each row
 *          decorated with its `fulfilment` position and Decimal-exact
 *          `valueAmount`, plus per-currency book totals for the live
 *          commitment statuses. Rows carry NO encrypted narrative
 *          (`terms` / `pricingNotes`) — fetch one contract for those.
 *   POST → create a contract.
 *
 * `status` and `type` are MULTI-value: the list toolbar declares both
 * facets `multiple: true`, so two selected statuses arrive comma-joined
 * (`?status=DRAFT,ACTIVE`). Each member is validated against the Prisma
 * enum here — an unknown value is a clean 400, never an unvalidated
 * string reaching Prisma (which threw a 500 that the table rendered as
 * "no results").
 */

const StatusMember = z.nativeEnum(ContractStatus);
const TypeMember = z.nativeEnum(ContractType);

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const sp = req.nextUrl.searchParams;
        const { rows, totalCount, truncated } = await listContracts(ctx, {
            status: parseCsvEnumParam(sp.get('status'), StatusMember, 'status'),
            type: parseCsvEnumParam(sp.get('type'), TypeMember, 'type'),
            seasonId: sp.get('seasonId') ?? undefined,
            q: sp.get('q') ?? undefined,
        });
        // Book totals are computed from the SAME bounded page, so they
        // can never disagree with the rows on screen, and are grouped by
        // currency — never summed across. Scoped to the live commitment
        // statuses: a DRAFT is not part of the book.
        return jsonResponse({
            rows,
            totals: summariseContractBook(rows, CONTRACTED_COMMITMENT_STATUSES),
            totalCount,
            truncated,
        });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateContractSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const contract = await createContract(ctx, body);
            return jsonResponse(contract, { status: 201 });
        },
    ),
);
