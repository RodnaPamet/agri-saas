/**
 * `GET /api/library/books/{slug}` — one book, whole (#2980).
 *
 * The siblings' reasoning applies unchanged: non-tenant so it reaches every
 * role, signed-in rather than public, flag key as a literal. See
 * `../route.ts`.
 *
 * ## The slug is in the PATH, and that is safe here
 *
 * #1087's rule is that iOS logs the full URL including the query,
 * unsuppressably, so a third party's identifier must not travel in one — which
 * is why `DELETE /api/social/blocks` takes a body. A book slug identifies a
 * PUBLISHED public-domain text and nobody's person, so there is nothing to
 * disclose: it is the one case where a path parameter is the right shape.
 *
 * ## ETag, and this is the read it was asked for
 *
 * #2980 §3(b). The body is the whole book — ~7,500 words for the first one —
 * and it changes only when `version` is bumped. So `If-None-Match` turns a
 * revalidation into a 304 and the phone keeps the text it already has. A
 * per-chapter route would have made that thirteen round trips.
 *
 * ## An unpublished slug answers the SAME 404 as a nonexistent one
 *
 * `readBook` filters in the query and raises `BOOK_NOT_FOUND` for both. A
 * distinct code would confirm that a book exists and is merely withheld, which
 * is an oracle over exactly what the owner's review protects — and a slug is
 * guessable from a title.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonWithETag } from '@/lib/http/etag';
import { readBook } from '@/app-layer/usecases/library';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
        const ctx = await getUserCtx(req);
        await assertFeatureEnabled('library.enabled', ctx.userId);

        // `await`ed, the Next 16 contract — `async-params-route-typing` holds
        // every dynamic route to the Promise shape.
        const { slug } = await params;
        const book = await readBook(ctx, slug);
        return jsonWithETag(req, book);
    },
);
