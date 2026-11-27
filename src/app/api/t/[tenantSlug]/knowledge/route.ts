import { NextRequest } from 'next/server';
import { z } from 'zod';
import { KnowledgeArticleStatus } from '@prisma/client';
import { getTenantCtx } from '@/app-layer/context';
import { listArticles, createArticle } from '@/app-layer/usecases/knowledge';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { parseCsvEnumParam, parseCsvIdParam } from '@/lib/validation/query-params';
import { CreateKnowledgeArticleSchema } from '@/lib/schemas';

/**
 * `status`, `category`, `crop`, and `region` are MULTI-value: the list
 * toolbar declares all four facets `multiple: true` (see
 * `filter-defs.ts`), so two selected values arrive comma-joined
 * (`?status=DRAFT,PUBLISHED`). `status` is validated against the
 * KnowledgeArticleStatus enum (unknown value → clean 400); `category` /
 * `crop` / `region` are free-text so they get the structural (non-enum)
 * CSV parser instead — same defect class, same fix, see
 * `@/lib/validation/query-params`.
 */
const StatusMember = z.nativeEnum(KnowledgeArticleStatus);



export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const sp = req.nextUrl.searchParams;
        const articles = await listArticles(ctx, {
            status: parseCsvEnumParam(sp.get('status'), StatusMember, 'status'),
            category: parseCsvIdParam(sp.get('category'), 'category'),
            cropTags: parseCsvIdParam(sp.get('crop'), 'crop'),
            regions: parseCsvIdParam(sp.get('region'), 'region'),
            q: normalizeQ(sp.get('q') ?? undefined),
        });
        return jsonResponse(articles);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateKnowledgeArticleSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const article = await createArticle(ctx, body);
            return jsonResponse(article, { status: 201 });
        },
    ),
);
