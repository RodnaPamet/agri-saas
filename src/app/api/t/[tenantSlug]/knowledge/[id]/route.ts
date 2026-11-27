import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getArticle, updateArticleMetadata } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { UpdateKnowledgeArticleSchema } from '@/lib/schemas';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const article = await getArticle(ctx, params.id);
        return jsonResponse(article);
    },
);



export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateKnowledgeArticleSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const article = await updateArticleMetadata(ctx, params.id, body);
            return jsonResponse(article);
        },
    ),
);
