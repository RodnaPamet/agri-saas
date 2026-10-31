/**
 * GET  /api/t/[tenantSlug]/documents  → { rows, truncated }, newest first
 * POST /api/t/[tenantSlug]/documents  → multipart upload, returns the row
 *
 * «Документи», #2495 step 2. HTTP boundary only: every policy, gate and query
 * lives in `@/app-layer/usecases/farm-documents`.
 *
 * MECHANISATOR never reaches here — `isOperatorAllowedPath` does not admit
 * `/documents`, so the Edge refuses that persona before this file runs
 * (#2495 Decision 1). Nothing in this route re-checks it, deliberately: a
 * second spelling of a confinement is how the two come to disagree.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import {
    listFarmDocuments,
    uploadFarmDocument,
    DOCUMENT_PAGE_SIZE,
} from '@/app-layer/usecases/farm-documents';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const raw = req.nextUrl.searchParams.get('limit');
        const limit = raw === null ? undefined : Number(raw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            throw badRequest('limit must be a positive integer');
        }

        const payload = await listFarmDocuments(ctx, { limit });
        // A hot list read, so it carries a weak ETag and honours
        // If-None-Match — the cold-start convention for every list GET on a
        // product people open on rural LTE.
        return jsonWithETag(req, payload);
    },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const contentType = req.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
            throw badRequest('Expected multipart/form-data');
        }

        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
            throw badRequest('Missing or invalid file in form data');
        }

        // A retry handle, not an outbox replay — «Документи» is deliberately
        // not an outbox surface, so this exists for the case where the first
        // attempt stored the bytes and the response was lost.
        const idempotencyKey = req.headers.get('Idempotency-Key');

        const row = await uploadFarmDocument(ctx, file, idempotencyKey);
        return jsonResponse(row, { status: 201 });
    },
);

/** Exported for the OpenAPI description, so the page size has one spelling. */
export const PAGE_SIZE = DOCUMENT_PAGE_SIZE;
