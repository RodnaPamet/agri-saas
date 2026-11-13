/**
 * Delete raw machine positions past their retention window — #3012.
 *
 * ## It exists because the product already makes the promise
 *
 * #2948 §2 is an owner ruling with the reason stated: **this is employee
 * location data.** A track shows where a named driver was, minute by minute,
 * because the task link names them.
 *
 *   0–30 days   raw `MachinePosition` rows — live map, day history, derivation
 *   after 30d   raw rows DELETED; derived `WorkedParcel` records kept
 *
 * The phone tells owners and admins so in words — «маршрутите се пазят 30
 * дни» — and `/track` already answers `retained: false` for a day outside the
 * window. Until this job, nothing deleted anything: the first half of the
 * ruling was a policy with no implementation, and the sentence shown to
 * farmers was false.
 *
 * ## ONE definition of the window, imported rather than restated
 *
 * `RAW_POSITION_RETENTION_DAYS` and `isDayRetained` already decide what
 * `/track` will serve, and that constant's docblock says it in advance: "The
 * sweep does not exist yet; when it lands it imports this." It does. If the
 * two windows ever disagreed, `/track` would either claim a day it had
 * deleted — an empty track reading as "the machine sat idle" — or disclaim a
 * day it still holds. `machine-position-sweep` asserts the two are exact
 * complements across a range of ages rather than trusting one arithmetic.
 *
 * ## DRY RUN BY DEFAULT, and the polarity is deliberate
 *
 * `MACHINE_POSITION_SWEEP` must be set to `delete` for anything to be
 * removed. Anything else — unset, empty, `dry-run`, a typo — reports what it
 * WOULD delete and deletes nothing.
 *
 * That is the opposite of `AUDIT_FAIL_CLOSED_ENABLED`, whose default enforces
 * and whose `0` disables, and the asymmetry is the point: an audit control
 * must not be disarmed by a misspelling, and a destructive one must not be
 * ARMED by a deploy. Deploying this job is what schedules its first run, so a
 * default of `delete` would make merging the PR the authorisation for
 * destroying production data. Arming it is a separate, deliberate act.
 *
 * Read from `process.env` on every call, never hoisted — the
 * `AUDIT_FAIL_CLOSED_ENABLED` convention — so arming or disarming mid-incident
 * needs no restart.
 *
 * **The unconfigured state is LOUD, which is the other half.** A control that
 * is off and silent is indistinguishable from one that is working (#1669), so
 * every dry run logs at WARN with the backlog it would have removed. "0
 * deleted" from an armed run and "0 deleted" from an unarmed one are different
 * facts and the reading says which.
 *
 * ## A day with no derivation marker is deleted anyway, and said so loudly
 *
 * Deleting a day the derivation never processed destroys that day's work
 * permanently — the positions are gone and no `WorkedParcel` row exists, so it
 * cannot be re-derived. Keeping such days instead would break a 30-day promise
 * made to a person who cannot choose, in order to protect a farm's
 * convenience. The promise wins, and the loss is reported per run rather than
 * absorbed: `daysWithoutMarker` on the reading is the operator's signal that
 * the derivation is behind.
 *
 * #3012 proposed refusing to delete such days. That is the safer-sounding
 * option and it quietly converts a privacy commitment into "we keep it until
 * the job catches up", which is not what anybody was told.
 *
 * **Owner ruling, 2026-11-13: delete anyway, report the loss.** Put to them
 * with the three options — delete and report, hold until derived, or hold for
 * a grace period past the window — and this is the one they chose. So the
 * behaviour here is a decision rather than a default awaiting one, and
 * changing it is a decision too.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { farmDayRange, farmToday } from '@/lib/calendar-day-key';
import { isDayRetained, RAW_POSITION_RETENTION_DAYS } from '@/lib/machines/fleet-view';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';

import type { JobRunResult } from './types';

/** The one value that arms deletion. Anything else is a dry run. */
export const SWEEP_ARMED_VALUE = 'delete';

/**
 * How many rows one run may delete.
 *
 * Bounded so a first armed run over a long backlog cannot hold the queue or
 * the database for an unbounded time. What is left is deleted by the next
 * night's run, and the reading says how much remained.
 */
const DEFAULT_BATCH = 50_000;

export interface MachinePositionSweepPayload {
    /** Cap for this run. Defaults to 50,000 rows. */
    limit?: number;
    /** Override "today" — tests only; production uses the real clock. */
    today?: string;
}

/** Is deletion armed for THIS call? Read per call, never cached. */
export function sweepArmed(): boolean {
    return process.env.MACHINE_POSITION_SWEEP === SWEEP_ARMED_VALUE;
}

/**
 * The newest instant a swept row may carry: the start of the oldest day that
 * is still retained.
 *
 * Derived from `RAW_POSITION_RETENTION_DAYS` so this and `isDayRetained`
 * cannot drift. A day whose age equals the window is RETAINED (`<=` in that
 * predicate), so the cutoff is the start of that day and everything strictly
 * before it goes.
 */
export function sweepCutoff(today: string = farmToday()): Date {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - RAW_POSITION_RETENTION_DAYS);
    return farmDayRange(d.toISOString().slice(0, 10)).start;
}

export async function runMachinePositionSweep(
    payload: MachinePositionSweepPayload = {},
): Promise<{ result: JobRunResult }> {
    return runJob('machine-position-sweep', async () => {
        const jobRunId = `mps-${randomUUID()}`;
        const startedAt = new Date();
        const take = payload.limit ?? DEFAULT_BATCH;
        const today = payload.today ?? farmToday();
        const cutoff = sweepCutoff(today);
        const armed = sweepArmed();

        /*
         * Privileged and cross-tenant: retention is a platform duty, not a
         * per-farm setting, and iterating tenants would silently omit any farm
         * the loop forgot — the `usage-insights` argument for breadth.
         */
        const expired = await prisma.machinePosition.count({
            where: { recordedAt: { lt: cutoff } },
        });

        /*
         * How many (machine, day) pairs in the expired set have no derivation
         * marker — rows whose work is about to become unknowable. A READING,
         * never a gate: see the module docblock for why the promise wins.
         */
        const unmarked = await prisma.$queryRaw<Array<{ days: bigint }>>(Prisma.sql`
            SELECT COUNT(*)::bigint AS days
            FROM (
                SELECT DISTINCT p."assetId",
                       (p."recordedAt" AT TIME ZONE 'Europe/Sofia')::date AS day
                FROM "MachinePosition" p
                WHERE p."recordedAt" < ${cutoff}
            ) d
            LEFT JOIN "MachineWorkedDay" m
              ON m."assetId" = d."assetId" AND m."date" = d.day
            WHERE m."id" IS NULL
        `);
        const daysWithoutMarker = Number(unmarked[0]?.days ?? 0);

        let deleted = 0;
        if (armed && expired > 0) {
            /*
             * `deleteMany` has no `take`, so the batch is expressed as a
             * subquery over primary keys. Ordered oldest-first so a bounded run
             * always makes progress at the far end of the backlog rather than
             * nibbling at whichever rows the planner happened to find.
             */
            const removed = await prisma.$executeRaw(Prisma.sql`
                DELETE FROM "MachinePosition"
                WHERE "id" IN (
                    SELECT "id" FROM "MachinePosition"
                    WHERE "recordedAt" < ${cutoff}
                    ORDER BY "recordedAt" ASC
                    LIMIT ${take}
                )
            `);
            deleted = removed;
        }

        const remaining = Math.max(0, expired - deleted);

        /*
         * The READING, in log fields rather than a console `[tag]` line: that
         * convention is collected by a jest reporter out of a test run, so a
         * scheduled job's tagged line reaches nobody while still breaching the
         * no-console rule (the P9.3d note).
         *
         * WARN when unarmed, because an unconfigured destructive control looks
         * exactly like a working one, and the promise the product makes to
         * drivers is unmet for as long as this is a dry run.
         */
        const reading = {
            component: 'machine-position-sweep',
            jobRunId,
            mode: armed ? 'delete' : 'dry-run',
            retentionDays: RAW_POSITION_RETENTION_DAYS,
            today,
            cutoff: cutoff.toISOString(),
            expired,
            deleted,
            remaining,
            daysWithoutMarker,
        } as const;
        if (armed) {
            logger.info('machine-position-sweep.reading', reading);
            if (daysWithoutMarker > 0) {
                logger.warn('machine-position-sweep.unmarked_days_deleted', {
                    ...reading,
                    effect:
                        'raw positions were removed for machine-days the derivation '
                        + 'never processed, so that work cannot be reconstructed',
                });
            }
        } else {
            logger.warn('machine-position-sweep.dry_run', {
                ...reading,
                effect:
                    `set MACHINE_POSITION_SWEEP=${SWEEP_ARMED_VALUE} to arm; until then `
                    + 'raw positions are kept past the retention window the product '
                    + 'tells farmers about',
            });
        }

        const completedAt = new Date();
        return {
            result: {
                jobName: 'machine-position-sweep',
                jobRunId,
                success: true,
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                itemsScanned: expired,
                itemsActioned: deleted,
                // Not a failure count: what a bounded run leaves for tomorrow.
                itemsSkipped: remaining,
                details: { ...reading },
            },
        };
    });
}
