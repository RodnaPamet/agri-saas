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
 * P9.2's rule — suggesting channels from a farm\'s crops and oblast — is a
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

const PersonProfileSchema = z
    .object({
        displayName: z.string().nullable().openapi({
            description:
                'Null when there is nothing a channel would show. Reported as absent '
                + 'unless it would actually RENDER — a caller deciding whether to prompt '
                + 'must not be told a name exists while the feed shows the farm alone.',
        }),
        published: z.boolean().openapi({
            description:
                'Whether the profile is published. Reported alongside the name so a '
                + 'client can tell "never set one" from "set one and withdrew it", which '
                + '`displayName` alone collapses.',
        }),
    })
    .openapi('PersonProfile');

const SetDisplayNameSchema = z
    .object({
        displayName: z.string().nullable().openapi({
            description:
                'The new name, or null to clear it. Nullable rather than optional so '
                + '"remove my name" is expressible: an absent key and an explicit null '
                + 'would otherwise be indistinguishable.',
        }),
    })
    .openapi('SetDisplayName');

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
        resolvedAt: z.string().datetime({ offset: true }).nullable().openapi({
            description:
                'When a «Въпрос» was marked «Решено», else null — always null on a `POST` '
                + 'or a `CARD`, which cannot carry the state. Added by #2961: the column '
                + 'had been written since P9.3b and returned by nothing, so a resolved '
                + 'question was indistinguishable from an open one through every read '
                + 'path and no client could render it.',
        }),
        author: z
            .object({
                displayName: z.string().nullable(),
                farmName: z.string().nullable(),
                farmHandle: z.string().nullable(),
            })
            .nullable()
            .openapi({
                description:
                    'Who wrote it — «Иван Петров, ЗК Победа» (#2989). NULL on a deleted '
                    + 'post: the body is already empty, and naming somebody above content '
                    + 'nobody can read attributes an accusation to them. Both halves are '
                    + 'independently null and all four states are normal. `displayName` is '
                    + 'null until the person has set one AND published it, which is why '
                    + '`PUT /api/social/profile` exists; the fallback is the FARM ALONE, '
                    + 'never an id or a placeholder. `farmName` is null when the post '
                    + 'recorded no farm — a post predating the column, one whose author '
                    + 'sent no `tenantSlug`, or an author in no farm. Clients render '
                    + 'whichever half exists and show nothing when neither does; '
                    + '`authorUserId` stays beside this so a reply or a report has a '
                    + 'stable key with no name to show. '
                    + '`farmHandle` (#3043) is the handle of the farm the author posted '
                    + 'AS, present only where that farm has a PUBLISHED page — it is what '
                    + 'makes a direct message startable from a post, since the open route '
                    + 'takes a handle. It is NOT an address for the AUTHOR: a DM to a farm '
                    + 'reaches that farm\'s ACTIVE OWNER, who may be somebody else '
                    + 'entirely, so a client offering it should word the control so it '
                    + 'does not promise otherwise. It lives INSIDE this object on purpose, '
                    + 'so a hidden post offers no handle either — a handle beside a '
                    + 'suppressed author would let a client offer to message somebody '
                    + 'about content nobody can read. Decided by the same authority the '
                    + 'exchange uses to attribute a listing, so the two surfaces cannot '
                    + 'disagree about whether a farm is publicly reachable.',
            }),
        replyCount: z.number().int().openapi({
            description:
                'How many replies hang off this post, so a feed can show that a thread '
                + 'exists without a request per post. Always 0 on a reply, since threads '
                + 'are one level deep. It counts HIDDEN replies too, matching how a '
                + 'hidden post is reported rather than omitted — a count that shrank when '
                + 'a moderator hid one reply would tell every reader that something had '
                + 'been removed.',
        }),
    })
    .openapi('ChannelPost');

export function registerChannelPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/social/profile',
        operationId: 'readOwnPersonProfile',
        summary: 'The caller\'s own display name',
        description:
            'The SIGNAL a client prompts from (#2989): `displayName` is null when there '
            + 'is nothing a channel would show — no row, no name, or a name that is not '
            + 'published — so a composer can ask once before the first post. Those three '
            + 'states answer identically on purpose, because they mean the same thing to '
            + 'a reader of a channel. Gated on `social.channels` rather than a flag of '
            + 'its own, so the entry point cannot be dark while the feature that needs '
            + 'it is live.',
        tags: TAGS,
        success: {
            status: 200,
            description: 'The caller\'s own profile, or the empty state.',
            schema: PersonProfileSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/social/profile',
        operationId: 'setOwnDisplayName',
        summary: 'Set or clear the caller\'s display name',
        description:
            'Setting a name PUBLISHES it, and that is the design rather than a shortcut: '
            + '`PersonProfile.published` defaults false, so a writer that set the name and '
            + 'left the flag alone would change nothing visible and the person would never '
            + 'learn why. The act of giving a name is therefore the opt-in, and the copy '
            + 'at the call site says so — «Името Ви ще се вижда от други стопанства». '
            + 'Sending `null` or a blank string clears the name AND unpublishes, which is '
            + 'the honest inverse: somebody removing their name is asking not to be named. '
            + 'The name is sanitised and then capped at 60 characters, in that order, so '
            + 'markup cannot pass the cap and be stripped to something shorter afterwards.',
        tags: TAGS,
        // `body` is the Zod schema itself — the helper owns the media type and
        // the description. Passing `{ description, schema }` typechecks only
        // on a WARM tsc; the cold run named it.
        body: SetDisplayNameSchema,
        success: {
            status: 200,
            description: 'The profile as stored.',
            schema: PersonProfileSchema,
        },
        extraResponses: codedErrorResponses({
            400: 'DISPLAY_NAME_TOO_LONG — longer than 60 characters once markup is stripped; or INVALID_BODY.',
        }),
    });

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
        path: '/api/social/channels/{channelId}/mute',
        operationId: 'muteChannel',
        summary: 'Mute a channel',
        description:
            'Stops the mention and reply PUSH for this caller in this channel. '
            + '`ChannelMembership.mutedAt` has been honoured since #2987 — '
            + '`reachableTargets` filters on it for every mention and reply — and was '
            + 'writable by nobody until #3042, so a mute control would have done nothing '
            + 'while looking exactly like a working one. '
            + 'IDEMPOTENT, and muting an already-muted channel does NOT re-stamp '
            + '`mutedAt`: that moment is when the person chose silence, so the response '
            + 'carries the STORED value rather than the request\'s. '
            + 'It takes effect on the NEXT post and is not retroactive — a push already '
            + 'enqueued is not withdrawn, because re-checking the mute inside the job '
            + 'would let a mute at 23:59 silently cancel a notification somebody was '
            + 'already being told about. '
            + 'The mention ROW is still written for a muted member: a mention records '
            + 'being NAMED, a mute is a statement about being INTERRUPTED, and the Art 15 '
            + 'export reads those rows.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CHANNEL_NOT_JOINED — not a member, so there is no membership row to '
                + 'mute. Shared with the read cursor and deliberately NOT '
                + '`CHANNEL_NOT_A_MEMBER`, whose sentence is about posting. Also 404 when '
                + 'the `social.channels` flag is off for this caller.',
        }),
        success: {
            status: 200,
            description: 'Muted. `mutedAt` is the stored moment, not necessarily now.',
            schema: z.object({ muted: z.boolean(), mutedAt: z.string().nullable() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/social/channels/{channelId}/mute',
        operationId: 'unmuteChannel',
        summary: 'Unmute a channel',
        description:
            'Clears `mutedAt` to NULL and KEEPS the membership row — deleting the row to '
            + 'unmute would discard `lastReadAt` and `joinedAt` with it, which is P9.5\'s '
            + '"leaving is not lossless" reached by accident rather than by a Leave '
            + 'button. Idempotent: unmuting something that is not muted is not an error.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CHANNEL_NOT_JOINED, or the flag is off (see the note on this tag).',
        }),
        success: {
            status: 200,
            description: 'Unmuted, or was never muted.',
            schema: z.object({ muted: z.boolean(), mutedAt: z.string().nullable() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/channels/{channelId}/read',
        operationId: 'markChannelRead',
        summary: 'Move the read cursor to now',
        description:
            'The caller\'s own act on their own membership row — and the write '
            + '`channel_membership_update` was created for, which until #2990 was an RLS '
            + 'policy whose only stated justification was a write nobody had built. '
            + 'Takes NO body: a client-supplied timestamp would let a phone with a wrong '
            + 'clock park the cursor in the future and silently suppress every later '
            + 'post, which is a badge that never comes back rather than one that is '
            + 'merely wrong. '
            + 'The cursor moves FORWARD ONLY. Sending an older moment is not an error '
            + 'and is not a no-op either: the response reports the STORED cursor rather '
            + 'than echoing what was sent, which is how a stale client learns the real '
            + 'value instead of being told its own number back. '
            + 'POST rather than PUT because it is not idempotent in the sense PUT '
            + 'promises — the value is "now", so calling twice leaves a later cursor '
            + 'than calling once.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CHANNEL_NOT_JOINED — the caller is not a member, so there is nothing to '
                + 'mark. Deliberately NOT `CHANNEL_NOT_A_MEMBER`, which is the POSTING '
                + 'refusal and whose message says "join before posting in it" — the '
                + 'wrong sentence on a read cursor. Also 404 when the '
                + '`social.channels` flag is off for this caller, which is '
                + 'indistinguishable by design.',
        }),
        success: {
            status: 200,
            description:
                'The cursor as STORED, which equals the request moment unless an older '
                + 'one was sent.',
            schema: z.object({ lastReadAt: z.string() }),
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
        body: z.object({
            body: z.string().min(1).max(8000),
            mentionUserIds: z.array(z.string()).max(5).optional().openapi({
                description:
                    'EXPLICIT user ids, at most five — never parsed from the body, because '
                    + 'there is no person handle in this product: `PersonProfile` has '
                    + '`userId` and `displayName` and no handle, and the DM surface resolves '
                    + 'a FARM handle to that farm\'s owner. A mention must name a MEMBER of '
                    + 'the channel; a non-member (or yourself) is silently DROPPED rather '
                    + 'than refused, so a stale picker does not fail the whole post. '
                    + '`mentionsRecorded` says how many were kept.',
            }),
            kind: z.enum(['POST', 'QUESTION']).optional().openapi({
                description:
                    '«Публикация» or «Въпрос». `CARD` is a THIRD member of the enum and '
                    + 'is deliberately not accepted: a card is machine-written by the '
                    + 'platform queue, so taking one from a caller would let any member '
                    + 'forge a post that renders as the platform\'s own data.',
            }),
            tenantSlug: z.string().optional().openapi({
                description:
                    'The farm to post AS (#2989), recorded at write time so a person who '
                    + 'later leaves that farm does not have their past posts relabelled. '
                    + 'SUPPLIED rather than read from the path, because these routes are '
                    + 'person-scoped and carry no slug — the PAGE is at `/t/{slug}/channels`, '
                    + 'the API is not. An ACTIVE membership is required; an ABSENT value '
                    + 'records no farm and the author line shows the name alone, which is '
                    + 'preferred to guessing from the caller\'s memberships.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'CHANNEL_POST_REQUIRED (empty AFTER sanitising — a body of only markup sanitises to nothing), CHANNEL_POST_TOO_LONG, CHANNEL_ARCHIVED, or CHANNEL_SLOW_MODE with `waitSeconds` in the details.',
            403: 'CHANNEL_NOT_A_MEMBER or CHANNEL_BANNED; or NOT_A_MEMBER_OF_THAT_FARM when `tenantSlug` names a farm the caller is not an ACTIVE member of (#2989). That last one covers "no such farm" as well, deliberately — two codes would make this an enumeration oracle for farm slugs.',
            404: 'CHANNEL_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 201,
            description: 'The post.',
            schema: z.object({
                postId: z.string(),
                createdAt: z.string().datetime({ offset: true }),
                mentionsRecorded: z.number().int(),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/channel-posts/{postId}',
        operationId: 'readChannelPost',
        summary: 'One post, by its own id — the permalink read',
        description:
            'Added by #3030 for the permalink page, and it did not already exist: the '
            + 'feed returns TOP-LEVEL posts for a channel and `…/replies` reads the '
            + 'parent only to VALIDATE it, returning the replies alone. Nothing returned '
            + 'a single post, which is exactly what a permalink is.\n\n'
            + 'A REMOVED post answers 200 with the collapse applied — present, empty '
            + 'body, no author — rather than 404. The link may be sitting in somebody\'s '
            + 'push notification from before the removal, and "that never existed" is a '
            + 'different statement from "that is gone". The row\'s existence is not the '
            + 'secret; its content is, and the collapse is what withholds it.\n\n'
            + 'A REPLY is readable by its own id, unlike `…/replies`, which refuses a '
            + 'reply as a parent because threads are one level deep. A push for a reply '
            + 'names the REPLY, so a permalink to one is a legitimate thing to hold, and '
            + '`parentPostId` is returned so a client can offer the parent for context.\n\n'
            + 'Readable by a NON-MEMBER, exactly as the feed and the thread are: '
            + '`channel_post_select` admits any authenticated caller. That is also why a '
            + 'null row is reported as NOT FOUND rather than forbidden — it is a genuinely '
            + 'absent row, never a policy refusal.\n\n'
            + 'No ETag, unlike the library reads: a post\'s reply count and its removal '
            + 'state both change, and a channel is the surface a farmer refreshes rather '
            + 'than one they carry offline.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CHANNEL_POST_NOT_FOUND — no such post, or the flag is off.',
        }),
        success: {
            status: 200,
            description:
                'The post, the channel it belongs to, and its parent when it is a reply.',
            schema: z.object({
                post: ChannelPostSchema,
                channelId: z.string(),
                parentPostId: z.string().nullable().openapi({
                    description:
                        'NULL for a top-level post. Set when the permalink names a reply, '
                        + 'which is the only thing a client can link UP by.',
                }),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/channel-posts/{postId}/replies',
        operationId: 'readChannelPostReplies',
        summary: 'A page of one post\'s replies',
        description:
            'Added by #2961, which is the defect: `replyToChannelPost` had shipped with '
            + 'NO reader. The feed filters `parentPostId: null` — correctly, since one '
            + 'row cannot be both a reply and a top-level post — and nothing else '
            + 'returned a reply, so a reply went into a row no read path served. The only '
            + 'escape was `alsoToChannel`, which writes a second top-level row.\n\n'
            + 'OLDEST first, and `after` rather than `before`: a thread is a conversation '
            + 'and the answers only make sense in the order they were given, while a feed '
            + 'is read newest-first because the reader wants what is new. The parameter is '
            + 'named differently from the feed\'s on purpose, so a cursor cannot be pasted '
            + 'from one into the other.\n\n'
            + 'Readable by a NON-MEMBER, exactly as the feed is: `channel_post_select` '
            + 'admits any authenticated caller, so a narrower rule here would be a second '
            + 'and disagreeing answer to one question, and a wider one is not available.\n\n'
            + 'A HIDDEN parent still serves its thread. The feed already shows a hidden '
            + 'post as `deleted` rather than omitting it, precisely so its replies do not '
            + 'dangle, and withholding the thread would let the moderation of one post '
            + 'silently remove other people\'s words. Each reply is collapsed by the same '
            + 'rule as a feed post, so an auto-hidden reply comes back empty rather than '
            + 'serving text the moderation path took down.',
        tags: TAGS,
        query: z.object({
            limit: z.string().optional().openapi({
                description: 'Positive integer, clamped to 100. Default 50.',
            }),
            after: z.string().optional().openapi({
                description:
                    'ISO timestamp from the previous page\'s NEWEST reply. An unparseable '
                    + 'value is a 400, never ignored.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT, INVALID_CURSOR (an unreadable `after`), or CHANNEL_POST_IS_A_REPLY — asking for a reply\'s own thread, which is a caller error rather than an empty page, because the two are different facts and only one is fixable.',
            404: 'CHANNEL_POST_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 200,
            description: 'One page of the thread, oldest first.',
            schema: z.object({
                replies: z.array(ChannelPostSchema),
                hasMore: z.boolean(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/channel-posts/{postId}/replies',
        operationId: 'replyToChannelPost',
        summary: 'Reply to a post, optionally also posting it to the channel',
        description:
            'Addressed by the POST id, not `/channels/{channelId}/posts/{postId}` — the '
            + 'channel is derived from the parent row, so a channel id in the path would '
            + 'be redundant and could DISAGREE with it, and then one of the two wins '
            + 'silently.\n\n'
            + '`alsoToChannel` («Също изпрати в канала») writes a SECOND, top-level row '
            + 'rather than setting a flag: the feed filters `parentPostId: null`, so one '
            + 'row cannot be both a reply and a top-level post. Both rows are written in '
            + 'one transaction, and the two are independently moderatable — removing the '
            + 'channel copy does not remove the reply from its thread.\n\n'
            + 'Mentions are recorded on the REPLY only; recording them on the copy too '
            + 'would push twice for one act.\n\n'
            + 'Threads are ONE level deep. Replying to a reply is refused rather than '
            + 'nested, because the feed\'s top-level filter would hide an arbitrarily deep '
            + 'tree and the timeline this renders into flattens to a row list.\n\n'
            + 'A reply IS a post, so slow mode applies — otherwise the way round a '
            + 'throttle is to reply to anything rather than post.',
        tags: TAGS,
        body: z.object({
            body: z.string().min(1).max(8000),
            alsoToChannel: z.boolean().optional(),
            mentionUserIds: z.array(z.string()).max(5).optional(),
            tenantSlug: z.string().optional().openapi({
                description:
                    'The farm to reply AS (#2989) — see `postToChannel`. Recorded at '
                    + 'write time on BOTH rows a reply can produce, the reply and its '
                    + '«Също изпрати в канала» copy, resolved once so the two cannot '
                    + 'disagree about which farm sent them.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'CHANNEL_POST_REQUIRED, CHANNEL_POST_TOO_LONG, CHANNEL_ARCHIVED, CHANNEL_SLOW_MODE, CHANNEL_TOO_MANY_MENTIONS, CHANNEL_THREAD_TOO_DEEP (replying to a reply) or CHANNEL_POST_DELETED (the parent was retracted, so a reply would render beneath «изтрито» with no context).',
            403: 'CHANNEL_NOT_A_MEMBER or CHANNEL_BANNED; or NOT_A_MEMBER_OF_THAT_FARM for a `tenantSlug` the caller is not an ACTIVE member of (#2989).',
            404: 'CHANNEL_POST_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 201,
            description: 'The reply, and the channel copy when one was asked for.',
            schema: z.object({
                postId: z.string(),
                channelCopyPostId: z.string().nullable(),
                createdAt: z.string().datetime({ offset: true }),
                mentionsRecorded: z.number().int(),
            }),
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/social/channel-posts/{postId}/resolved',
        operationId: 'setChannelQuestionResolved',
        summary: 'Mark a «Въпрос» answered, or un-mark it',
        description:
            'THE ASKER ONLY — the reversible direction, and it matches how the exchange '
            + 'treats a thread\'s owner. A moderator can already remove a post; resolving '
            + 'is not a moderation act.\n\n'
            + 'A PUT with a boolean rather than POST/DELETE, because the state is one '
            + 'nullable column and setting it to what it already is should be a no-op '
            + 'rather than a conflict.\n\n'
            + 'Refusing a non-asker with 403 rather than the 404 a missing post gives: '
            + 'the caller can SEE the post, because the feed is public, so pretending it '
            + 'is absent would contradict what they are looking at.',
        tags: TAGS,
        body: z.object({ resolved: z.boolean() }),
        extraResponses: codedErrorResponses({
            400: 'CHANNEL_NOT_A_QUESTION — only a `QUESTION` carries this state.',
            403: 'CHANNEL_NOT_THE_ASKER.',
            404: 'CHANNEL_POST_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 200,
            description: 'The new state. `resolvedAt` is null when un-marked.',
            schema: z.object({
                resolvedAt: z.string().datetime({ offset: true }).nullable(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/channels/{channelId}/media',
        operationId: 'postChannelMedia',
        summary: 'Post a photograph or a voice note to a channel',
        description:
            'ONE route for both kinds; the FIELD NAME decides — `photo` or `voice`. '
            + 'Exactly one is required, and both at once is a refusal rather than a '
            + 'precedence rule: a post carries one attachment, so silently preferring '
            + 'one would make the other vanish without telling the caller. A caption is '
            + 'optional, because a recording or a photograph alone is a complete post '
            + '(P9.6) — `ChannelPost.body` is nullable and the CHECK accepts a row with '
            + 'an attachment and no text.\n\n'
            + '**The record-less upload class**, which decides the ordering: there is no '
            + '`FileRecord` (its `tenantId` is NOT NULL and a channel has no tenant), so '
            + 'nothing downstream carries a `scanStatus` and there is no download gate '
            + 'to defer to. The AV scan runs at INGEST on the ORIGINAL bytes, before '
            + 'anything is stripped or stored.\n\n'
            + '**«max 2:00» is enforced by the BYTE CEILING, not by the duration.** The '
            + 'server sees bytes, not seconds: `durationMs` is a validated claim stored '
            + 'so a client can size a scrubber without downloading the file, and the '
            + '1.5 MB ceiling is what bounds storage. That bounds duration only '
            + 'approximately — speech at 8 kbps fits far more than two minutes under it, '
            + 'and 320 kbps stereo is refused well short — because enforcing seconds '
            + 'exactly would mean decoding the container server-side, which this does '
            + 'not do.\n\n'
            + '**Photographs are stripped of metadata; VOICE NOTES ARE NOT.** Nothing in '
            + 'this repo strips an audio container, so a recorder that writes a location '
            + 'atom would carry it — #3044 tracks that, and it is stated here rather '
            + 'than left for the image path to imply.\n\n'
            + 'An AV scan of an audio container establishes that the bytes are not a '
            + 'known-malicious payload. Not that the file is a valid recording, and not '
            + 'that it is safe to decode.\n\n'
            + '**Refusal codes.**\n'
            + '- `INVALID_BODY` — not multipart, or not exactly one of `photo` / `voice`.\n'
            + '- `FILE_TOO_LARGE`, `FILE_EMPTY`, `FILE_TYPE_NOT_ALLOWED` — the SHARED '
            + 'upload bounds and vocabulary. 4 MB for a photograph (the avatar ruling), '
            + '1.5 MB for a recording. The type is checked on the MAGIC NUMBER: '
            + 'image/jpeg, image/png, image/webp, audio/mp4, audio/ogg. `audio/webm` is '
            + 'deliberately absent — its EBML magic is shared with video/webm and the '
            + 'two cannot be separated without parsing the track list, so accepting it '
            + 'would let a video through a cap written for speech.\n'
            + '- `VOICE_NOTE_HAS_LOCATION` — the recording carries where it was made '
            + '(`©xyz`, `loci` or an Ogg `LOCATION=` comment). Refused rather than '
            + 'stripped: stripping audio means parsing a container on an upload path, '
            + 'and the recorder this product uses writes no metadata at all (measured). '
            + 'LOCATION only — an encoder tag names a device model and a future recorder '
            + 'may write one legitimately, so refusing it would reject honest recordings '
            + 'for no privacy gain.\n'
            + '- `VOICE_NOTE_DURATION_REQUIRED`, `VOICE_NOTE_TOO_LONG` — a missing or '
            + 'nonsensical length, and one over two minutes. Distinct from '
            + '`FILE_TOO_LARGE` because the remedies differ: record less, versus the '
            + 'file is too big.\n'
            + '- `CHANNEL_NOT_A_MEMBER`, `CHANNEL_BANNED`, `CHANNEL_SLOW_MODE`, '
            + '`CHANNEL_ARCHIVED` — the channel\'s own posting rules, through the same '
            + 'gate `POST /posts` uses.',
        tags: TAGS,
        bodyContentType: 'multipart/form-data',
        body: z.object({
            photo: z.string().optional().openapi({ format: 'binary' }),
            voice: z.string().optional().openapi({ format: 'binary' }),
            durationMs: z
                .string()
                .optional()
                .openapi({ description: 'Required with `voice`. Milliseconds, 1–120000.' }),
            body: z.string().optional().openapi({ description: 'Optional caption.' }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_BODY, FILE_TOO_LARGE, FILE_EMPTY, FILE_TYPE_NOT_ALLOWED, VOICE_NOTE_DURATION_REQUIRED, VOICE_NOTE_TOO_LONG, VOICE_NOTE_HAS_LOCATION or CHANNEL_ARCHIVED.',
            403: 'CHANNEL_NOT_A_MEMBER, CHANNEL_BANNED or CHANNEL_SLOW_MODE.',
            404: 'CHANNEL_NOT_FOUND, or the flag is off.',
        }),
        success: {
            status: 201,
            description: 'The post that now carries the attachment.',
            schema: z.object({
                postId: z.string(),
                createdAt: z.string().datetime({ offset: true }),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/channel-posts/{postId}/attachment',
        operationId: 'readChannelAttachment',
        summary: 'Serve a channel post\'s photograph or voice note',
        description:
            'MEMBERSHIP, which is NARROWER than the post itself. `channel_post_select` '
            + 'is public to any authenticated caller — nobody joins a channel they '
            + 'cannot look into first — so the post\'s text and even its storage key are '
            + 'readable by anybody signed in. The bytes are not, and the reason is the '
            + 'voice note rather than the photograph: a recording carries the speaker\'s '
            + 'VOICE, which is a different class of personal data from their words.\n\n'
            + 'So a NON-MEMBER reading a channel gets a post whose text is there and '
            + 'whose media is 404. A client must not render a broken player or a '
            + 'placeholder for them.\n\n'
            + 'A REMOVED post serves nothing, for all three removal columns — the '
            + 'author\'s retraction, a moderator\'s decision and the auto-hide '
            + 'threshold — and the refusal is the same 404 a missing post gives, so '
            + 'neither answer says which.\n\n'
            + '`Cache-Control: no-store`, so there is no ETag: these bytes must not sit '
            + 'in a shared cache on a phone that may be lost, sold or handed on, and no '
            + 'entry is added to the persistent-SWR allowlist. The content type is the '
            + 'SNIFFED one recorded at upload, served with `X-Content-Type-Options: '
            + 'nosniff`.',
        tags: TAGS,
        extraResponses: codedErrorResponses({
            404: 'CHANNEL_POST_NOT_FOUND — no such post, it carries no attachment, it was removed, the caller is not a member, or the flag is off.',
        }),
        success: {
            status: 200,
            description:
                'The bytes, as the type the upload SNIFFED — `image/jpeg`, `image/png`, '
                + '`image/webp`, `audio/mp4` or `audio/ogg`. A client reads the '
                + 'content type rather than guessing from the post, because the stored '
                + 'type is per attachment and `nosniff` means a wrong guess is a broken '
                + 'file rather than a corrected one.',
            // `binary`, the DM photo egress's shape — a declared 2xx body rather
            // than a bare content type. `openapi-response-shapes-ratchet` holds
            // shapeless 2xx responses at zero, and it is right to: an operation
            // with no declared body is one a client cannot generate against, and
            // this one serves two media families.
            schema: z.string().openapi({ format: 'binary' }),
        },
    });

}
