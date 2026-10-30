/**
 * DELETE a farm document (#2495, step 2).
 *
 * Gated on `documents.upload` — being a writer is the floor — and the usecase
 * then enforces uploader-or-admin, which is what `mayDelete` reports on the
 * list row. A role flag cannot express "may delete their OWN document", so
 * the narrower half belongs with the row, not with the permission.
 */
import { NextRequest } from 'next/server';

import { deleteFarmDocument } from '@/app-layer/usecases/farm-documents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; documentId: string }>(
        'documents.upload',
        async (_req: NextRequest, { params }, ctx) => {
            await deleteFarmDocument(ctx, params.documentId);
            // The row survives as a tombstone, so this is not a 204-with-
            // nothing-left: the client refetches the list and renders
            // «Изтрит на <дата>».
            return jsonResponse({ ok: true });
        },
    ),
);
