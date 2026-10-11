/**
 * Shadow-score the notices that have not been scored yet (P5.5b, #1596).
 *
 * ## Why a job rather than scoring on the notice write
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. **`POST /api/public/notices` is unauthenticated.** Putting a model call
 *      on it would let anyone make the server do paid work and wait for it, on
 *      a route whose whole purpose is that filing an Art 16 notice must be
 *      easy. The latency is the lesser half; the cost amplification is the
 *      point.
 *   2. **A notice must be filed even when the scorer is broken.** Filing is a
 *      legal duty and scoring is an experiment. Separate paths means the
 *      experiment cannot affect the duty — no ordering question, no partial
 *      write, nothing to get wrong later.
 *   3. **Batching is what makes the ceiling meaningful.** One place decides
 *      how many notices get scored per run, so the platform budget is spent at
 *      a rate somebody chose.
 *
 * ## Idempotence is a UNIQUE index, not a flag
 *
 * `NoticeScore.reportId` is unique, and the queue is "notices with no score
 * row". So a re-run cannot double-charge the platform AI budget for one
 * notice, and there is no `scored` boolean for anything to forget to set. A
 * row that fails to insert on a race is caught per-notice and skipped.
 *
 * ## Nothing downstream depends on this running
 *
 * Shadow mode means no score is read by anything that decides. So the job is
 * allowed to do nothing at all — no key configured, budget exhausted, provider
 * down — and the only consequence is that a column stays empty. That is why
 * every failure here is counted and logged rather than retried hard.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { scoreNotice, isNoticeScoringConfigured } from '@/app-layer/ai/notice-scorer';
import type { JobRunResult } from './types';

/**
 * How many notices to score per run.
 *
 * Deliberately small. At the quarter-hourly cadence this schedule uses, that is
 * 80 notices an hour — far above this deployment's real volume (3 tenants,
 * measured 2026-10-10) and far below what a flood could produce, so the
 * ceiling rather than this number is what binds under abuse. A larger batch
 * would spend the monthly budget in a few runs and leave the rest of the month
 * unscored, which is the worst possible sampling for judging a scorer.
 */
const DEFAULT_BATCH = 20;

export interface NoticeScorePayload {
    /** Cap for this run. Defaults to 20. */
    limit?: number;
}

export async function runNoticeScore(
    payload: NoticeScorePayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `ns-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;

    let scanned = 0;
    let actioned = 0;
    let skipped = 0;

    // Checked before the query so an unconfigured deployment does no work at
    // all. `scoreNotice` would return null for every row anyway, but reading
    // the queue to discard it is pointless.
    if (!isNoticeScoringConfigured()) {
        const completedAt = new Date();
        return {
            result: {
                jobName: 'notice-score',
                jobRunId,
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                itemsScanned: 0,
                itemsActioned: 0,
                itemsSkipped: 0,
                details: { skippedReason: 'ai_not_configured' },
            },
        };
    }

    // The privileged client: both tables deny `app_user` for every command, so
    // there is no session context that could read this queue.
    //
    // "Unscored" is a NOT EXISTS against `NoticeScore`, never a flag on
    // `ContentReport` — a column there would be reporter-readable, which is
    // the trap that put the score in its own table (#1553 DECISION 3).
    //
    // TWO queries on purpose, and the split is load-bearing:
    //
    //   - the anti-join runs as RAW SQL so the database does it and the result
    //     is bounded by LIMIT. Collecting every scored `reportId` into a
    //     `notIn` would grow without limit as notices accumulate, and would
    //     send that whole list to the server on every run;
    //   - the row read then goes through PRISMA, because `ContentReport.detail`
    //     is encrypted and the client extension is what decrypts it. A raw
    //     read would hand the model ciphertext and score it — producing a
    //     confident number about nothing, with nothing failing.
    const unscored = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r."id"
        FROM "ContentReport" r
        WHERE NOT EXISTS (
            SELECT 1 FROM "NoticeScore" s WHERE s."reportId" = r."id"
        )
        -- Oldest first, matching the triage queue: if the budget covers only
        -- part of the backlog, it should cover the part a moderator is about
        -- to look at.
        ORDER BY r."createdAt" ASC
        LIMIT ${take}
    `;

    const pending = unscored.length === 0 ? [] : await prisma.contentReport.findMany({
        where: { id: { in: unscored.map((r) => r.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
            id: true,
            reasonCode: true,
            subjectKind: true,
            detail: true,
            // Read to derive `anonymous`, and NEVER passed to the model. A
            // moderator decides on the content; so does the scorer.
            reporterUserId: true,
        },
    });
    scanned = pending.length;

    for (const report of pending) {
        try {
            const result = await scoreNotice({
                reasonCode: report.reasonCode,
                subjectKind: report.subjectKind,
                detail: report.detail,
                anonymous: report.reporterUserId === null,
            });

            if (!result) {
                // No key, no budget, a provider error, or output that failed
                // validation — all already logged by the scorer, all meaning
                // "no score for this notice", which is a normal outcome.
                skipped += 1;
                continue;
            }

            await prisma.noticeScore.create({
                data: {
                    reportId: report.id,
                    score: result.score,
                    rationale: result.rationale,
                    model: result.model,
                },
            });
            actioned += 1;
        } catch (err) {
            // Per-notice isolation. The likely cause is the unique constraint
            // under a concurrent run, which means somebody else scored it —
            // not an error worth stopping a batch for.
            skipped += 1;
            logger.warn('notice-score.store_failed', {
                component: 'notice-score',
                reportId: report.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'notice-score',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: scanned,
            itemsActioned: actioned,
            itemsSkipped: skipped,
            // `success: true` with skips is the honest shape: the RUN worked,
            // and an unscored notice costs nothing because nothing reads a
            // score.
            details: { unscoredAfterRun: skipped },
        },
    };
}
