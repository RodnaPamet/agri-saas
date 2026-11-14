/**
 * Deliver one PERSON-SCOPED notification to one person's devices — #2987.
 *
 * The tenantless sibling of `push-send`. A channel mention, a channel reply
 * and a direct message have no farm — P9.1's five channel tables and P8.1's
 * four DM tables carry no `tenantId`, deliberately — so every step of the
 * existing push path is unavailable to them:
 *
 *   `Notification.tenantId`            NOT NULL
 *   `PushSubscription.tenantId`        NOT NULL, one row per (tenant, user, endpoint)
 *   `UserNotificationPreference`       one row per (user, tenant)
 *   `sendApnsToUser` / `…WebPush…`     bind RLS through `runInTenantContext`
 *   `push-send` / `push-summary`       keyed on a tenant, including the jobId
 *
 * Resolving a tenant from the recipient is the mistake P5.4a names for
 * `NotificationOutbox` — "resolving one would invent a tenant for a
 * person-scoped obligation" — and here it would also pick WRONG: the
 * registration route is tenant-scoped, so a person in three farms may hold a
 * `PushSubscription` row under only the farm they happened to be in when the
 * device registered.
 *
 * ## Its own queue, like its sibling
 *
 * `PUSH_QUEUE_JOBS`, for `push-send`'s reason: a fan-out on the main worker
 * would consume its 50/min limiter budget and starve every other job type for
 * the rest of the minute — including the outbox sweep, which is how
 * notifications reach email at all.
 *
 * ## ONE job per recipient, never a fan-out over people
 *
 * `push-send`'s rule, and it matters more here: BullMQ retries a whole job, so
 * a failure for one person must not re-send to the others. A channel post may
 * mention five people; that is five jobs.
 *
 * ## QUIET HOURS DEFER HERE, and the row is what made that possible
 *
 * Owner ruling 2026-11-14 (#3020): a mention, a reply or a direct message
 * arriving 22:00–06:00 `Europe/Sofia` is HELD and delivered as one summary
 * push at 06:00, as a farm notification already is.
 *
 * This file suppressed instead until then, and the reason it had to is worth
 * keeping: `push-send` defers by enqueuing one `push-summary`, which reads the
 * person's unread `Notification` rows for that tenant — and a tenantless event
 * writes NO such row, because `Notification.tenantId` is NOT NULL with an FK.
 * A person summary had nothing to count, so enqueuing one would have woken
 * somebody at 06:00 to tell them about zero things.
 *
 * `PersonPushDeferral` is the store that closes it: one tenantless row per
 * held push, which the 06:00 job counts. That table's own docblock carries why
 * rows rather than a counter (a deploy prunes the container, so #2987's log
 * line vanished mid-night) and why not a nullable `Notification.tenantId`.
 *
 * This docblock previously pointed at #2990 as the territory that would close
 * it. That was wrong twice over: #2990 was the read cursor and unread counts,
 * which shipped without touching this, and the thing actually needed was a
 * store of its own — the P5.4a shape, where `StatementOfReasons` became its
 * own outbox rather than borrowing a tenant-scoped one.
 *
 * The window still governs only whether somebody is INTERRUPTED. The SSE frame
 * and the REST read are unaffected, so a person with the app open at 23:00
 * sees the mention arrive.
 *
 * ## The payload carries no free text
 *
 * `title` and `body` are composed from catalogue copy by the caller, never
 * from a message. `push-payload-carries-no-free-text` is the control, and it
 * is a CHOICE here rather than a consequence: `DirectMessage.body` is
 * encrypted at rest, but `ChannelPost.body` is plaintext (P9.1, so P9.7 can
 * search it), so nothing would have stopped a channel post's prose going
 * through Redis and APNs.
 */
import { resolvePersonDelivery } from '@/app-layer/notifications/person-delivery';
import { enqueue } from '@/app-layer/jobs/queue';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { listMyFarms } from '@/app-layer/usecases/my-farms';
import { sendApnsToPerson } from '@/lib/notifications/apns';
import { sendWebPushToPerson } from '@/lib/notifications/web-push';
import { logger } from '@/lib/observability/logger';
import type { PersonPushSubject } from '@/app-layer/jobs/types';

export interface PersonPushSendInput {
    /** The person being notified — never the actor. */
    recipientUserId: string;
    title: string;
    body: string;
    /**
     * The target page WITHOUT its `/t/{slug}` prefix, or null for a
     * notification that navigates nowhere. `resolveLink` below turns it into
     * a link, or into no link at all.
     */
    farmRelativePath: string | null;
    /**
     * One key for both transports: the Web Push `tag` and the APNs
     * `apns-collapse-id`. A second notification about the same subject
     * supersedes the first rather than stacking — so a channel that is busy
     * does not produce a column of identical banners.
     */
    collapseKey: string;
    /**
     * What the push is ABOUT, so quiet hours can hold it with a destination
     * the 06:00 summary can rebuild (#3020). Optional only for the deploy
     * window — see `PersonPushSubject`.
     */
    subject?: PersonPushSubject;
}

export interface PersonPushSendResult {
    attempted: number;
    delivered: number;
}

/**
 * Turn a farm-relative PATH into a link somebody's phone can open, or into no
 * link at all.
 *
 * ## Why a path arrives here instead of a link
 *
 * There is no tenantless web route and agrent-ios has agreed not to ask for
 * one (#2987), so every destination in this product is `/t/{slug}/…`. A
 * channel post and a direct message have no farm, so the enqueuing usecase has
 * no slug to write — `postToChannel` runs person-scoped under `/api/social/`,
 * and the poster's own farm would be the WRONG answer anyway: a recipient sent
 * to a farm they do not belong to is bounced by the tenant-access gate.
 *
 * ## A bare path is not the fallback, it is the defect
 *
 * #2932: `push-summary` sent `/notifications`, which is not a page. The web
 * service worker opened a 404 and iOS had no `PushLink` case for it, so the
 * push merely opened the app. Measured there: 19 of 19 production
 * `Notification.linkUrl` rows start with `/t/`, and that one job was the only
 * violator. The rule `task.ts` states is the same one — the server owns the
 * shape, so correcting it never needs a client release.
 *
 * So an unresolvable farm sends **no link**, never the path: both transports
 * spell "no target" as an absent key, the push still arrives, and it simply
 * does not navigate. Reach preserved, and no client ever receives a
 * destination that goes nowhere.
 *
 * ## This is not the resolution this file's own docblock refuses
 *
 * That paragraph is about ADDRESSING — which devices to send to, which
 * preference applies — and resolving a tenant for it would both invent a farm
 * for a person-scoped obligation (P5.4a) and pick wrong, because
 * `PushSubscription` registration is tenant-scoped. This is a NAVIGATION
 * SHELL: the notification stays tenantless, and the slug is a URL segment
 * deciding which farm's chrome the page opens inside. P8.4 settled that the
 * answer is arbitrary — "a DM list is identical under every farm" — so one
 * active membership is as good a choice as the next.
 *
 * (The wording is load-bearing. `no-explicit-any-ratchet` counts five cast
 * patterns on RAW TEXT, before any comment stripping — its own CAPS comment
 * says so, and #1526 lowered that cap 18 to 16 by deleting two PROSE hits.
 * The earlier version of the sentence above ended with the two-word cast
 * spelling, in English, and reddened a shard. No regex can separate the two
 * readings: the guard correctly rejects "has any" and "this was any good",
 * because those differ by a character, while the English and the cast do not
 * differ at all. So the fix is always the wording, never the cap — a cap that
 * four real casts are tracked by is not something to spend on a sentence.
 * Writing this note cost a second shard, because the first draft of it
 * explained the trap by quoting the phrase.)
 *
 * ## `listMyFarms`, rather than a second spelling of its predicate
 *
 * Three clauses and an ordering, each load-bearing and each already argued in
 * `my-farms.ts`: ACTIVE (a deactivated member is not a member), the tenant not
 * soft-deleted (a removed farm 404s at the tenant resolver), and oldest-first,
 * which is the membership `/api/auth/me` already names and the switcher
 * already lists first. Writing the query again here is the #1664 class — two
 * spellings of one rule, diverging silently — and the divergence that matters
 * is the middle clause, which the switcher's own docblock calls the easy miss.
 */
async function resolveLink(
    recipientUserId: string,
    farmRelativePath: string | null,
    collapseKey: string,
): Promise<string | null> {
    if (farmRelativePath === null) return null;

    const farms = await listMyFarms(recipientUserId);
    const slug = farms[0]?.slug;
    if (!slug) {
        // The push still goes out, so a log reader could not otherwise tell
        // this from a normal send — #2932's reason for the same line.
        // `collapseKey` and not the path: it already identifies the subject,
        // and one identifier is enough.
        logger.warn('person-push.link_unresolved', {
            component: 'person-push',
            collapseKey,
            farms: farms.length,
        });
        return null;
    }

    return `/t/${slug}${farmRelativePath}`;
}

export async function runPersonPushSend(
    input: PersonPushSendInput,
): Promise<PersonPushSendResult> {
    const { recipientUserId, title, body, farmRelativePath, collapseKey } = input;

    const decision = await resolvePersonDelivery(recipientUserId, new Date());

    if (decision.deferral !== null) {
        // HELD, not suppressed — owner ruling 2026-11-14 (#3020). This was a
        // drop with a log line until then, and the log was the only record:
        // a direct message at 23:00 produced no interruption EVER, while a
        // farm notification at 23:00 produced one at 06:00. Two recipients of
        // two kinds of message got different treatment for a reason neither
        // could see.
        const { at, nightKey } = decision.deferral;

        // A ROW first, because the row is what the summary counts and what
        // makes "exactly one item" answerable for the link rule. A log line
        // cannot be counted after a deploy: Watchtower prunes the old
        // container, so #2987's evidence vanished mid-night.
        await runWithoutRls({ reason: 'person-push-deferral' }, (db) =>
            db.personPushDeferral.create({
                data: {
                    recipientUserId,
                    nightKey,
                    // An ABSENT subject is a payload from the previous image,
                    // mid-deploy. It still gets a row — being counted and
                    // linkless is the several-items behaviour, and strictly
                    // better than the drop this replaces.
                    kind: input.subject?.kind ?? 'DIRECT_MESSAGE',
                    channelId: input.subject && 'channelId' in input.subject
                        ? input.subject.channelId
                        : null,
                    postId: input.subject && 'postId' in input.subject
                        ? input.subject.postId
                        : null,
                    conversationId: input.subject && 'conversationId' in input.subject
                        ? input.subject.conversationId
                        : null,
                },
                select: { id: true },
            }),
        );

        // ONE summary per person per night. `jobId` is what achieves that —
        // BullMQ refuses a duplicate id, so the fifth mention of a night
        // cannot schedule a fifth summary, and it is a single `add` rather
        // than a read-modify-write two workers could interleave. Copied from
        // `push-send`'s farm deferral, which solved the identical problem.
        //
        // The DELAY, not a cron: `quietWindowEnd` resolves 06:00 in
        // `Europe/Sofia`, so the boundary is DST-correct. A UTC cron at a
        // fixed hour would be an hour wrong for half the year.
        await enqueue(
            'person-push-summary',
            { recipientUserId, nightKey },
            {
                jobId: `person-push-summary:${recipientUserId}:${nightKey}`,
                delay: Math.max(0, at.getTime() - Date.now()),
            },
        );

        logger.info('person-push.deferred', {
            component: 'person-push',
            collapseKey,
            reason: decision.suppressedBecause,
            nightKey,
            kind: input.subject?.kind ?? 'unknown',
            // No prose: the payload is displayed copy.
        });
        return { attempted: 0, delivered: 0 };
    }

    if (!decision.webPush && !decision.apns) {
        logger.info('person-push.suppressed', {
            component: 'person-push',
            collapseKey,
            reason: decision.suppressedBecause,
        });
        return { attempted: 0, delivered: 0 };
    }

    // AFTER the two gates: a suppressed push has no destination to resolve,
    // and this is a query.
    const link = await resolveLink(recipientUserId, farmRelativePath, collapseKey);

    let attempted = 0;
    let delivered = 0;

    const wanted = [
        ...(decision.webPush ? (['web'] as const) : []),
        ...(decision.apns ? (['apns'] as const) : []),
    ];

    for (const transport of wanted) {
        attempted += 1;
        // #2171's lesson, inherited rather than rediscovered: the OUTCOME, not
        // the absence of a throw. Neither transport throws — both catch per
        // device and return counts — so `delivered += 1` inside a try would
        // have counted every call that returned, including an unconfigured
        // transport that sent nothing.
        const outcome =
            transport === 'web'
                ? await sendWebPushToPerson(recipientUserId, {
                      title,
                      body,
                      // `?? undefined`, because the payload spells "no target"
                      // as null and both transports spell it absent. Passing
                      // null through would be a literal "null" href.
                      url: link ?? undefined,
                      tag: collapseKey,
                  })
                : await sendApnsToPerson(recipientUserId, {
                      title,
                      body,
                      link: link ?? undefined,
                      collapseId: collapseKey,
                  });

        if (outcome.sent > 0) delivered += 1;
        else if (outcome.retryable > 0) {
            logger.warn('person-push.transport_failed', {
                component: 'person-push',
                transport,
                collapseKey,
                retryable: outcome.retryable,
            });
        }
    }

    return { attempted, delivered };
}
