/**
 * Channels — P9.3a (#2937). The directory, the feed, joining and posting.
 *
 * DOCUMENTED rather than baselined, because the DM surface next door is: all
 * twelve `/api/social/` paths are in the spec, and `error-codes-are-documented`
 * is what asks. A flag-gated surface is still a surface an iOS client builds
 * against, and #1087 is what an undocumented contract costs — five renamed
 * routes, a client 404ing for four days, both suites green throughout.
 *
 * ## Every operation is PERSON-scoped
 *
 * Channel policies key on `app.user_id`, which only `runInUserContext` sets.
 * There is no tenant in any of these paths and that is deliberate: a crop
 * channel spans every farm growing that crop. The one tenant-scoped piece of
 * P9.2's rule — suggesting channels from a farm's crops and oblast — is a
 * separate tenant route, because a tenant-context read of `ChannelMembership`
 * returns zero rows with no error (#1664).
 *
 * ## A 404 from these paths may mean the FLAG is off
 *
 * Every operation calls `assertFeatureEnabled('social.channels')`, which
 * answers **404** for a disabled flag — deliberately, so an unbuilt surface is
 * not advertised. So a 404 here is "no such channel" OR "channels are off for
 * you", and a client cannot tell them apart. That is the intended ambiguity;
 * it is documented so nobody debugs the wrong one.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op, codedErrorResponses } from './helpers';

const TAGS = ['Channels'];

const ChannelListItemSchema = z
    .object({
        id: z.string(),
        key: z.string().openapi({
            description:
                'The topic key — `crop:wheat`, `input:urea`, `oblast:BG-16`. The PREFIX is '
                + 'meaningful: a crop channel is suggested to a farm that grows that crop, '
                + 'while an input channel has no such join because every arable farm buys '
                + 'diesel and fertiliser, so it is offered to everybody or to nobody.',
        }),
        nameBg: z.string(),
        nameEn: z.string(),
        kind: z.string().openapi({ description: 'CROP, OBLAST or TOPIC.' }),
        memberCount: z.number().int().openapi({
            description:
                'Denormalised, and necessarily so: the membership policy admits the '
                + 'caller\'s OWN row only, so a member cannot count the others.',
        }),
        slowModeSeconds: z.number().int().openapi({
            description: 'Seconds a member must wait between posts. 0 is off.',
        }),
        joined: z.boolean(),
        banned: z.boolean().openapi({
            description:
                'Returned so a ban is not a silent refusal — a banned member sees why '
                + 'posting fails before they try.',
        }),
    })
    .openapi('ChannelListItem');

const ChannelPostSchema = z
    .object({
        id: z.string(),
        authorUserId: z.string(),
        body: z.string().openapi({
            description:
                'EMPTY when `deleted` is true. The row is kept rather than omitted so a '
                + 'reply above it does not dangle; the text is still stored, so a '
                + 'moderation removal remains restorable.',
        }),
        kind: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        deleted: z.boolean().openapi({
            description:
                'True for an author retraction, a moderator removal OR an auto-hide. The '
                + 'three are separate columns and are deliberately COLLAPSED here: telling '
                + 'a reader which one it was would disclose a moderation action to a third '
                + 'party.',
        }),
    })
    .openapi('ChannelPost');

export function registerChannelPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/social/channels',
        operationId: 'listChannels',
        summary: 'The channel directory',
        description:
            'Every open channel, busiest first, with whether the CALLER has joined. '
            + 'Readable by a NON-MEMBER, which is the departure from a conversation: P9.2 '
            + 'cannot suggest a channel nobody can read, and nobody joins one they cannot '
            + 'look into first. The gate is on POSTING, not on reading. `joined` and '
            + '`banned` come from the caller\'s own membership row — the only one the '
            + 'policy admits — so this is one query per caller rather than a lookup per '
            + 'channel.',
        tags: TAGS,
        success: {
            status: 200,
            description: 'The directory.',
            schema: z.object({ channels: z.array(ChannelListItemSchema) }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/channels/{channelId}',
        operationId: 'readChannelFeed',
        summary: 'A page of a channel\'s feed',
        description:
            'Top-level posts, newest first, readable by a non-member. `before` is a keyset '
            + 'cursor over `createdAt` and pages backwards. `hasMore` comes from a '
            + 'limit+1 probe, so nothing is filtered after the query — a post-filter would '
            + 'shrink the page and make `hasMore` wrong.',
        tags: TAGS,
        query: z.object({
            limit: z.string().optional().openapi({
                description: 'Positive integer, clamped to 100. Default 50.',
            }),
            before: z.string().optional().openapi({
                description:
                    'ISO timestamp from a previous page\'s oldest post. An unparseable '
                    + 'value is a 400, never ignored: silently returning page one reads to '
                    + 'a paging client as the end of the feed, then as duplicates.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT or INVALID_CURSOR (an unreadable `before`).',
            404: 'CHANNEL_NOT_FOUND — or the `social.channels` flag is off for this caller, which answers 404 by design and is indistinguishable from the first.',
        }),
        success: {
            status: 200,
            description: 'One page of the feed.',
            schema: z.object({
                posts: z.array(ChannelPostSchema),
                hasMore: z.boolean(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/channels/{channelId}/join',
        operationId: 'joinChannel',
        summary: 'Join a channel',
        description:
            'The person\'s OWN act, and the only way a `ChannelMembership` is ever written '
            + '— P9.2\'s rule is that channels are SUGGESTED and never joined '
            + 'automatically, held by a guard whose allowlist names exactly one file. '
            + 'Idempotent: joining twice answers 200 with `alreadyMember` rather than '
            + 'erroring, and does not double-count. A BANNED member rejoining stays '
            + 'banned — the membership row survives a ban precisely so a rejoin cannot '
            + 'escape it.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            400: 'CHANNEL_ARCHIVED — the channel is closed and accepts no new members.',
            404: 'CHANNEL_NOT_FOUND, or the flag is off (see the note on this tag).',
        }),
        success: {
            status: 201,
            description: 'Joined. 200 instead of 201 when already a member.',
            schema: z.object({ joined: z.boolean(), alreadyMember: z.boolean() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/social/channels/{channelId}/join',
        operationId: 'leaveChannel',
        summary: 'Leave a channel',
        description:
            'Idempotent: leaving something you are not in is not an error. Reporting one '
            + 'would tell a caller whether a membership exists, which is not theirs to '
            + 'know.',
        tags: TAGS,
        success: {
            status: 200,
            description: 'Left, or was never a member.',
            schema: z.object({ left: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/channels/{channelId}/posts',
        operationId: 'postToChannel',
        summary: 'Post to a channel',
        description:
            'Requires membership. The three access rules — the author is the session, a '
            + 'membership row exists, that row is not banned — are enforced by the '
            + 'DATABASE in `channel_post_insert`\'s WITH CHECK, not only by the usecase, '
            + 'because the usecase is the layer a refactor removes. The usecase reads '
            + 'membership first so the refusal carries a CODE rather than arriving as a '
            + 'Prisma error.\n\n'
            + 'Slow mode is enforced in the usecase and cannot be in SQL: it compares '
            + 'against other rows of the same table, which is the shape a policy on that '
            + 'table cannot query. It is a THROTTLE, so two concurrent posts may both '
            + 'pass — acceptable for a rate limit and not for an access rule, which is '
            + 'why the access rules are in the WITH CHECK and this is not.',
        tags: TAGS,
        body: z.object({ body: z.string().min(1).max(8000) }),
        extraResponses: codedErrorResponses({
            400: 'CHANNEL_POST_REQUIRED (empty AFTER sanitising — a body of only markup sanitises to nothing), CHANNEL_POST_TOO_LONG, CHANNEL_ARCHIVED, or CHANNEL_SLOW_MODE with `waitSeconds` in the details.',
            403: 'CHANNEL_NOT_A_MEMBER or CHANNEL_BANNED.',
            404: 'CHANNEL_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 201,
            description: 'The post.',
            schema: z.object({ postId: z.string(), createdAt: z.string().datetime({ offset: true }) }),
        },
    });
}
