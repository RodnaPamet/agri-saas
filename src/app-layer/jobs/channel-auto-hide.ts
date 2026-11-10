/**
 * Auto-hide a channel post after three reports from VERIFIED farms — P9.3d
 * (#2937).
 *
 * ## IT IS DORMANT TODAY, AND THAT IS THE POINT OF THE READING
 *
 * Production holds ONE `FarmIdentityClaim`, status PENDING — **zero verified
 * farms** — so the threshold is arithmetically unreachable and this job will
 * hide nothing. The owner chose to build it anyway (2026-11-09), and chose
 * "built, dormant, and visibly so" over deferring it or lowering the bar to
 * any reporter.
 *
 * Lowering it was rejected for a reason worth keeping: «verified» was
 * specified precisely so three throwaway accounts cannot hide a competitor's
 * post. Making the rule reachable by weakening it defeats the control rather
 * than shipping it.
 *
 * So every run LOGS a denominator, and that is not decoration. Without it,
 * "no post has ever been auto-hidden" is ambiguous between:
 *
 *   * the rule is working and nothing warranted hiding, and
 *   * the threshold cannot be reached at all.
 *
 * Today it is the second, and `channel_auto_hide.reading` carries
 * `verifiedReporters` and a `dormant` flag saying so. It is a STRUCTURED LOG
 * and not a `[tag]` console line: that convention belongs to guards, whose
 * output `denominator-summary.cjs` collects from a jest run, and a scheduled
 * job never runs in CI — so a tagged line here would be collected by nothing
 * while breaking the repo's no-`console` rule in server code. The first draft
 * did exactly that and three guards caught it.
 *
 * ## The integration test proves the MECHANISM, never the reach
 *
 * It seeds VERIFIED claims and the threshold fires. Production has none. That
 * distinction is in the test's own docblock too, because a green suite here is
 * exactly the evidence somebody would later cite as "auto-hide works".
 *
 * ## «Verified» is IMPORTED, not redefined
 *
 * `verifiedFarmMembers` lives in `@/lib/farm-identity/verification-status`,
 * which is already the one definition and says why: a second notion of
 * verified would drift the moment DISPUTED acquires a second meaning. A claim
 * counts only when a staff reviewer promoted it, so nobody can mint one.
 *
 * ## It writes an ACTION and a STATEMENT (owner ruling 2026-11-10)
 *
 * `CONTENT_AUTO_HIDDEN` with `moderatorRef: 'auto:report-threshold'` — honest
 * that no person decided — and the author gets their Art 17 statement.
 * Hiding content and telling nobody is the gap #2955 is about, and #2865 is
 * what a statement that is not true of the content costs.
 *
 * Its own action KIND rather than `CONTENT_REMOVED`, because it sets
 * `autoHiddenAt` and not `removedByModerationAt`: recorded as a removal, the
 * restore path would clear the wrong column, find it already null, and report
 * `restored: false` — "already visible" — while the post sat there hidden.
 *
 * ## The notices stay RECEIVED
 *
 * A threshold is not a triage. The hide is provisional and a human still
 * decides, so the notices remain in the queue — moving them to ACTIONED would
 * take a decision nobody made and remove them from the one view that shows
 * work outstanding.
 */
import { randomUUID } from 'crypto';

import type { ChannelAutoHidePayload, JobRunResult } from './types';

import { verifiedFarmMembers } from '@/lib/farm-identity/verification-status';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { queueStatementForAction } from '@/app-layer/usecases/statement-queue';

/** Reports from DISTINCT verified farms needed to hide a post. */
export const AUTO_HIDE_THRESHOLD = 3;

/** How many candidate posts one run considers. */
const DEFAULT_BATCH = 50;


export async function runChannelAutoHide(
    payload: ChannelAutoHidePayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `cah-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;

    let scanned = 0;
    let hidden = 0;
    let skipped = 0;
    let verifiedReporters = 0;
    // Posts hidden whose author was NOT told. Counted so the gap is visible
    // rather than inferred — see the note at the queue call.
    let statementsUnqueued = 0;

    // Candidates: posts with an OPEN notice that are not already hidden by
    // anybody. `status: 'RECEIVED'` rather than every notice ever filed — a
    // post whose notices were all triaged has been decided on, and counting
    // them again would re-hide something a moderator left up.
    const open = await prisma.contentReport.findMany({
        where: { subjectKind: 'CHANNEL_POST', status: 'RECEIVED' },
        select: { id: true, subjectId: true, reporterUserId: true },
        take: take * AUTO_HIDE_THRESHOLD,
        orderBy: { createdAt: 'asc' },
    });

    // Group in memory. ONE query above and one membership resolution below,
    // rather than a lookup per post — the N+1 the D1 guardrail refuses.
    const byPost = new Map<string, { reportIds: string[]; reporters: Set<string> }>();
    for (const r of open) {
        const entry = byPost.get(r.subjectId) ?? { reportIds: [], reporters: new Set() };
        entry.reportIds.push(r.id);
        // An ANONYMOUS notice (Art 16 needs no account) has no reporter, so it
        // cannot be attributed to a farm and cannot count toward a threshold
        // about verified farms. It still reaches a moderator; it just is not
        // evidence of three distinct verified farms agreeing.
        if (r.reporterUserId) entry.reporters.add(r.reporterUserId);
        byPost.set(r.subjectId, entry);
    }

    const allReporters = [...new Set(open.flatMap((r) => (r.reporterUserId ? [r.reporterUserId] : [])))];
    const verified = await verifiedFarmMembers(allReporters);
    verifiedReporters = verified.size;

    // WHICH POSTS QUALIFY is decided with no query at all — the threshold is
    // pure set arithmetic over rows already read. Splitting the decision from
    // the read is what keeps the read SINGULAR: a `findUnique` per iteration is
    // the N+1 the D1 guardrail refuses, and it is right to, because a full
    // batch would be 50 round trips to learn 50 rows.
    const qualifying: { postId: string; count: number; reportIds: string[] }[] = [];
    for (const [postId, entry] of [...byPost.entries()].slice(0, take)) {
        scanned += 1;
        // DISTINCT verified reporters. Three notices from one person is one
        // person's opinion, and `@@unique` does not stop somebody filing twice
        // — the Set is what makes the threshold mean three farms.
        const count = [...entry.reporters].filter((id) => verified.has(id)).length;
        if (count < AUTO_HIDE_THRESHOLD) {
            skipped += 1;
            continue;
        }
        qualifying.push({ postId, count, reportIds: entry.reportIds });
    }

    // ONE read for every candidate. Bounded by construction — `qualifying` is
    // sliced to `take` above — so it needs no `take:` of its own, and the empty
    // case is skipped rather than sent as `{ in: [] }`.
    const posts = new Map(
        qualifying.length === 0 ? [] : (
            await prisma.channelPost.findMany({
                where: { id: { in: qualifying.map((q) => q.postId) } },
                select: {
                    id: true, authorUserId: true,
                    autoHiddenAt: true, removedByModerationAt: true, deletedAt: true,
                },
            })
        ).map((p) => [p.id, p] as const),
    );

    for (const { postId, count, reportIds } of qualifying) {
        const post = posts.get(postId);
        // Already hidden by any route — a moderator, an earlier run, or the
        // author's own retraction. Hiding it again would write a second action
        // and a second statement about one post.
        //
        // Filtered HERE rather than in the `findMany`'s `where`, which is the
        // tempting shape. Two things go wrong there: these posts would stop
        // being counted in `skipped`, so a run that considered fifty and hid
        // none would report having looked at nothing; and `!post` would then
        // mean EITHER "already hidden" or "the row is gone", which are a normal
        // outcome and a missing subject respectively.
        if (!post || post.autoHiddenAt || post.removedByModerationAt || post.deletedAt) {
            skipped += 1;
            continue;
        }

        try {
            // The hide and the action are ATOMIC: a hidden post with no action
            // row would be content nobody can account for, and an action row
            // with nothing hidden is #2865's shape.
            const actionId = await prisma.$transaction(async (tx) => {
                await tx.channelPost.update({
                    where: { id: postId },
                    data: { autoHiddenAt: new Date() },
                });
                const action = await tx.moderationAction.create({
                    data: {
                        // The notice that tipped it, so the action is attached
                        // to a real report rather than floating.
                        reportId: reportIds[reportIds.length - 1],
                        moderatorRef: 'auto:report-threshold',
                        actionKind: 'CONTENT_AUTO_HIDDEN',
                        subjectKind: 'CHANNEL_POST',
                        subjectId: postId,
                        rationale:
                            `Hidden automatically after ${count} reports from verified farms. `
                            + 'Pending moderator review.',
                    },
                    select: { id: true },
                });
                return action.id;
            });
            hidden += 1;

            // AFTER the transaction, deliberately. `queueStatementForAction`
            // takes no `tx` and reads `User` through the global client, so
            // calling it inside would take a SECOND pool connection while the
            // first is held — #1191's P0.8 deadlock. `actOnNotice` queues
            // after its own transaction for the same reason, and this follows
            // it rather than inventing a different arrangement.
            //
            // The window is real: hidden and recorded, then the queue fails,
            // and the author is not told. That is the residual of #2955 and it
            // is the repo's existing posture (a best-effort queue, like
            // #1619's chain append). What this adds is that the failure is
            // COUNTED and printed — `actOnNotice` returns null and says
            // nothing, so a missing statement there is invisible.
            const queued = await queueStatementForAction({
                actionId,
                recipientUserId: post.authorUserId,
                actionKind: 'CONTENT_AUTO_HIDDEN',
                rationale: `Hidden pending review after ${count} reports.`,
            });
            if (!queued) {
                statementsUnqueued += 1;
                logger.error('channel_auto_hide.statement_not_queued', {
                    component: 'channel-auto-hide',
                    jobRunId,
                    postId,
                    actionId,
                });
            }
        } catch (err) {
            // Per-POST tolerance, like `statement-dispatch`: one post failing
            // must not abandon the rest of the batch, and the run reports the
            // skip rather than the whole thing going red.
            skipped += 1;
            logger.error('channel_auto_hide.post_failed', {
                component: 'channel-auto-hide',
                jobRunId,
                postId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // THE READING, as a STRUCTURED LOG and deliberately not a `[tag]` console
    // line. The `[tag]` convention belongs to guards, whose output
    // `denominator-summary.cjs` collects out of a jest run — and a scheduled
    // job never runs in CI, so a tagged line here would be collected by
    // nothing while breaking the repo's no-`console` rule in server code
    // (three separate guards). The siblings this job is modelled on —
    // `statement-dispatch`, `notice-score` — emit `logger.*` only.
    //
    // `verifiedReporters` and `dormant` are the fields that make `hidden: 0`
    // legible: zero verified reporters means the threshold CANNOT be reached,
    // which is a different fact from "nothing warranted hiding". As a field
    // rather than a sentence it is also queryable, which a console line in a
    // worker's stdout is not.
    logger.info('channel_auto_hide.reading', {
        component: 'channel-auto-hide',
        jobRunId,
        threshold: AUTO_HIDE_THRESHOLD,
        postsWithOpenNotices: byPost.size,
        scanned,
        hidden,
        skipped,
        reporters: allReporters.length,
        verifiedReporters,
        statementsUnqueued,
        // TRUE while no reporter belongs to a verified farm — the production
        // state as of 2026-11-10, where one `FarmIdentityClaim` exists and it
        // is PENDING. Read it before reading `hidden`.
        dormant: verifiedReporters === 0,
    });
    if (statementsUnqueued > 0) {
        // A hide whose author was never told is a compliance gap, not a
        // statistic, so it is ALSO an error line of its own — the reading
        // above carries the count, and a count inside a routine `info` is not
        // what anybody pages on.
        logger.error('channel_auto_hide.statements_unqueued', {
            component: 'channel-auto-hide',
            jobRunId,
            statementsUnqueued,
            hidden,
        });
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'channel-auto-hide',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: scanned,
            itemsActioned: hidden,
            itemsSkipped: skipped,
        },
    };
}
