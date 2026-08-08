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

/** BBCH is a 00-99 ordinal growth-stage scale — both-or-neither, in
 *  range, min <= max is enforced at the usecase layer (`knowledge.ts`'s
 *  `assertValidBbchRange`); this schema only bounds the wire shape. */
const BbchStage = z.number().int().min(0).max(99).nullable().optional();

const CreateKnowledgeArticleSchema = z
    .object({
        title: z.string().min(1, 'Title is required').max(500),
        summary: z.string().max(2000).nullable().optional(),
        category: z.string().max(120).nullable().optional(),
        ownerUserId: z.string().nullable().optional(),
        language: z.string().max(8).nullable().optional(),
        source: z.string().max(120).nullable().optional(),
        cropTags: z.array(z.string().max(60)).max(20).optional(),
        regions: z.array(z.string().max(60)).max(20).optional(),
        bbchStageMin: BbchStage,
        bbchStageMax: BbchStage,
        contentType: z.enum(['HTML', 'MARKDOWN']).optional(),
        content: z.string().max(100000).nullable().optional(),
    })
    .strip();

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
