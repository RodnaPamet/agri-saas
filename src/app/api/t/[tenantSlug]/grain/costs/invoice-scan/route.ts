import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { scanInvoice } from '@/app-layer/usecases/invoice-scan';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * «Сканирай фактура» — read an invoice and PROPOSE cost lines (#482).
 *
 * `POST` multipart/form-data, with exactly one of:
 *
 *   - `file`       — the bytes, from the «Нов разход» camera.
 *   - `fileId`     — a `FileRecord` already stored. No second copy of the bytes.
 *   - `documentId` — a «Документи» row, which is what «Към разходи» holds. The
 *                    server resolves it to the document's `FileRecord`, because
 *                    `fileRecordId` is not on the document DTO and a client
 *                    that can see a document cannot name its file.
 *
 * **It creates no cost entry.** Owner ruling: the invoice FILLS the form and
 * the farmer taps «Запиши», so the response is a proposal in
 * `CreateCostEntrySchema`'s own shape and `POST /grain/costs/batch` is what
 * writes it. A misread amount never reaches the Калкулатор unseen.
 *
 * Multipart is handled HERE rather than by a generic upload endpoint because
 * this repo has none — every multipart route mints its own `FileRecord` as
 * part of an entity-specific write. That is the `costs/[id]/invoice` route's
 * reasoning verbatim, and this is its sibling.
 *
 * `fileId` rides in the FORM BODY rather than a query string on purpose: iOS
 * writes the full URL, query included, to the device log below anything an app
 * can suppress (#1087), and a file id is a handle to a farm's own document.
 */
export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'GRAIN');

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
        throw codedBadRequest(
            'INVOICE_SCAN_INPUT_AMBIGUOUS',
            'Send either the invoice file or the id of one already uploaded.',
        );
    }

    const formData = await req.formData();
    const file = formData.get('file');

    // A `File` that is not a File (a client sending the field as text) is
    // treated as ABSENT rather than coerced, so the XOR in the usecase sees
    // the truth and the refusal names the real problem.
    const text = (key: string): string | null => {
        const raw = formData.get(key);
        return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
    };

    const result = await scanInvoice(ctx, {
        file: file instanceof File ? file : null,
        fileId: text('fileId'),
        documentId: text('documentId'),
    });

    // 200, not 201: the only row this creates is the stored FileRecord, and
    // the resource a 201 would point at — the cost entries — deliberately
    // does not exist yet.
    return jsonResponse(result);
});
