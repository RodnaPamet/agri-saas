/**
 * Purge the documents whose retention period has run out (#2495 step 5).
 *
 * Daily, which only decides how long past its expiry day a document waits —
 * up to 24 hours. The deadline is a calendar DAY (`expiresOn` is a day key, not
 * an instant), so a daily beat is the same granularity as the thing it
 * enforces rather than an approximation of it.
 *
 * ## The tombstone survives, and that is the whole design
 *
 * The bytes go; the row stays with `purgedAt`, `purgeReason: 'EXPIRED'` and —
 * unlike a manual delete — its NAME. Owner ruling: expiry is policy, so the
 * farm's index of what it held is the point; a manual delete is a person's
 * intent, very often "this was the wrong file", and keeping that name
 * indefinitely would preserve the one field encrypted BECAUSE it names third
 * parties.
 *
 * Dropping the row instead would make "we destroyed this by policy on 14
 * March" and "this never existed" the same observation, which for a compliance
 * register is the worse failure.
 *
 * `purgedByUserId` is NULL, because nobody did it. That is the field that
 * distinguishes the two tombstones, and the CHECK constraint from step 1
 * refuses an EXPIRED row that names a person.
 *
 * ## It defers an in-flight Drive copy, and COUNTS the deferral
 *
 * A document whose `driveState` is `PENDING` is skipped and picked up next run
 * (#2495, the in-flight decision). The retention period is a floor rather than
 * a deadline, so a cycle's grace breaks no promise — and it is the only
 * reading where turning Drive sync on protects the document it was turned on
 * for.
 *
 * The window is narrower than it looks, and knowing which window it is matters
 * for where the test goes: `PENDING` is set when a copy is ENQUEUED and the
 * copy runs within minutes, while the shortest retention is `P3M`. So a row at
 * `PENDING` on its expiry day was not caught mid-flight — the real collision
 * is an admin re-enqueueing a failed copy through the retry route on the very
 * day the document expires. The skip protects a deliberate human act.
 *
 * **The deferral is bounded by a contract this file cannot enforce**: step 4's
 * retry ceiling ends in a write to `FAILED`, never leaving a row at `PENDING`
 * with its retries exhausted. If that ever stops holding, this sweep skips
 * those rows for ever — so `deferredForDriveCopy` is reported beside the purge
 * count, and a non-zero value persisting across runs is the signal that
 * something is stuck. Without it a dropped job leaves documents that should
 * have been destroyed sitting indefinitely, evidenced only by their absence
 * from a count nobody reads. This is a retention register; an inspection finds
 * that hole, not a test.
 *
 * This sweep READS `driveState` and never writes it. Every transition of that
 * column, including the one to `FAILED` that bounds the deferral, belongs to
 * step 4.
 *
 * ## Cross-tenant, on the privileged client
 *
 * Retention is a platform duty rather than a tenant action, and the index that
 * serves it — `@@index([expiresOn, purgedAt])` — deliberately does not lead
 * with `tenantId` for that reason. Same shape as `lease-expiry-sweep`.
 */
import { randomUUID } from 'node:crypto';

import { farmToday } from '@/lib/calendar-day-key';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { getStorageProvider } from '@/lib/storage';

// The payload type is IMPORTED rather than redeclared here. Its siblings
// (`AccountErasureSweepPayload`, `NoticeScorePayload`, …) are defined in BOTH
// `types.ts` and their job file — structurally identical, so TypeScript
// accepts it and the duplication is invisible until the two drift. `types.ts`
// is the one `JobPayloadMap` reads, so it is the authority; importing from it
// means a change to the payload cannot be made in a place the registry does
// not see.
import type { DocumentRetentionSweepPayload, JobRunResult } from './types';

export type { DocumentRetentionSweepPayload };

/**
 * How many per run.
 *
 * Each purge is a short transaction plus one object delete, so this is bounded
 * by the object store rather than by the pool. Generous against any plausible
 * volume for this deployment — a document not reached today is reached
 * tomorrow, and `orderBy: expiresOn asc` means the oldest debt goes first
 * rather than whichever row the planner happened to return.
 */
const DEFAULT_BATCH = 200;

export async function runDocumentRetentionSweep(
    payload: DocumentRetentionSweepPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `drs-${randomUUID()}`;
    const startedAt = new Date();
    const take = payload.limit ?? DEFAULT_BATCH;
    const today = payload.today ?? farmToday();

    const due = await prisma.farmDocument.findMany({
        where: {
            // `not: null` is redundant in SQL — a comparison against NULL is
            // never true, so «Без срок» rows are excluded by `lte` alone — and
            // it is written anyway because that is the one thing about this
            // query a reader must not have to work out. A nullable column
            // under a `lte` is exactly where null quietly behaves like the
            // beginning of time and deletes everything.
            expiresOn: { not: null, lte: today },
            purgedAt: null,
        },
        orderBy: { expiresOn: 'asc' },
        take,
        select: {
            id: true,
            tenantId: true,
            driveState: true,
            expiresOn: true,
            fileRecordId: true,
            fileRecord: { select: { pathKey: true, status: true } },
        },
    });

    let purged = 0;
    let deferredForDriveCopy = 0;
    let failed = 0;

    for (const doc of due) {
        // The deferral. Read-only on `driveState`; step 4 owns every write.
        if (doc.driveState === 'PENDING') {
            deferredForDriveCopy += 1;
            continue;
        }

        try {
            // The tombstone and the FileRecord move together: a document
            // marked purged whose record still reads STORED is a state the
            // download gate would serve from, and the gate asks the record.
            await prisma.$transaction(async (tx) => {
                await tx.farmDocument.update({
                    where: { id: doc.id },
                    data: {
                        purgedAt: new Date(),
                        purgeReason: 'EXPIRED',
                        // NULL: nobody did it. `name` is deliberately NOT
                        // touched — an EXPIRED tombstone keeps it.
                        purgedByUserId: null,
                    },
                });
                await tx.fileRecord.update({
                    where: { id: doc.fileRecordId },
                    data: { status: 'DELETED' },
                });
            });
            purged += 1;
        } catch (err) {
            failed += 1;
            logger.error('document-retention-sweep.tombstone_failed', {
                component: 'document-retention-sweep',
                tenantId: doc.tenantId,
                documentId: doc.id,
                error: err instanceof Error ? err.message : String(err),
            });
            // Nothing was stamped, so tomorrow's run selects it again. Do NOT
            // delete the bytes: they still belong to a document the database
            // says is live.
            continue;
        }

        // Bytes AFTER the commit, and a failure here is logged rather than
        // thrown. The tombstone is the record the farm reads; undoing it
        // because the object store was briefly unreachable would leave a
        // document the register says is destroyed and the server still has.
        // The orphaned object is bounded and visible in this log line.
        try {
            await getStorageProvider().delete(doc.fileRecord.pathKey);
        } catch (err) {
            logger.error('document-retention-sweep.bytes_survived_tombstone', {
                component: 'document-retention-sweep',
                tenantId: doc.tenantId,
                documentId: doc.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (deferredForDriveCopy > 0) {
        // WARN rather than info: the expected value is zero, because the
        // window is an admin retry landing on an expiry day. A standing
        // non-zero count means step 4's ceiling is not ending at FAILED, and
        // the documents involved are being kept past their retention.
        logger.warn('document-retention-sweep.deferred_for_drive_copy', {
            component: 'document-retention-sweep',
            count: deferredForDriveCopy,
            today,
        });
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'document-retention-sweep',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: due.length,
            itemsActioned: purged,
            itemsSkipped: deferredForDriveCopy + failed,
            // `success: true` with a non-zero skip count is the honest shape:
            // the RUN worked, and a deferral or a failure is the finding. The
            // two are reported SEPARATELY because they mean different things —
            // one is a document being protected, the other is a document that
            // should have been destroyed and was not.
            details: { deferredForDriveCopy, failed, today },
        },
    };
}
