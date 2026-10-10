/**
 * GET / PUT /api/me/news-preferences — the reader's own Новини tag opt-ins.
 *
 * §4 of the tags-and-preferences contract. Under `/api/me/`, not
 * `/api/t/{tenantSlug}/`, and that is a decision rather than a coin flip: a
 * news preference is a property of the PERSON, not of a farm. The same person
 * reading the same global feed from two farms wants the same tags, and putting
 * this under a tenant would invite exactly the bug where switching farms
 * silently changes your feed.
 *
 * ## The server stores; the CLIENT applies
 *
 * Nothing here filters the feed. `getMarketNews` caches its payload under a key
 * shared by every reader, so a server that applied the caller's own preferences
 * would write one person's filtered feed into the entry everybody else reads —
 * everyone would see the first reader's choices until the hour expired, and
 * nothing would error. So the preference is shared state that clients resolve
 * and pass back as `?tags=`, which also gives the owner's requirement (the same
 * opt-ins on web and every phone) without the feed losing its cache.
 *
 * ## Reject unknown on write, ignore unknown on read
 *
 * `PUT` 400s on a tag outside the catalogue; `GET` silently drops one. Those
 * answer different questions about who chose the value — a `PUT` is a person
 * choosing, where a typo is a client bug worth surfacing, while a stored list
 * is state the server itself issued and may since have renamed. The asymmetry
 * with `?tags=` on the feed (which also ignores) is the same reasoning: that
 * parameter is a pass-through of this stored state.
 *
 * ## `getUserCtx`, not `auth()`
 *
 * This is the first API route to use it, which is worth saying plainly: the
 * helper has been complete and tested since P1.5 with no route call sites, so
 * every person-scoped route in the product authenticates with bare `auth()` and
 * therefore skips three refusals this one gets — an `iflk_` API key presented
 * as a person credential (a category error that would otherwise be answered as
 * the cookie's user), an MFA-pending session, and the operator-only persona.
 * `/api/me/farms` and the `/api/account/**` family should follow; that is a
 * separate change and is filed rather than done here.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import {
    NewsPreferencesBodySchema,
    readOwnNewsPreferences,
    writeOwnNewsPreferences,
} from '@/lib/news/preferences';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    const tags = await readOwnNewsPreferences(ctx.userId);
    // `null` is a real answer and is NOT collapsed to `[]`. Both show the full
    // feed, so the difference does not affect filtering — it tells the client
    // whether it may prompt, which a new reader wants and someone who
    // deliberately cleared their choices does not.
    return jsonResponse({ tags }, { status: 200 });
});

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);

    const body = await req.json().catch(() => null);
    const parsed = NewsPreferencesBodySchema.safeParse(body);
    if (!parsed.success) {
        // A CODE plus the zod message, which names the offending tags. The code
        // is what a client can translate; the message is what makes a client
        // bug diagnosable without diffing against the catalogue.
        throw codedBadRequest(
            'INVALID_NEWS_PREFERENCES',
            parsed.error.issues.map((i) => i.message).join('; '),
        );
    }

    const tags = await writeOwnNewsPreferences(ctx.userId, parsed.data.tags);
    return jsonResponse({ tags }, { status: 200 });
});
