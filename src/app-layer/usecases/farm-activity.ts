/**
 * «Нов запис» for a non-chemical activity — #2316 / agrent-ios #439.
 *
 * Pruning, cultivation and harvest. Recorded as DONE in one call, like a
 * treatment: handing work to an operator stays in Задачи.
 *
 * ## It composes the same three pieces a treatment does
 *
 * One `TreatmentGroup` handle, one field operation PER BLOCK beneath it, and a
 * completion mark per line. Not because a bare activity is a treatment, but
 * because that shape is what the register reads: the ДНЕВНИК resolves a block
 * through the task's location link, so a single task spanning blocks would
 * print a parcel under a block it was never on.
 *
 * `TreatmentGroup` is reused rather than renamed. It is the handle one write
 * shares across the Tasks it creates — activity-agnostic in mechanism despite
 * its name — and it carries the `version` #2172 added, so the correction route
 * the owner approved gets optimistic concurrency for free. Renaming it would
 * touch the correction trail, the CAS and everything #2172 shipped; the naming
 * debt is the cheaper side of that trade.
 *
 * ## What it deliberately does NOT do
 *
 * No stock movement. `markOperationParcel` is told `recordedInDiary: true`,
 * which suppresses the deduction — the same ruling (#1740) that keeps a
 * treatment recorded in the diary from moving stock. A bare activity has no
 * product to deduct anyway, but the flag also makes the entry visible in the
 * manual-only list, which it must be.
 *
 * No `TreatmentCorrection` trail yet. The owner approved a correction route for
 * these (2026-10-25); until it exists the treatment correction route refuses a
 * bare handle with `NOT_A_TREATMENT`, and `mayCorrect` is false on the row.
 */

import { randomUUID } from 'node:crypto';

import { codedBadRequest, configurationError } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { ACTIVITY_LABELS_BG } from '@/lib/operations/activity-labels';
import type { RecordFarmActivityBody } from '@/lib/schemas';
import { RequestContext } from '../types';
import { assertCanWrite } from '../policies/common';
import { createFieldOperation, markOperationParcel } from './field-operation';
import type { CreateFieldOperationInput } from './field-operation';
import { resolveRecordedParcels } from './recorded-parcels';

export interface RecordFarmActivityResult {
    /** The handle — the request's `Idempotency-Key` when it sent one. */
    treatmentGroupId: string;
    tasks: number;
    /**
     * Lines completed BY THIS CALL — so a replay returns 0, because nothing
     * remained `PENDING` to mark.
     *
     * Do NOT use this as a "did it save" check. agrent-ios read it as
     * interchangeable with the treatments route's `parcelCount`, which is
     * replay-STABLE, and a replay would then have shown a farmer that nothing
     * saved when everything already had. Use `parcelCount` for that.
     */
    lines: number;
    /**
     * Total register lines under this handle, whether this call wrote them or a
     * previous one did. Replay-stable, and the same meaning the treatments
     * route's field of this name carries — which is why it has that name.
     */
    parcelCount: number;
    occurredOn: string;
    /** The `LogQuantity` id when a harvest total was recorded, else null. */
    harvestQuantityId: string | null;
}

export async function recordFarmActivity(
    ctx: RequestContext,
    input: RecordFarmActivityBody,
    idempotencyKey?: string | null,
): Promise<RecordFarmActivityResult> {
    assertCanWrite(ctx);

    // The handle IS the idempotency key when one is sent, so a replay resolves
    // on it rather than on any one of the per-block keys derived from it.
    const handle = idempotencyKey?.trim() || randomUUID();

    const { day, dayKey, treatedByParcel, byBlock } = await resolveRecordedParcels(ctx, input);

    // Created before the blocks, so a partly-written activity still has a group
    // row: a replay can then address it, rather than leaving recorded blocks
    // with no handle to find them by.
    await runInTenantContext(ctx, (db) =>
        db.treatmentGroup.upsert({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: handle } },
            create: { id: handle, tenantId: ctx.tenantId },
            // Empty: a replay must not bump `version` and invalidate an
            // `If-Match` a client is holding.
            update: {},
        }),
    );

    const taskIds: string[] = [];
    for (const [locationId, blockParcelIds] of byBlock) {
        // No product fields at all — which is what makes `resolveChosenInput`
        // return null and the lines carry three NULL dose columns. Sending any
        // of them with a bare kind is refused `ACTIVITY_APPLIES_NO_INPUT`, so
        // their absence here is the contract rather than an omission.
        const perBlock: CreateFieldOperationInput = {
            title: input.title ?? `${ACTIVITY_LABELS_BG[input.kind]}`,
            operationType: input.kind,
            // The only honest assignee for work already done is whoever
            // recorded it; the notification is suppressed below.
            assigneeUserId: ctx.userId,
            parcelIds: blockParcelIds,
        };
        const created = await createFieldOperation(
            ctx,
            locationId,
            perBlock,
            // DERIVED per block: Task is unique on (tenantId, clientMutationId),
            // so the N tasks of one activity cannot share the handle itself.
            `${handle}:${locationId}`,
            { suppressAssignmentNotification: true, treatmentGroupId: handle },
        );
        taskIds.push(created.taskId);
    }

    // ONE read for every line across every task, outside the loop above — the
    // query count must not grow with the number of blocks.
    //
    // PENDING only: on a first run that is every line, and on a retry finishing
    // a half-written activity it is exactly the remainder.
    const lines = await runInTenantContext(ctx, (db) =>
        db.operationParcel.findMany({
            where: { taskId: { in: taskIds }, tenantId: ctx.tenantId, status: 'PENDING' },
            select: { id: true, taskId: true, version: true, parcelId: true },
        }),
    );

    // Marking a line DONE is what writes the record. One mark per line, because
    // each carries its own optimistic-lock version and emits its own journal
    // entry — that is the operation's shape, not a loop to collapse.
    for (const line of lines) {
        await markOperationParcel(ctx, line.taskId, line.id, 'DONE', null, line.version, {
            recordedInDiary: true,
            occurredAt: day,
            treatedAreaHa: treatedByParcel.get(line.parcelId) ?? null,
            treatmentGroupId: handle,
        });
    }

    // Counted AFTER the marks and independently of them: `lines` above is what
    // this call did, and a client needs what EXISTS. On a replay the first is 0
    // and this is the full set.
    const parcelCount = await runInTenantContext(ctx, (db) =>
        db.operationParcel.count({ where: { tenantId: ctx.tenantId, taskId: { in: taskIds } } }),
    );

    const harvestQuantityId =
        input.kind === 'HARVEST' && input.harvestKg != null
            ? await recordHarvestTotal(ctx, taskIds, input.harvestKg)
            : null;

    return {
        treatmentGroupId: handle,
        tasks: taskIds.length,
        lines: lines.length,
        parcelCount,
        occurredOn: dayKey,
        harvestQuantityId,
    };
}

/**
 * The harvest's «Продукция» — ONE total for the activity, in kilograms.
 *
 * Owner decision 2026-10-25. **Not per parcel and not apportioned**: splitting
 * a measured total across parcels by area would write figures nobody measured
 * into a document a farmer signs. agrent-ios made that argument and it is the
 * right one.
 *
 * `LogQuantity` hangs off a `LogEntry`, and there is one entry per LINE, so a
 * single total has nowhere activity-level to sit. It goes on one line's entry
 * with `label` saying what it is — the alternative was a column on
 * `TreatmentGroup`, which is semantically exact but needs a migration and
 * creates a second place a quantity can live, which the `LogQuantity` ruling
 * had just consolidated.
 *
 * ## What the label is actually for — corrected 2026-10-25
 *
 * An earlier version of this docblock said the label was "the only thing
 * preventing" a line being misread as that parcel's yield. Both halves of that
 * turned out to be wrong, and the correction is worth keeping:
 *
 *   - **Nothing reads it.** `campaign-diary/gather.ts` was the only reader of
 *     `LogQuantity.label` in the codebase.
 *   - **That reader MISREAD it.** It took the first labelled quantity as the
 *     produce KIND — `quantities.find(q => q.label)?.label` — so «Общо за
 *     мероприятието» printed in a column headed «Вид» on a register a farmer
 *     signs. Found by backend-2 and fixed in #2364 by deriving «Вид» from the
 *     crop instead.
 *
 * So the label protected nothing and misled the one thing that looked at it. It
 * stays, because a note on the row is right for anyone reading a line directly
 * and for a future per-line view — but it is a NOTE, not a safeguard, and the
 * thing that actually prevents the misreading is that the campaign diary groups
 * by `Task.treatmentGroupId` so a line is never shown alone.
 *
 * The lesson for the next person tempted to put prose in a data column: a
 * field whose only consumer interprets it differently from its author is worse
 * than an empty one.
 */
async function recordHarvestTotal(
    ctx: RequestContext,
    taskIds: string[],
    harvestKg: number,
): Promise<string> {
    return runInTenantContext(ctx, async (db) => {
        // The entry the completion mark just wrote. Ordered so the same line
        // wins on a replay rather than an arbitrary one.
        const entry = await db.logEntry.findFirst({
            where: {
                tenantId: ctx.tenantId,
                operationParcelId: { not: null },
                operationParcel: { taskId: { in: taskIds } },
            },
            orderBy: [{ operationParcelId: 'asc' }],
            select: { id: true },
        });
        if (!entry) {
            // The mark writes the entry, so an absent one means the completion
            // did not happen — a coded refusal rather than a silent null, so a
            // caller is not told the harvest was recorded when it was not.
            throw codedBadRequest(
                'HARVEST_NOT_RECORDED',
                'The harvest produced no journal entry, so its quantity could not be recorded.',
                { reference: 'harvestKg' },
            );
        }

        // Global catalogue row — `Unit.key` is `@unique` across tenants, not per
        // farm. Its absence is a seeding fault, not something a farmer did, so
        // it is a configuration error rather than a 400.
        const kg = await db.unit.findFirst({ where: { key: 'kg' }, select: { id: true } });
        if (!kg) {
            throw configurationError(
                'The `kg` unit is missing from the catalogue, so a harvest quantity cannot be stored.',
            );
        }

        // Idempotent on a replay: one total per activity, not one per retry.
        const existing = await db.logQuantity.findFirst({
            where: { tenantId: ctx.tenantId, logEntryId: entry.id, measure: 'WEIGHT' },
            select: { id: true },
        });
        if (existing) return existing.id;

        const row = await db.logQuantity.create({
            data: {
                tenantId: ctx.tenantId,
                logEntryId: entry.id,
                measure: 'WEIGHT',
                value: harvestKg,
                unitId: kg.id,
                // What stops a reader taking this for one parcel's yield.
                label: 'Общо за мероприятието',
            },
            select: { id: true },
        });
        return row.id;
    });
}
