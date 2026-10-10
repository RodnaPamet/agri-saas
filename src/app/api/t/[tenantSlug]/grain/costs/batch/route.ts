/**
 * POST /api/t/[tenantSlug]/grain/costs/batch — one cost SHEET, all-or-nothing.
 *
 * agrent-ios' ask (#1524): "one sheet is up to about 10 lines, all-or-nothing,
 * under one `Idempotency-Key`. A half-saved sheet in the books is the failure
 * to avoid." Posting the lines one by one is ten chances over rural LTE to
 * leave the books half-written, and a half-saved sheet is worse than one that
 * failed outright — the farmer cannot tell which lines landed.
 *
 * ## A separate route rather than an overloaded POST
 *
 * The single-create POST takes a cost entry; this takes `{ lines: [...] }`.
 * Accepting either shape on one path would mean sniffing the body to decide
 * which contract applies, and the two have different success codes and
 * different failure semantics (one row, or none of them). A client that got
 * the sniff wrong would be told 201 for a shape the server read differently.
 *
 * ## Why the key handling lives in the usecase, not here
 *
 * `CostEntry` carries `@@unique([tenantId, clientMutationId])`, so the ten
 * lines of a sheet CANNOT share the batch key — the second hits the index.
 * The usecase derives a per-line key from it. That is a storage-shaped
 * decision and belongs with the storage, not in a route that would then be
 * the only place the derivation is written down.
 */
import type { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    CreateCostEntryBatchSchema,
    type CreateCostEntryBatchInput,
} from '@/app-layer/schemas/grain.schemas';
import { createCostEntryBatch } from '@/app-layer/usecases/cost-entry';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCostEntryBatchSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body: CreateCostEntryBatchInput,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            // Offline exactly-once. These are FINANCIAL records: an undeduped
            // retry books the whole sheet twice and moves net worth with
            // nothing erroring. The key is the SHEET's; the usecase derives a
            // per-line key from it so each row keeps its own idempotency.
            const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
            const result = await createCostEntryBatch(ctx, body, idempotencyKey);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
