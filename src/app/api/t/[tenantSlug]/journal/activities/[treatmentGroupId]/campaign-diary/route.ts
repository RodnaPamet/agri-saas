/**
 * GET /api/t/[tenantSlug]/journal/activities/[treatmentGroupId]/campaign-diary
 *
 * One recorded activity's page of «ДНЕВНИК НА СТОПАНСТВОТО» (#2696).
 *
 * Owner, 2026-11-01, on «Обработка на почвата — 20688.13»: *"This can not be
 * printed."* They were right, and the reason is the interesting part.
 *
 * ## Why `campaign-diary` and NOT `farm-record`
 *
 * The obvious route name is the sibling's — `/journal/treatments/{handle}/
 * farm-record`. It would have been the right shape pointing at the wrong
 * document, with the name hiding it.
 *
 * `farm-record` means **Приложение 1 към заповед РД 11-3194/31.12.2021** —
 * «ДНЕВНИК ЗА ПРОВЕДЕНИТЕ РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ И ТОРЕНЕ». A
 * cultivation, pruning or harvest has no page in it: its core table is
 * ПРОВЕДЕНИ ХИМИЧНИ ОБРАБОТКИ, keyed on вредител, the ПРЗ product, доза and
 * карантинен срок. That is also exactly why the owner's print failed —
 * `generateFarmRecordDiaryPdfScoped` returns null when a treatment-scoped
 * document has no spray and no fertiliser lines, and a bare activity has
 * neither. `farm-record-diary.ts`'s own comment is blunt about the hazard: a
 * sowing reaching that table "would be filed as a plant-protection treatment
 * in a document an inspector reads".
 *
 * The owner named the right document themselves — «Дневник на стопанството» —
 * and it already existed, at `POST /reports/campaign-diary`, for a whole
 * campaign. Its row builder already aggregates **one row per ACTIVITY grouped
 * on `treatmentGroupId`** and its docblock records that a bare activity
 * carries one. So this is that renderer narrowed to one handle: no new
 * document, nothing invented, and nothing filed under a form number it does
 * not have.
 *
 * ## GET, where the campaign-wide one is POST
 *
 * The sibling is a POST because it takes a period. This one's only input is
 * the handle, which is a path segment, so there is nothing to post — the same
 * reasoning the treatment route gives for the same split. A pure read;
 * nothing is persisted.
 *
 * The handle is a PATH segment and never a query parameter, because iOS writes
 * the full URL including the query string to the device log, unsuppressably.
 *
 * ## Two refusals, deliberately distinguishable
 *
 * `ACTIVITY_NOT_FOUND` — no lines under that handle, i.e. the wrong handle;
 * the same code the activity correction route answers, with the same
 * `reference`. `REGISTER_EMPTY_FOR_PERIOD` — lines exist but none is complete,
 * which is a two-step treatment still in progress. A single code would make a
 * typo and an unfinished record the same event to a client.
 *
 * Neither is a 200 with an empty table. In a document somebody files, an empty
 * table is indistinguishable from a period that was genuinely quiet and
 * invites the reader to conclude no work was done — the owner's 2026-10-23
 * ruling, applied here for the same reason.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { gatherCampaignDiary } from '@/app-layer/reports/campaign-diary/gather';
import { renderCampaignDiary } from '@/app-layer/reports/pdf/campaign-diary';
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';
import { withApiErrorHandling } from '@/lib/errors/api';
import { contentDisposition } from '@/lib/http/content-disposition';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';

// PDFKit needs stream, zlib and Buffer.
export const runtime = 'nodejs';
// One activity is a handful of rows, so this needs none of the campaign
// route's 120s — that budget exists because a campaign is a year of
// uncapped history.
export const maxDuration = 60;

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

        // No `InvalidCampaignError` arm, unlike the campaign route: a handle
        // names its own period, so there is no label to parse and no malformed
        // input to turn into a 400.
        const data = await gatherCampaignDiary(ctx, {
            kind: 'activity',
            treatmentGroupId: params.treatmentGroupId,
        });

        const doc = createPdfDocument(
            {
                // `ctx.tenantSlug` is optional on RequestContext; the route
                // param never is, so it is the safe last resort.
                tenantName: data.header.producerName ?? params.tenantSlug,
                reportTitle: 'ДНЕВНИК НА СТОПАНСТВОТО',
                generatedAt: new Date().toISOString(),
                fontFamily: 'unicode',
            },
            // Landscape, matching the campaign-wide document exactly: this is
            // one page OF that register, so a reader filing both must not get
            // two orientations of the same nine columns.
            { size: 'A4', layout: 'landscape' },
        );
        renderCampaignDiary(doc, data);
        const pdf = await collectPdfBuffer(doc);

        return new Response(new Uint8Array(pdf), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': contentDisposition(
                    `dnevnik-stopanstvo-${params.treatmentGroupId}.pdf`,
                ),
                'Cache-Control': 'no-store',
                'Content-Length': String(pdf.length),
            },
        });
    },
);
