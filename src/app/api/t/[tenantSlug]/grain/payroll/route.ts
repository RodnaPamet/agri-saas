import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listPayrollExpenses, createPayrollExpense } from '@/app-layer/usecases/payroll-expense';
import { CreatePayrollExpenseSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { parseCsvIdParam } from '@/lib/validation/query-params';

/**
 * Payroll expenses — the labour-cost register (GRAIN module).
 *   GET  → list payroll expenses (newest incurred-date first; ?seasonId=
 *          / ?plantingId= filters, ?q= free-text search over currency /
 *          season / planting). Rows carry NO encrypted narrative
 *          (`description`) — fetch one expense for that.
 *   POST → create a payroll expense.
 */

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const sp = req.nextUrl.searchParams;
        const { rows, totalCount, truncated } = await listPayrollExpenses(ctx, {
            seasonIds: parseCsvIdParam(sp.get('seasonId'), 'season'),
            plantingIds: parseCsvIdParam(sp.get('plantingId'), 'planting'),
            q: sp.get('q') ?? undefined,
        });
        // Hot list read on a page farmers reload over rural LTE — a weak
        // ETag turns an unchanged payroll register into a 304.
        return jsonWithETag(req, { rows, totalCount, truncated });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreatePayrollExpenseSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const record = await createPayrollExpense(ctx, body);
            return jsonResponse(record, { status: 201 });
        },
    ),
);
