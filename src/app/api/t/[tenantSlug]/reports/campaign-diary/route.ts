/**
 * POST /api/t/[tenantSlug]/reports/campaign-diary?campaign=2024-2025
 *
 * Streams «ДНЕВНИК НА СТОПАНСТВОТО» for one campaign — the whole farm, every
 * recorded activity, one landscape table (#2316). Replaces the БАБХ period
 * download; the БАБХ register stays per treatment and is
 * `/reports/season-diary` and the per-location routes.
 *
 * ## The campaign is a PARAMETER, not a row id
 *
 * `?campaign=2024-2025`, from which the window 1 Oct 2024 → 30 Sep 2025 is
 * derived. `Season` can express that window, but production has exactly one
 * Season, it is the sample dataset, and its window is 1 Mar – 31 Oct — so a
 * picker backed by Season rows would offer one sample season with the wrong
 * dates, and an empty list on a tenant with none. A campaign is a pure
 * function of a year: no seeding step, no empty state, nothing to keep in sync.
 *
 * ## An empty campaign is a coded 404, not an empty PDF
 *
 * `REGISTER_EMPTY_FOR_PERIOD`, the code the per-block register already answers
 * under the owner's 2026-10-23 ruling. A client then shows «Няма записи за
 * тази кампания». A 200 with an empty table would be the worse answer in a
 * regulated document: indistinguishable from a period that was genuinely
 * quiet, and it invites the reader to conclude no work was done.
 *
 * ## Landscape, and no row cap
 *
 * The generator does not cap rows — `farm-record-diary.ts` caps field sheets
 * but deliberately not lines, because "a vanished spray is an unrecorded
 * chemical application", and a campaign row is the same kind of record. So a
 * farm with years of history can ask for a large document and `maxDuration`
 * carries it, rather than the document silently omitting work.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { gatherCampaignDiary } from '@/app-layer/reports/campaign-diary/gather';
import { renderCampaignDiary } from '@/app-layer/reports/pdf/campaign-diary';
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { contentDisposition } from '@/lib/http/content-disposition';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { InvalidCampaignError } from '@/lib/reports/campaign-window';

// Force Node.js runtime — PDFKit needs stream, zlib, Buffer.
export const runtime = 'nodejs';
// A campaign is a year of activity and rows are uncapped by design, so this is
// longer than the season diary's: the alternative to waiting is a document
// that drops records.
export const maxDuration = 120;

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const campaign = req.nextUrl.searchParams.get('campaign');
        if (!campaign) throw badRequest('campaign is required, as YYYY-YYYY (e.g. 2024-2025)');

        let data;
        try {
            data = await gatherCampaignDiary(ctx, campaign);
        } catch (err) {
            // A malformed label is the CALLER's error. Left to bubble it would
            // surface as a 500 — `InvalidCampaignError` is not one of the coded
            // shapes `withApiErrorHandling` knows — and a 500 tells a client
            // nothing it can act on, where the message already names the fix
            // ("did you mean 2024-2025?").
            if (err instanceof InvalidCampaignError) throw badRequest(err.message);
            throw err;
        }

        const doc = createPdfDocument(
            {
                // `ctx.tenantSlug` is optional on RequestContext; the route
                // param never is, so it is the safe last resort.
                tenantName: data.header.producerName ?? params.tenantSlug,
                reportTitle: 'ДНЕВНИК НА СТОПАНСТВОТО',
                generatedAt: new Date().toISOString(),
                fontFamily: 'unicode',
            },
            // Landscape: nine columns do not fit portrait, and the owner's form
            // is landscape.
            { size: 'A4', layout: 'landscape' },
        );
        renderCampaignDiary(doc, data);
        const pdf = await collectPdfBuffer(doc);

        return new Response(new Uint8Array(pdf), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': contentDisposition(`dnevnik-kampaniya-${data.campaignLabel}.pdf`),
                'Cache-Control': 'no-store',
                'Content-Length': String(pdf.length),
            },
        });
    },
);
