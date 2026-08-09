import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { CreatePolicySchema } from '@/lib/schemas';
import * as policyUsecases from '@/app-layer/usecases/policy';
import { z } from 'zod';
import { csvEnumField, csvIdField } from '@/lib/validation/query-params';
import { PolicyStatus } from '@prisma/client';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const PolicyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: csvEnumField(z.nativeEnum(PolicyStatus)),
    category: csvIdField(),
    language: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

// GET /api/t/[tenantSlug]/policies — list with filters + pagination
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
  const params = await paramsPromise;
  const ctx = await getTenantCtx(params, req);
  // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
  await assertModuleEnabled(ctx, 'CERTIFICATION');
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const query = PolicyQuerySchema.parse(sp);

  if (query.includeDeleted === 'true') {
    const policies = await policyUsecases.listPoliciesWithDeleted(ctx);
    return jsonResponse(policies);
  }

  const hasPagination = query.limit || query.cursor;
  if (hasPagination) {
    const result = await policyUsecases.listPoliciesPaginated(ctx, {
      limit: query.limit,
      cursor: query.cursor,
      filters: {
        status: query.status,
        category: query.category,
        language: query.language,
        q: query.q,
      },
    });
    return jsonResponse(result);
  }

  // PR-5 — backfill cap.
  const policies = await policyUsecases.listPolicies(
    ctx,
    {
      status: query.status,
      category: query.category,
      language: query.language,
      q: query.q,
    },
    { take: LIST_BACKFILL_CAP + 1 },
  );
  const result = applyBackfillCap(policies);
  // PR-6 — row-count observability.
  recordListPageRowCount({
    entity: 'policies',
    count: result.rows.length,
    truncated: result.truncated,
    tenantId: ctx.tenantId,
  });
  return jsonResponse(result);
});

// POST /api/t/[tenantSlug]/policies — create (blank or from template)
export const POST = withApiErrorHandling(
  withValidatedBody(CreatePolicySchema, async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // WP-2 — the compliance/GRC domain is gated behind CERTIFICATION.
    await assertModuleEnabled(ctx, 'CERTIFICATION');

    let policy;
    if (body.templateId) {
      policy = await policyUsecases.createPolicyFromTemplate(ctx, body.templateId, {
        title: body.title,
        description: body.description,
        category: body.category,
        ownerUserId: body.ownerUserId,
        language: body.language,
      });
    } else {
      policy = await policyUsecases.createPolicy(ctx, {
        title: body.title,
        description: body.description,
        category: body.category,
        ownerUserId: body.ownerUserId,
        reviewFrequencyDays: body.reviewFrequencyDays,
        language: body.language,
        content: body.content,
      });
    }

    return jsonResponse(policy, { status: 201 });
  })
);
