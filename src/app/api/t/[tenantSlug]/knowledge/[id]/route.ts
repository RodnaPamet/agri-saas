import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getArticle, updateArticleMetadata } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const article = await getArticle(ctx, params.id);
        return jsonResponse(article);
    },
);

const UpdateKnowledgeArticleSchema = z
    .object({
        title: z.string().min(1, 'Title is required').max(500).optional(),
        summary: z.string().max(2000).nullable().optional(),
        category: z.string().max(120).nullable().optional(),
        ownerUserId: z.string().nullable().optional(),
        language: z.string().max(8).nullable().optional(),
    })
    .strip();

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
