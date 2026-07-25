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
import { jsonResponse } from '@/lib/api-response';

/**
 * Contracts — grain marketing / supply contracts (GRAIN module).
 *   GET  → list contracts (newest first; ?status= / ?type= / ?seasonId= filters).
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
        const contracts = await listContracts(ctx, {
            status: parseCsvEnumParam(sp.get('status'), StatusMember, 'status'),
            type: parseCsvEnumParam(sp.get('type'), TypeMember, 'type'),
            seasonId: sp.get('seasonId') ?? undefined,
        });
        return jsonResponse(contracts);
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
