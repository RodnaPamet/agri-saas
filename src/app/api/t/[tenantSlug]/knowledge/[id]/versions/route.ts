import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { createArticleVersion } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { CreateKnowledgeVersionSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateKnowledgeVersionSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const version = await createArticleVersion(ctx, params.id, body);
            return jsonResponse(version, { status: 201 });
        },
    ),
);
