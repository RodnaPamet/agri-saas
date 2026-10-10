import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertNotPastDueRestricted } from '@/lib/billing/entitlements';
import { jsonWithETag } from '@/lib/http/etag';
import { getMarketNews } from '@/app-layer/usecases/trends';
import { TrendNewsQuerySchema } from '@/app-layer/schemas/trends.schemas';

/**
 * GET /api/t/[tenantSlug]/trends/news?category=&limit=&tags=&q=&cursor=
 *
 * Returns the GLOBAL aggregated agri-news feed (Trends → News tab), newest
 * first, optionally filtered by category ('market' | 'policy' | 'general' |
 * 'all'), by `tags` (comma-separated, ANY-OF) and by a `q` search over title +
 * summary, paged by an opaque `cursor`. Tenant-authed (getTenantCtx) —
 * read-tier rate limiting applies at the edge. Redis-cached (1h) inside the
 * usecase except for searches; the payload is tenant-agnostic.
 *
 * The response ECHOES `category`, `tags` and `q` — every filter actually
 * applied. `category` in particular is not optional: the installed iOS build
 * decodes it as a required String. The echo is how a client tells a stale
 * payload from the one it asked for, and how it discovers that a stored tag
 * preference has been renamed away (it asked for two tags and got one back).
 *
 * The preferences stored at `/api/me/news-preferences` are NOT applied here
 * implicitly, and that is load-bearing rather than lazy: this payload is
 * cached under a key shared by every reader, so filtering by the caller's own
 * preferences would write one person's feed into the entry everybody else
 * reads. Clients resolve their preferences and pass `tags` explicitly.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        // Authenticate + gate tenant access (payload itself is tenant-agnostic).
        const ctx = await getTenantCtx(params, req);

        // #1325 — gated HERE rather than in the usecase, because
        // `getMarketNews` is tenant-INDEPENDENT and Redis-cached across every
        // tenant: a gate inside it has no tenant to test, and one that did
        // would be bypassed by the next cache hit. The route is where the
        // reader's tenant is known.
        //
        // The ctx was previously DISCARDED here (a bare `await` for its
        // auth side effect alone), which is why this route needed a binding
        // adding rather than just a line.
        await assertNotPastDueRestricted(ctx, 'trends');

        const query = TrendNewsQuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const payload = await getMarketNews(query.category, query.limit, {
            tags: query.tags,
            q: query.q ?? null,
            cursor: query.cursor ?? null,
        });
        // Weak ETag + If-None-Match → 304. Both trends GETs are hot
        // list-reads on a mobile-first product over rural LTE, which is
        // exactly the cold-start data-cost convention's target.
        return jsonWithETag(req, payload);
    },
);
