/**
 * «Документи» — the farm document library list and upload (#2495, step 2).
 *
 * `requirePermission` rather than a hand-rolled permission check, so the
 * route is covered by the Epic C.1 guardrail and its rule is findable in
 * `route-permissions.ts`. MECHANISATOR is excluded by `isOperatorAllowedPath`
 * — which admits no `documents` prefix — and additionally holds
 * `documents.view: false`, so neither layer alone is load-bearing.
 */
import { NextRequest } from 'next/server';

import { listFarmDocuments, uploadFarmDocument } from '@/app-layer/usecases/farm-documents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { codedBadRequest } from '@/lib/errors/types';

/** GET — the library, newest first, tombstones included. */
export const GET = withApiErrorHandling(
    requirePermission('documents.view', async (req: NextRequest, _routeArgs, ctx) => {
        const payload = await listFarmDocuments(ctx);
        // A hot list read, so it carries a weak ETag like journal / farm-tasks
        // / locations do — a relaunch on rural LTE revalidates to a 304
        // instead of re-sending the page.
        return jsonWithETag(req, payload);
    }),
);

/** POST — accept one file into the library. */
export const POST = withApiErrorHandling(
    requirePermission('documents.upload', async (req: NextRequest, _routeArgs, ctx) => {
        const formData = await req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
            throw codedBadRequest('FILE_REQUIRED', 'A file is required.');
        }
        // Passed through to the usecase, which answers a replay from the
        // existing row rather than creating a second document. The phone is
        // the reason this matters: a multipart body over a rural connection
        // is the write most likely to be retried, and documents are
        // deliberately not an outbox surface.
        const idempotencyKey = req.headers.get('Idempotency-Key');
        // The farmer's own title, as a TEXT field beside the file.
        //
        // A native client cannot put a Cyrillic title in a multipart part
        // header and rely on every parser agreeing about the encoding, so it
        // sends an ASCII filename plus `name`. Taking the title from the file
        // part alone would label every upload from the phone «document.pdf».
        // The usecase sanitises it and falls back to the filename.
        const title = formData.get('name');
        const row = await uploadFarmDocument(ctx, file, {
            idempotencyKey,
            title: typeof title === 'string' ? title : null,
        });
        return jsonResponse(row, { status: 201 });
    }),
);
