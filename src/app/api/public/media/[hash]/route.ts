/**
 * P6.3 — the bytes of an image a published farm profile references.
 *
 *   GET /api/public/media/{hash}
 *
 * ## The hash is in the PATH, and that is not a style choice
 *
 * #1812 asks for it explicitly, and the reason is the phone: iOS logs the FULL
 * request URL including the query string, unsuppressably, so an identifier in
 * `?hash=` lands in device logs that outlive the request. A path segment does
 * not. Anything that later "simplifies" this to a query parameter reintroduces
 * that, which is why the constraint is written here rather than in a commit
 * message.
 *
 * ## Public by construction, authenticating nothing
 *
 * There is no credential to verify: a stranger reading a farm's page has no
 * account. `/api/public/media/` is a PREFIX entry in `PUBLIC_PATH_PREFIXES`
 * and cannot be an exact one, because the hash is part of the path and there
 * is no finite set of paths to list.
 *
 * Two different things are often collapsed here, so both are stated.
 *
 * Only a CHILD path can tell a prefix entry from an exact one; a sibling
 * cannot. That is why the reachability test probes
 * `/api/public/media/<hash>` — had this been filed in `PUBLIC_PATH_EXACT` by
 * mistake, every image would 401 and only a child request would show it.
 *
 * The trailing slash is a separate matter, and does LESS here than the usual
 * telling suggests: `matchesPublicPrefix` segment-bounds a bare entry already
 * (#1770), so `/api/public/mediaX` stays gated either way. The slash decides
 * only whether the BARE `/api/public/media` is public, and it keeps it gated.
 * Where the slash does carry the sibling property is `publicMediaRateLimit`,
 * which matches with a plain `startsWith`. Both halves are mutation-proved,
 * each in its own file's test.
 *
 * ## A prefix opens every METHOD, so only GET exists here
 *
 * `isPublicPath` does not discriminate by method, so this subtree is
 * unauthenticated for POST and DELETE too. Exporting only `GET` is what makes
 * those 405 rather than reaching a handler, and it is the whole defence — so
 * the route must never grow a mutating export without a different gate.
 *
 * ## Immutable, because the name IS the content
 *
 * One sha256 names exactly one byte sequence, forever, so a response can be
 * cached indefinitely with no invalidation story. The ETag is the hash itself
 * rather than a size-mtime validator: content-addressed, so it is a STRONG
 * validator by construction — which `/api/account/avatar/[userId]` explicitly
 * says it cannot offer, because nothing persisted a hash there.
 *
 * Changing an image therefore changes the URL. That is the point: a farm that
 * replaces its logo gets a new hash, the page references the new one, and no
 * cache anywhere has to be told.
 *
 * ## Rate limited by its own tier
 *
 * `/f/` sits in the 60/min public-read tier, and its own comment says that
 * works because "page ASSETS do not count against the budget: they are served
 * from `/_next/static/*`". Serving images through an API route makes them
 * count. One farm page is a logo plus a few photos, so a flat 60/min would
 * let a visitor browse about eight farms a minute before images began
 * failing — silently, since a broken image reports nothing. Hence
 * `publicMediaRateLimit` and its own budget; owner ruling 2026-10-17.
 */
import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';

import { resolvePublicMedia } from '@/app-layer/usecases/public-farm-media';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonResponse } from '@/lib/api-response';

export const runtime = 'nodejs';

/** A year. The response is immutable, so this is a ceiling rather than a TTL. */
const ONE_YEAR_SECONDS = 31_536_000;

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        ctx: { params: Promise<{ hash: string }> },
    ): Promise<Response> => {
        // Anonymous surface, so a null user. `assertFeatureEnabled` 404s
        // rather than 403s, which keeps a dark-launched endpoint
        // undiscoverable — the same reason `/api/public/farms` gives.
        await assertFeatureEnabled('social.farm-media', null);

        const { hash } = await ctx.params;
        const object = await resolvePublicMedia(hash);

        // ONE shape for every negative case — malformed hash, not published,
        // no stored file, quarantined by the scan gate. Distinguishing them
        // would let an anonymous caller use the response to learn which hashes
        // exist, and an unguessable identifier stops being unguessable once
        // something confirms a guess.
        if (!object) {
            return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });
        }

        const headers = {
            'Content-Type': object.mimeType,
            'Content-Length': String(object.sizeBytes),
            'Cache-Control': `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
            // The hash, quoted. A strong validator with no bookkeeping: the
            // name and the content cannot disagree.
            ETag: `"${object.hash}"`,
            // The bytes are user-supplied. `Content-Type` comes from the
            // sniffed type recorded at upload, but a browser that sniffs for
            // itself could still be talked into treating an image as a
            // document, so say no.
            'X-Content-Type-Options': 'nosniff',
            // Nothing here is a document, and this costs nothing to state.
            'Content-Disposition': 'inline',
        };

        // A conditional request that still matches costs no body. Parsed
        // rather than compared, because a cache may send a LIST or a weak
        // validator (`W/"…"`) even though neither shape is produced here —
        // the avatar route records the same reasoning.
        const inm = req.headers.get('if-none-match');
        if (inm !== null) {
            const matches = inm
                .split(',')
                .map((candidate) => candidate.trim().replace(/^W\//, ''))
                .some((candidate) => candidate === `"${object.hash}"` || candidate === '*');
            if (matches) {
                // Opened to answer this request and nothing will read it.
                object.stream.destroy();
                return new Response(null, { status: 304, headers });
            }
        }

        return new Response(
            Readable.toWeb(object.stream) as unknown as ReadableStream,
            { status: 200, headers },
        );
    },
);
