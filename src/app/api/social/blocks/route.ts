/**
 * `POST   /api/social/blocks` — block a person.
 * `DELETE /api/social/blocks` — lift a block.
 * `GET    /api/social/blocks` — the people you have blocked (P5.2b, #1593).
 *
 * ## Gated, unlike the reporting routes next door
 *
 * This is the seam P5.2 was split along. Filing a notice is a DSA Art 16 LEGAL
 * DUTY and cannot be dark-launched, so `/api/social/reports` is in
 * `FLAG_EXEMPT`. Blocking is an Apple 1.2 requirement and a product feature,
 * so it gates on `social.person-blocks` and 404s while the flag is off.
 *
 * The key is written as a STRING LITERAL at each of the three call sites, not
 * hoisted to a `const`. `social-routes-flag-gated` extracts gate keys from
 * LITERAL arguments only, and its reason is the operator's: somebody holding
 * the flag console has to be able to find the flag that gates a route by
 * reading the route. Its own mutation proof found the hole that makes this
 * strict — an interpolated template contains no quote character, so a
 * quotes-only matcher read a COMPUTED key as a literal one.
 *
 * Repeating it three times is the cost. A `const` in the same file would be
 * findable by a human and is not findable by the guard, and the guard is
 * right to prefer the form that cannot be made indirect later.
 *
 * ## DELETE takes a body, which is unusual and deliberate
 *
 * The alternative is `DELETE /api/social/blocks/[blockedUserId]`, which puts a
 * person's id in the URL — and `CFNetwork` logs the full URL including the
 * path on iOS, unsuppressably. P5.7 calls these routes. A third party's user id
 * in a device log is exactly the disclosure this phase exists to prevent, so
 * the id travels in the body where it is not logged.
 *
 * ## Every refusal here is the BLOCKER's own action
 *
 * Nothing on these routes can be reached by the person being blocked, so the
 * errors may be explicit: `BLOCK_SELF` on blocking yourself, 404 on lifting a
 * block that is not yours. The silence the owner ruled for applies to the
 * ENFORCEMENT paths in `exchange-messaging.ts`, not here — concealing a
 * person's own block from themselves would be concealing their own decision.
 *
 * ## A refused DELETE does not raise, so 404 comes from a COUNT
 *
 * Under RLS a DELETE whose policy is unsatisfied affects zero rows and returns
 * normally. `unblockPerson` therefore reports the count, and zero becomes a
 * 404 — otherwise lifting somebody else's block would answer 200 and the
 * client would show it as done.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedNotFound } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { PersonBlockSchema } from '@/lib/schemas';
import { blockPerson, unblockPerson, listOwnBlocks } from '@/app-layer/usecases/person-blocks';

async function body(req: NextRequest): Promise<{ blockedUserId: string } | null> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return null;
    }
    const parsed = PersonBlockSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('social.person-blocks', ctx.userId);

    const input = await body(req);
    if (!input) return jsonResponse({ error: 'invalid_request' }, { status: 400 });

    const result = await blockPerson(ctx, input.blockedUserId);
    // 200 rather than 201 even on the first block: the resource is the
    // RELATIONSHIP, and `alreadyBlocked` is what tells a client whether
    // anything changed. A 201/200 split would make an idempotent action look
    // like two different outcomes to a cache.
    return jsonResponse(result, { status: 200 });
});

export const DELETE = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('social.person-blocks', ctx.userId);

    const input = await body(req);
    if (!input) return jsonResponse({ error: 'invalid_request' }, { status: 400 });

    const { removed } = await unblockPerson(ctx, input.blockedUserId);
    if (removed === 0) {
        // Zero means "no such block of yours" — either it never existed or it
        // is somebody else's row, which the DELETE policy refused silently.
        // Both are a 404 to this caller, and deliberately indistinguishable:
        // telling them apart would reveal that A has blocked B to anyone who
        // can guess the pair.
        throw codedNotFound('BLOCK_NOT_FOUND', 'You have no block on that person.');
    }
    return jsonResponse({ blocked: false }, { status: 200 });
});

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('social.person-blocks', ctx.userId);

    // Only the blocks this person MADE. The SELECT policy admits both sides of
    // a row — it must, because enforcement runs in the blocked party's context
    // — so `listOwnBlocks` filters, and that filter is the product half of
    // "never reveal a block to the blocked party".
    const blocks = await listOwnBlocks(ctx);
    return jsonResponse({ blocks }, { status: 200 });
});
