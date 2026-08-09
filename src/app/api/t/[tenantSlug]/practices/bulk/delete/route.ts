/**
 * POST /api/t/:slug/practices/bulk/delete
 *
 * Bulk soft-delete practices (the practices table selection action-row).
 * Permission (ADMIN) + tenant isolation (and the global-library guard) are
 * enforced in `bulkDeletePractice`. Body: `{ practiceIds: string[] }`. Returns
 * `{ deleted: n }`.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkDeletePractice } from '@/app-layer/usecases/practice';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const BulkDeletePracticeSchema = z.object({
    practiceIds: z.array(z.string().min(1)).min(1).max(100),
});

export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkDeletePracticeSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkDeletePractice(ctx, body.practiceIds);
            return jsonResponse(result);
        },
    ),
);
