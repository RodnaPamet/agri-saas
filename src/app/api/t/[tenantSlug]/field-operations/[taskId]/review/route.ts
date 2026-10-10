import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { reviewFieldOperation } from '@/app-layer/usecases/field-operation';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { FieldOperationReviewSchema } from '@/lib/schemas';

/**
 * Review a completed field operation (#6).
 *   POST { action: 'APPROVE' | 'REQUEST_CHANGES', comment? }
 *   → approve finalises the job (RESOLVED); request-changes reopens it
 *     (IN_PROGRESS). Reviewer-gated (ADMIN) in the usecase.
 */

export const POST = withApiErrorHandling(
    withValidatedBody(
        FieldOperationReviewSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await reviewFieldOperation(ctx, params.taskId, {
                action: body.action,
                comment: body.comment ?? undefined,
            });
            return jsonResponse(result);
        },
    ),
);
