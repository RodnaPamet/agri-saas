/**
 * P6.7 (#1816) — the A6 share card, as bytes.
 *
 *   GET /api/t/:slug/farm-brand/share-card  ->  application/pdf (105 x 148 mm)
 *
 * `GET` because it is a pure read that a link or a button can hit directly and
 * a retry is free. There is nothing to send: the card is derived entirely from
 * the farm's own published profile.
 *
 * Why a PDF rather than a `@media print` page is argued in the generator —
 * `globals.css` already owns the only `@page` rule in the repo and it is
 * document-scoped, so an A6 print stylesheet could not exist without
 * re-sizing every other print surface in the app.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { buildFarmShareCard } from '@/app-layer/usecases/public-farm-profile';
import { generateFarmShareCardPdf } from '@/app-layer/reports/pdf/farm-share-card';
// The SHARED collector, not a local copy. Its own docblock says why: "two
// hand-rolled stream collectors is how two byte-serving routes end up
// disagreeing about when the document is finished", and listeners must be
// attached before `end()` or the buffer comes back truncated rather than
// failing. (`processes/[id]/export-pdf` still holds a third copy — #1905.)
import { collectPdfBuffer } from '@/app-layer/reports/pdf/collect-buffer';
import { contentDisposition } from '@/lib/http/content-disposition';

// pdfkit needs stream / zlib / Buffer, and the bundled DejaVu is read from
// disk — Node runtime, not Edge.
export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        // #1197's standing rule: every social surface sits behind a runtime
        // flag, default OFF. `assertFeatureEnabled` 404s rather than 403s so
        // a dark-launched surface stays undiscoverable.
        //
        // The key is a LITERAL here rather than behind a shared helper:
        // `social-routes-flag-gated` requires one, because an operator
        // holding the flag console has to find the gate by reading the route.
        await assertFeatureEnabled('social.public-profile', ctx.userId);

        // Owner check and the three fail-closed print preconditions live in
        // the usecase, so this file stays a byte-serving shell.
        const card = await buildFarmShareCard(ctx);
        const pdfBuffer = await collectPdfBuffer(generateFarmShareCardPdf(card));

        // The farm's own name, carried by RFC 5987 `filename*`. A Bulgarian
        // name in a bare `filename=` does not degrade — it THROWS, because a
        // header value is a ByteString — which is the defect
        // `contentDisposition` exists to prevent.
        const filename = `${card.displayName}.pdf`;

        // NextResponse's BodyInit accepts Uint8Array but not the Node Buffer
        // subtype, so project through Uint8Array.
        return new NextResponse(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': contentDisposition(filename),
                'Content-Length': String(pdfBuffer.length),
                // The card embeds the farm's current public name. Caching it
                // would hand out a sheet naming what the farm used to be
                // called.
                'Cache-Control': 'no-store, max-age=0',
            },
        });
    },
);
