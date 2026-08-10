import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getPayrollExpense,
    updatePayrollExpense,
    deletePayrollExpense,
} from '@/app-layer/usecases/payroll-expense';
import { UpdatePayrollExpenseSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single payroll expense (GRAIN module).
 *   GET    → the record (+ planting / season, including `description`).
 *   PATCH  → update record fields (write-gated).
 *   DELETE → soft-delete the record (write-gated).
 */

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; payrollExpenseId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const record = await getPayrollExpense(ctx, params.payrollExpenseId);
        return jsonResponse(record);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdatePayrollExpenseSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; payrollExpenseId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const record = await updatePayrollExpense(ctx, params.payrollExpenseId, body);
            return jsonResponse(record);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; payrollExpenseId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const result = await deletePayrollExpense(ctx, params.payrollExpenseId);
        return jsonResponse(result);
    },
);
