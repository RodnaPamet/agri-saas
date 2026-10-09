import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertNotPastDueRestricted } from '@/lib/billing/entitlements';
import { jsonWithETag } from '@/lib/http/etag';
import { newsTagCatalogue } from '@/lib/news/tag-catalogue';

/**
 * GET /api/t/[tenantSlug]/trends/news/tags
 *
 * The Новини tag vocabulary with its labels, so neither client hard-codes it —
 * the owner's decision, §2 of the tags-and-preferences contract. A tag added on
 * the server appears in the «Предпочитания» sheet with no app release, which is
 * the whole reason this is an endpoint rather than a constant.
 *
 * ## A separate GET rather than part of the feed
 *
 * The feed is paged and searched; a catalogue repeated on every page is
 * repeated for nothing. This is small enough for a client to hold and static
 * enough to cache hard, which the two together make worthwhile (§4).
 *
 * ## Cached for 24h, unlike its siblings
 *
 * `jsonWithETag` defaults to `private, no-cache` — store-but-always-revalidate,
 * which is right for the feed, where a reader expects new articles. The
 * vocabulary changes when someone edits `categorize.ts`, so it is given
 * `max-age=86400` instead. The ETag is kept, so a client that revalidates
 * anyway still gets a cheap 304 rather than the body.
 *
 * `private` rather than `public` even though the payload is identical for every
 * tenant: the response is behind authentication, and a shared cache must not
 * store it. The uniformity is why the body can be computed without a database
 * read, not a licence to let a proxy keep it.
 *
 * The cost of the 24h window is named rather than hidden: a tag added today can
 * take a day to appear in a client that does not revalidate. The contract
 * accepted that trade when it specified the cache.
 *
 * ## Why it is gated like the feed
 *
 * `assertNotPastDueRestricted(ctx, 'trends')` matches the sibling route. A
 * tenant that cannot read the feed has no use for its vocabulary, and an
 * ungated endpoint inside a gated family is the inconsistency somebody has to
 * re-derive later. Gated HERE rather than in `lib` for the same reason the feed
 * gives: the payload is tenant-independent, so a gate further in would have no
 * tenant to test.
 *
 * No query parameters, and deliberately no per-tag counts — a count varies with
 * the tenant and with every pull, so it cannot live in a document cached for a
 * day. The feed response is the honest home for one, since it already knows the
 * filtered set.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertNotPastDueRestricted(ctx, 'trends');

        return jsonWithETag(req, newsTagCatalogue(), {
            cacheControl: 'private, max-age=86400',
        });
    },
);
