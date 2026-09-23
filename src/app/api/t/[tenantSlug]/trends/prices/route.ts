import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { getPriceTrends } from '@/app-layer/usecases/trends';
import { TrendPricesQuerySchema } from '@/app-layer/schemas/trends.schemas';
import { resolveReaderLocale } from '@/app-layer/usecases/reader-locale';

/**
 * GET /api/t/[tenantSlug]/trends/prices?commodity=&range=
 *
 * Returns the GLOBAL market-price series for one commodity, grouped by
 * (source, region) so the chart can split lines by unit/currency. Tenant-authed
 * (getTenantCtx) — read-tier rate limiting applies at the edge. The response is
 * Redis-cached (6h) inside the usecase.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        // Authenticate + gate tenant access (payload itself is tenant-agnostic).
        const ctx = await getTenantCtx(params, req);

        // The reader's language, from their OWN column — not the request
        // cookie. A native client authenticates with a bearer token and sends
        // no `NEXT_LOCALE`, so a cookie-derived locale would hand the phone
        // the unauthenticated default (`en`) and quietly undo the point of
        // localising the labels at all. `resolveRecipientLocale` already
        // draws that distinction for outbound email and falls back to `bg`,
        // which is the column default and what four of five users carry.
        const locale = await resolveReaderLocale(ctx);

        const query = TrendPricesQuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const payload = await getPriceTrends(query.commodity, query.range, locale);
        // Weak ETag + If-None-Match → 304. Both trends GETs are hot
        // list-reads on a mobile-first product over rural LTE, which is
        // exactly the cold-start data-cost convention's target.
        //
        // The ETag is derived from the PAYLOAD, which now differs by language,
        // so it varies by locale without anything extra — worth stating
        // because the alternative shape (hashing the query alone) would have
        // served a cached 304 for the wrong language.
        return jsonWithETag(req, payload);
    },
);
