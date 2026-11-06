/**
 * One public farm profile, by handle — the JSON behind `/f/{handle}` (#2774).
 *
 *   GET /api/public/farms/{handle}
 *
 * Built for `agrent-ios` #538, the native farm-profile screen, which reaches
 * the same projection the server-rendered page reads. The page and this route
 * share `readPublicFarmProfile`, so they cannot disagree about what a published
 * profile contains.
 *
 * ## The Edge entry is half the change, and the route would 401 without it
 *
 * `/api/public/farms` was an EXACT entry in `PUBLIC_PATH_EXACT`, and its own
 * docblock says a prefix was avoided because "a prefix would have opened
 * anything added beneath it later". This route IS the thing added beneath it,
 * so the exact entry stays (for the bare list path) and
 * `'/api/public/farms/'` joins the PREFIX list for children. Measured against
 * the live predicate before writing a line of this file:
 *
 *     OPEN   /api/public/farms
 *     GATED  /api/public/farms/pobeda        <- this route, before the entry
 *     GATED  /api/public/farmsomething       <- still gated, and that is the point
 *
 * The third line is what makes the prefix safe: `matchesPublicPrefix`
 * segment-bounds, so a sibling cannot be opened by accident. The widening that
 * remains — every FUTURE child of `/api/public/farms/` is Edge-open — is
 * covered by `public-routes-self-authenticate`, which requires each anonymous
 * handler to be deliberately so. Two halves, as #1745 argues: one list decides
 * what the Edge admits, the other decides whether the handler meant it.
 *
 * ## URLs, not hashes, and that was agrent-ios' own call
 *
 * `logoUrl` / `photoUrls` are root-relative `/api/public/media/{hash}` paths.
 * The phone asked for bare hashes when this was specified; the shape it is
 * getting is the one it argued for itself on 2026-10-20 — the server owns the
 * path, so correcting it never needs a client release, and the phone already
 * follows a server-given root-relative path for `/me`'s `avatarUrl`. The hash
 * is recoverable from the URL, and two spellings of one fact is what this
 * codebase keeps refusing.
 *
 * ## `indexable` and `projectedAt` are deliberately NOT exposed
 *
 * `indexable` drives robots and the sitemap — an SEO concern, not a client one.
 * `projectedAt` would be a second caching mechanism beside the ETag. Both are
 * on the view and both stop here.
 *
 * ## ONE shape for every negative, mirroring the media route
 *
 * A malformed handle, a farm that never existed and one that withdrew its
 * profile all answer the SAME 404 body. The projection holds a row only while
 * a farm is published — withdrawal DELETES it rather than flagging it — so
 * "not published" and "never existed" are one absence with no second branch
 * that could drift. An unguessable handle stops being unguessable the moment
 * something confirms a guess.
 */
import { NextRequest } from 'next/server';

import { readPublicFarmProfile } from '@/app-layer/usecases/public-farm-profile';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';

export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    async (req: NextRequest, ctx: { params: Promise<{ handle: string }> }): Promise<Response> => {
        // Anonymous surface, so a null user. `assertFeatureEnabled` 404s rather
        // than 403s, which keeps a dark-launched endpoint undiscoverable — the
        // same reason `/api/public/farms` and the media route give.
        await assertFeatureEnabled('social.public-profile', null);

        const { handle } = await ctx.params;
        const profile = await readPublicFarmProfile(handle);

        if (!profile) {
            return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });
        }

        // The projection IS the allowlisted shape — a hidden field is already
        // null or [] in the row, so nothing is filtered a second time here and
        // there is no flag travelling alongside a withheld value.
        return jsonWithETag(req, {
            handle: profile.handle,
            displayName: profile.displayName,
            tagline: profile.tagline,
            about: profile.about,
            oblast: profile.oblast,
            crops: profile.crops,
            logoUrl: profile.logoUrl,
            photoUrls: profile.photoUrls,
        });
    },
);
