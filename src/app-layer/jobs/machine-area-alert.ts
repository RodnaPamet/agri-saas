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

/**
 * OWNER and ADMIN of EVERY named farm, by ACTIVE membership, in ONE query.
 *
 * Batched rather than per-farm because the caller runs over every farm with a
 * recent fix: a per-farm version is a Prisma read inside a loop, which
 * `query-shape-guardrails` Layer D1 refuses, and it refuses it for a reason
 * this job makes concrete — the loop's length is the number of FARMS with
 * tracked machines, so the query count grows with adoption rather than with
 * the thing being alerted about.
 *
 * Returns a Map so a farm with no OWNER or ADMIN is an ABSENT key rather than
 * an empty array that reads as "asked and found nobody". The caller treats
 * both the same, but the distinction is what a future reading would need.
 */
async function alertRecipients(tenantIds: string[]): Promise<Map<string, string[]>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await prisma.tenantMembership.findMany({
        where: {
            tenantId: { in: tenantIds },
            status: 'ACTIVE',
            role: { in: ['OWNER', 'ADMIN'] },
        },
        select: { tenantId: true, userId: true },
    });
    const byTenant = new Map<string, string[]>();
    for (const r of rows) {
        const seen = byTenant.get(r.tenantId);
        if (seen) {
            if (!seen.includes(r.userId)) seen.push(r.userId);
        } else {
            byTenant.set(r.tenantId, [r.userId]);
        }
    }
    return byTenant;
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

        /*
         * PASS 0 — every stored verdict, in one read.
         *
         * `prior` is needed for each target, and reading it per target is a
         * Prisma read inside a loop: Layer D1 refuses it, and the loop is as
         * long as the number of tracked machines on the platform, so the
         * query count would grow with adoption rather than with departures.
         * An absent key means NO prior verdict, which is a real state this
         * job distinguishes from `outside: false` — the first verdict for a
         * machine already away counts as a departure.
         */
        const priorRows = await prisma.machineAreaState.findMany({
            where: { assetId: { in: targets.map((t) => t.assetId) } },
            select: { assetId: true, outside: true, evaluatedAt: true },
        });
        const priors = new Map(priorRows.map((r) => [r.assetId, r]));

        /** Departures found in pass 1, enqueued in pass 2. */
        const departed: Array<{ tenantId: string; assetId: string }> = [];

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

                const prior = priors.get(t.assetId) ?? null;

                // Idempotence: the same fix cannot produce a second alert, so a
                // job that wakes twice before the tracker reports again is a
                // no-op rather than a duplicate push.
                if (prior && prior.evaluatedAt.getTime() === v.evaluated_at.getTime()) {
                    continue;
                }

                const isDeparture = v.outside && prior?.outside !== true;
                const changed = prior === null || prior.outside !== v.outside;

                await prisma.machineAreaState.upsert({
                    where: { assetId: t.assetId },
                    create: {
                        tenantId: t.tenantId,
                        assetId: t.assetId,
                        outside: v.outside,
                        changedAt: now,
                        evaluatedAt: v.evaluated_at,
                        ...(isDeparture ? { alertedAt: now } : {}),
                    },
                    update: {
                        outside: v.outside,
                        evaluatedAt: v.evaluated_at,
                        ...(changed ? { changedAt: now } : {}),
                        ...(isDeparture ? { alertedAt: now } : {}),
                    },
                });

                if (!isDeparture) continue;
                departures += 1;

                /*
                 * The first verdict for a machine ALREADY outside counts as a
                 * departure, deliberately: a farm installing a tracker on a
                 * machine that is away wants to know it is away. The
                 * alternative — treating an absent prior row as "inside" and
                 * staying silent — hides exactly the case somebody fitted the
                 * tracker to find.
                 */
                departed.push(t);
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
         * PASS 2 — the pushes, with every read batched.
         *
         * Split from the verdict loop so the four reads a push needs (asset,
         * farm slug, recipients, each recipient's language) are four queries
         * for the whole run instead of four per departing machine. The state
         * write in pass 1 has already happened, so a failure here does NOT
         * re-alert on the next run: that is the cost of the split and it is
         * the right direction — a missed alert is recoverable by the operator
         * opening the map, a duplicate "your machine left" is the kind of
         * alert people turn off.
         *
         * Nothing runs at all when nothing departed, which is the common case.
         */
        if (departed.length > 0) {
            const assetIds = [...new Set(departed.map((d) => d.assetId))];
            const tenantIds = [...new Set(departed.map((d) => d.tenantId))];

            const assetRows = await prisma.asset.findMany({
                where: { id: { in: assetIds }, tenantId: { in: tenantIds } },
                select: { id: true, tenantId: true, key: true },
            });
            /*
             * Keyed on BOTH ids: `Asset` is identified by `@@id([id, tenantId])`,
             * so an id alone is not a key here.
             *
             * DEFENSIVE AND UNPROVEN, recorded rather than claimed: keying on
             * `a.id` alone survives this suite, because ids are cuids and no
             * test can realistically produce the same one in two tenants. It
             * stays because the schema says the id is half a key, not because
             * a test fails without it.
            const assets = new Map(assetRows.map((a) => [`${a.tenantId}:${a.id}`, a]));

            const tenantRows = await prisma.tenant.findMany({
                where: { id: { in: tenantIds } },
                select: { id: true, slug: true },
            });
            const slugs = new Map(tenantRows.map((t) => [t.id, t.slug]));

            const recipientsByTenant = await alertRecipients(tenantIds);
            const everyRecipient = [...new Set([...recipientsByTenant.values()].flat())];
            const userRows = await prisma.user.findMany({
                where: { id: { in: everyRecipient } },
                select: { id: true, uiLanguage: true },
            });
            const locales = new Map(
                userRows.map((u) => [u.id, resolveRecipientLocale(u.uiLanguage ?? null)]),
            );

            /*
             * One composition per LOCALE rather than per recipient: the body
             * names the machine's key, so two OWNERs reading the same language
             * get byte-identical text and `translateFor` need not be asked
             * twice. Keyed by `locale:assetId` because the key is interpolated.
             */
            const composed = new Map<string, { title: string; pushBody: string }>();

            for (const d of departed) {
                const asset = assets.get(`${d.tenantId}:${d.assetId}`);
                const slug = slugs.get(d.tenantId);
                if (!asset || !slug) continue;
                const recipients = recipientsByTenant.get(d.tenantId) ?? [];

                for (const userId of recipients) {
                    const locale = locales.get(userId) ?? resolveRecipientLocale(null);
                    const cacheKey = `${locale}:${d.assetId}`;
                    let copy = composed.get(cacheKey);
                    if (!copy) {
                        /*
                         * THE PUSH BODY NAMES THE KEY, NEVER `Asset.name`
                         * (#1999, owner ruling 2026-11-01: keep the KEY, drop
                         * the free text). An APNs payload is not end-to-end
                         * encrypted, so Apple reads it, and a machine's name
                         * is farmer-written prose — «Джон Диър на Петър» is a
                         * person's name on a tractor. `Asset.key` is a
                         * generated per-tenant short key (`AST-7`) and
                         * discloses nothing.
                         *
                         * `key` is NULLABLE, and a missing one means the push
                         * carries its TITLE ONLY — never the name as a
                         * fallback, which is the whole defect #1999 is about
                         * and exactly how it would come back. The link still
                         * opens the machine, so the name is one REST read away
                         * on a screen that is already authenticated.
                         *
                         * AWAITED. `translateFor` is async, and without this
                         * the body ships as the literal "[object Promise]" —
                         * which is what the first version of this did, and
                         * what the suite's body assertion caught. Nothing else
                         * would have: the push enqueues fine, the job reports
                         * success, and the farmer gets a notification whose
                         * text is a type name.
                         */
                        copy = {
                            title: await translateFor(locale, 'machines.areaAlert.title', {}),
                            pushBody: asset.key
                                ? await translateFor(locale, 'machines.areaAlert.pushBody', {
                                      key: asset.key,
                                  })
                                : '',
                        };
                        composed.set(cacheKey, copy);
                    }

                    await enqueue('push-send', {
                        tenantId: d.tenantId,
                        recipientUserId: userId,
                        title: copy.title,
                        body: copy.pushBody,
                        // Root-relative and tenant-prefixed, per the rule
                        // `task.ts` states: the server owns the shape, so
                        // correcting it never needs a client release. #2932 is
                        // what a bare path cost.
                        link: `/t/${slug}/machines/${d.assetId}`,
                        // One key per machine, so a second departure replaces
                        // the first rather than stacking.
                        collapseKey: `machine-area-${d.assetId}`,
                    });
                    pushed += 1;
                }
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
