/**
 * GET /api/t/[tenantSlug]/inventory/lots/[lotId]/ledger?limit=&cursor=
 *
 * Cursor-paginated stock ledger for a lot — the deep-history companion to
 * the lot detail endpoint (whose inline `ledger` is the recent first
 * page). Keeps a high-volume lot's audit trail pageable instead of
 * capped, ordered by the canonical append/hash-chain key (createdAt, id).
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { listLotLedger } from '@/app-layer/usecases/inventory';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { LedgerQuerySchema } from '@/app-layer/schemas/inventory.schemas';


export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; lotId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'INVENTORY');
        const q = LedgerQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        const page = await listLotLedger(ctx, params.lotId, { limit: q.limit, cursor: q.cursor });
        return jsonResponse(page);
    },
);
