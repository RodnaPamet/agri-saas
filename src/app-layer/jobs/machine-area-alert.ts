/**
 * Alert OWNER and ADMIN when a machine leaves the farm's area — #2948 stage 5.
 *
 * The last of #2948's six stages, and the first one a farmer notices without
 * going looking: the live map and the day history are screens you open, and
 * this arrives.
 *
 * ## The four parameters, all ruled rather than chosen here
 *
 * | | |
 * |---|---|
 * | the area | union of **2 km** buffers per parcel (owner, 2026-11-13) |
 * | recipients | **OWNER + ADMIN** |
 * | cadence | **one push per EVENT**, not per interval |
 * | night window | **dropped** |
 *
 * The area was the open one. §7 proposed the convex hull of the farm's
 * parcels buffered 500 m; the ruling replaced it with a union of per-parcel
 * 2 km buffers, because a hull over blocks 50 km apart swallows every town
 * between them and a machine taken to a dealership would never count as away.
 * The accepted cost is the mirror image: a tractor driving between two distant
 * blocks of the same farm IS outside and will alert. The copy has to survive
 * that — a farmer who sees «излезе от стопанството» while driving their own
 * tractor between their own blocks must not conclude the alert is broken.
 *
 * ## ONE PUSH PER EVENT means a stored verdict, not a time window
 *
 * A departure is a boundary CROSSING, so the job compares today's verdict with
 * `MachineAreaState.outside` and pushes only on false → true. The alternative
 * — "at most one per machine per 30 minutes", which §7 proposed — is a
 * different rule: it keeps notifying for as long as a machine sits at a
 * dealership, which is what the ruling moved away from.
 *
 * Returning is deliberately SILENT. A farm is told when a machine leaves, not
 * when it comes back: the second is not a risk, and the first loses its force
 * if it arrives in a pair.
 *
 * ## MECHANISATOR is excluded, and that is not an oversight
 *
 * §7's reason, kept verbatim because it is the whole argument: "a MECHANISATOR
 * receiving 'a machine is moving at night' would be an alert about
 * themselves". The operator persona is the subject of this alert, never its
 * audience.
 *
 * ## A farm with no mapped parcels is SKIPPED, not alerted
 *
 * `ST_Union` over no rows is NULL, so the verdict is NULL rather than
 * "outside" — see `machineAreaVerdictSql`. Reading that as a departure would
 * push once per machine per run at a farm that has simply not drawn its
 * blocks yet, which is the loudest possible failure for the least informed
 * user.
 *
 * ## It enqueues `push-send` rather than sending
 *
 * One enqueue reaches BOTH transports and goes through `resolveDelivery`,
 * which is where the quiet-hours decision belongs (#1994). A job that called
 * `sendWebPushToUser` itself would reach browsers only — the mistake
 * `weather-pull` had made with the most time-sensitive notification in the
 * product, found by `one-resolve-delivery`.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { machineAreaVerdictSql } from '@/lib/db/geo';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';
import { translateFor } from '@/lib/i18n/server-messages';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';

import { enqueue } from './queue';
import type { JobRunResult } from './types';

/** The farm's area is every parcel, buffered by this many metres. */
export const AREA_BUFFER_M = 2_000;

/**
 * How far back a fix may be and still count as "where the machine is".
 *
 * A tracker reports about every 30 s, so 30 minutes is sixty missed reports —
 * long enough to ride out a tunnel or a cold start, short enough that a
 * machine switched off in a shed last week does not keep producing verdicts
 * from its final fix. A machine with nothing newer than this is SKIPPED: its
 * position is unknown, which is not the same as being outside.
 */
const FIX_FRESHNESS_MINUTES = 30;

interface Verdict {
    evaluated_at: Date | null;
    outside: boolean | null;
}

export interface MachineAreaAlertPayload {
    /** Limit to one tenant. Default: every tenant with a recent fix. */
    tenantId?: string;
    /** Override "now" — tests only. */
    now?: string;
}

/** OWNER and ADMIN of a farm, by ACTIVE membership. */
async function alertRecipients(tenantId: string): Promise<string[]> {
    const rows = await prisma.tenantMembership.findMany({
        where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
}

export async function runMachineAreaAlert(
    payload: MachineAreaAlertPayload = {},
): Promise<{ result: JobRunResult }> {
    return runJob('machine-area-alert', async () => {
        const jobRunId = `maa-${randomUUID()}`;
        const startedAt = new Date();
        const now = payload.now ? new Date(payload.now) : new Date();
        const since = new Date(now.getTime() - FIX_FRESHNESS_MINUTES * 60_000);

        /*
         * Machines that reported RECENTLY, derived from the positions rather
         * than from the tracker list: a registered-but-silent tracker has no
         * position to judge, and a verdict about it would be a claim from no
         * evidence. Privileged because this crosses tenants — retention,
         * derivation and this all share that posture.
         */
        const targets = await prisma.$queryRaw<
            Array<{ tenantId: string; assetId: string }>
        >(Prisma.sql`
            SELECT DISTINCT p."tenantId", p."assetId"
            FROM "MachinePosition" p
            WHERE p."recordedAt" >= ${since}
            ${payload.tenantId ? Prisma.sql`AND p."tenantId" = ${payload.tenantId}` : Prisma.empty}
        `);

        let evaluated = 0;
        let departures = 0;
        let pushed = 0;
        let skippedNoArea = 0;
        let skippedStale = 0;
        const recipientCache = new Map<string, string[]>();

        for (const t of targets) {
            try {
                const rows = await prisma.$queryRaw<Verdict[]>(
                    machineAreaVerdictSql({
                        tenantId: t.tenantId,
                        assetId: t.assetId,
                        since,
                        bufferM: AREA_BUFFER_M,
                    }),
                );
                const v = rows[0];
                if (!v || v.evaluated_at === null) {
                    skippedStale += 1;
                    continue;
                }
                if (v.outside === null) {
                    // The farm has no mapped parcels — no area, so no verdict.
                    skippedNoArea += 1;
                    continue;
                }
                evaluated += 1;

                const prior = await prisma.machineAreaState.findUnique({
                    where: { assetId: t.assetId },
                    select: { outside: true, evaluatedAt: true },
                });

                // Idempotence: the same fix cannot produce a second alert, so a
                // job that wakes twice before the tracker reports again is a
                // no-op rather than a duplicate push.
                if (prior && prior.evaluatedAt.getTime() === v.evaluated_at.getTime()) {
                    continue;
                }

                const departed = v.outside && prior?.outside !== true;
                const changed = prior === null || prior.outside !== v.outside;

                await prisma.machineAreaState.upsert({
                    where: { assetId: t.assetId },
                    create: {
                        tenantId: t.tenantId,
                        assetId: t.assetId,
                        outside: v.outside,
                        changedAt: now,
                        evaluatedAt: v.evaluated_at,
                        ...(departed ? { alertedAt: now } : {}),
                    },
                    update: {
                        outside: v.outside,
                        evaluatedAt: v.evaluated_at,
                        ...(changed ? { changedAt: now } : {}),
                        ...(departed ? { alertedAt: now } : {}),
                    },
                });

                if (!departed) continue;
                departures += 1;

                /*
                 * The first verdict for a machine ALREADY outside counts as a
                 * departure, deliberately: a farm installing a tracker on a
                 * machine that is away wants to know it is away. The
                 * alternative — treating an absent prior row as "inside" and
                 * staying silent — hides exactly the case somebody fitted the
                 * tracker to find.
                 */
                const asset = await prisma.asset.findUnique({
                    where: { id_tenantId: { id: t.assetId, tenantId: t.tenantId } },
                    select: { name: true },
                });
                const tenant = await prisma.tenant.findUnique({
                    where: { id: t.tenantId },
                    select: { slug: true },
                });
                if (!asset || !tenant) continue;

                let recipients = recipientCache.get(t.tenantId);
                if (!recipients) {
                    recipients = await alertRecipients(t.tenantId);
                    recipientCache.set(t.tenantId, recipients);
                }

                for (const userId of recipients) {
                    const user = await prisma.user.findUnique({
                        where: { id: userId },
                        select: { uiLanguage: true },
                    });
                    const locale = resolveRecipientLocale(user?.uiLanguage ?? null);
                    await enqueue('push-send', {
                        tenantId: t.tenantId,
                        recipientUserId: userId,
                        // AWAITED. `translateFor` is async, and without this
                        // the body ships as the string "[object Promise]" —
                        // which is what the first version of this did, and
                        // what the suite's body assertion caught. Nothing
                        // else would have: the push enqueues fine, the job
                        // reports success, and the farmer gets a
                        // notification whose text is a type name.
                        title: await translateFor(locale, 'machines.areaAlert.title', {}),
                        body: await translateFor(locale, 'machines.areaAlert.body', {
                            machine: asset.name,
                        }),
                        // Root-relative and tenant-prefixed, per the rule
                        // `task.ts` states: the server owns the shape, so
                        // correcting it never needs a client release. #2932 is
                        // what a bare path cost.
                        link: `/t/${tenant.slug}/machines/${t.assetId}`,
                        // One key per machine, so a second departure replaces
                        // the first rather than stacking.
                        collapseKey: `machine-area-${t.assetId}`,
                    });
                    pushed += 1;
                }
            } catch (err) {
                logger.warn('machine-area-alert.asset_failed', {
                    component: 'machine-area-alert',
                    jobRunId,
                    tenantId: t.tenantId,
                    assetId: t.assetId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        /*
         * The reading, in log FIELDS — a scheduled job's `[tag]` console line
         * is collected by nothing (the P9.3d note) while still breaching the
         * no-console rule.
         *
         * `skippedNoArea` is the one worth watching: it counts farms that have
         * machines reporting and no parcels drawn, for whom this feature can
         * never fire. That is a product fact rather than an error, and it is
         * invisible without this number.
         */
        logger.info('machine-area-alert.reading', {
            component: 'machine-area-alert',
            jobRunId,
            bufferM: AREA_BUFFER_M,
            machinesSeen: targets.length,
            evaluated,
            departures,
            pushesEnqueued: pushed,
            skippedNoArea,
            skippedStale,
        });

        const completedAt = new Date();
        return {
            result: {
                jobName: 'machine-area-alert',
                jobRunId,
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                itemsScanned: targets.length,
                itemsActioned: departures,
                itemsSkipped: skippedNoArea + skippedStale,
                details: {
                    evaluated,
                    departures,
                    pushesEnqueued: pushed,
                    skippedNoArea,
                    skippedStale,
                },
            },
        };
    });
}
