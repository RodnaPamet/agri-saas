import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { generateFarmRecordDiaryPdfScoped } from '@/app-layer/reports/pdf/farm-record-diary';
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedNotFound } from '@/lib/errors/types';
import { contentDisposition } from '@/lib/http/content-disposition';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * The ДНЕВНИК pages for ONE recorded treatment (#1740 item 3).
 *
 * The same Приложение 1 document the per-block register produces — same
 * gatherer, same renderer — limited to one treatment across the blocks it
 * touched: the farm header, a field header strip for each treated parcel, and
 * only this treatment's rows. Same layout, so it can be certified.
 *
 * ## Bytes inline, no job and no URL to poll
 *
 * 200 with `application/pdf` and a `Content-Disposition` filename, exactly as
 * `POST /locations/{id}/farm-record` answers without `save`. The phone reuses
 * its existing ДНЕВНИК path: check for `%PDF`, open Quick Look.
 *
 * ## GET, where its sibling is POST
 *
 * That route is a POST because it takes a body — the period, and `save`. This
 * one's only input is the handle, which is a path segment, so there is nothing
 * to post. It is also a pure read: nothing is persisted, deliberately. The
 * per-block route can save into a location's Farm-records register; a
 * treatment-scoped document has no obvious home there, and inventing one is a
 * separate decision about where such a document belongs.
 *
 * The handle is a path segment rather than a query parameter because iOS
 * writes the full URL including the query string to the device log,
 * unsuppressably.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const pdfDoc = await generateFarmRecordDiaryPdfScoped(ctx, {
            kind: 'treatment',
            treatmentGroupId: params.treatmentGroupId,
        });
        // A handle with no recorded lines is a 404, not an empty register. A
        // blank document is indistinguishable from a real one whose treatment
        // happened to record nothing, and a farmer cannot tell which they are
        // holding.
        if (!pdfDoc) {
            throw codedNotFound(
                'TREATMENT_NOT_FOUND',
                'No treatment was recorded under that handle.',
                { reference: 'treatmentGroupId' },
            );
        }

        const pdfBuffer = await collectPdfBuffer(pdfDoc);
        return new Response(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': contentDisposition(
                    `dnevnik-${params.treatmentGroupId}.pdf`,
                ),
                'Cache-Control': 'no-store',
                'Content-Length': String(pdfBuffer.length),
            },
        });
    },
);
