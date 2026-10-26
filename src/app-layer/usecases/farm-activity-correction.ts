/**
 * Correcting a bare activity — резитба, обработка на почвата, прибиране (#2373).
 *
 * Owner approved a correction route for these on 2026-10-25. They are recorded
 * through `POST /journal/activities` (#2344, #2356) and until now there was no
 * way to fix one: the treatment correction refuses a bare handle with
 * `NOT_A_TREATMENT`, because an activity has no product, dose, pest or
 * quarantine period — which is exactly what that route's correction trail
 * records changes to.
 *
 * ## It is a SEPARATE route, not a widening of the treatment one
 *
 * The fields do not overlap. Rendering a bare activity through the treatment
 * correction would prefill a form with an empty product a farmer could submit,
 * overwriting a real record with blanks — the reason `NOT_A_TREATMENT` exists
 * rather than a gap someone forgot to fill. So this mirrors that route's
 * STRUCTURE (authorship, `If-Match`, the whole-definition trail, the version
 * compare-and-swap) and shares none of its field logic.
 *
 * ## What this increment corrects, and why not more
 *
 * `occurredOn` and `harvestKg`. Deliberately not `title`, and not the parcel
 * set — both deferred on #2373 with reasons rather than for lack of time:
 *
 *   - **`title`** would not reach the farmer. The journal row's title for a bare
 *     activity is SERVER-COMPOSED — `composeFarmActivityTitle` writes a
 *     `titleKey` of `AUTO_TITLE_KEYS.farmActivity` with `{activity, parcel}`
 *     params, and the client re-renders it per locale. `Task.title` is a
 *     different string on a different surface. Offering «заглавие» here would be
 *     a control that appears to work and changes nothing in «Дневник», which is
 *     worse than its absence.
 *   - **the parcel set** needs new per-block tasks and freshly marked lines; it
 *     is most of why the treatment correction is 650 lines. Shipping the DAY —
 *     the commonest mistake, and the thing «Коригирай» mostly exists for —
 *     beats holding both.
 *
 * ## No stock, in either direction
 *
 * A bare activity moves no stock (`recordedInDiary: true` suppresses the
 * deduction per #1740, and there is no product to deduct), and a correction must
 * not introduce one. Nothing here touches inventory, and the БАБХ register is
 * untouched too: bare activities are excluded from it, so no correction made
 * here can alter a regulated document. That is why this route can be narrower
 * than the treatment one rather than merely smaller.
 */

import type { Prisma } from '@prisma/client';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { codedBadRequest, codedConflict, codedNotFound, staleData } from '@/lib/errors/types';
import { parseRecordedDay } from '@/lib/operations/recorded-day';
import { classifyFromRows, classifyHandle } from './handle-kind';
import { readCorrectionTrail, type CorrectionTrail } from './correction-trail';
import { dayKeyInTz, FARM_TIME_ZONE } from '@/lib/calendar-day-key';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { assertCanEditTreatment } from '../policies/task.policies';
import { logEvent } from '../events/audit';
import { resolveHarvestTarget } from './farm-activity';

/** One recorded parcel line of an activity, for the prefill. */
export interface FarmActivityLine {
    parcelId: string;
    parcelName: string | null;
    locationId: string | null;
    treatedAreaHa: number | null;
}

/**
 * Field-for-field re-submittable as a correction, which is the requirement
 * rather than a convenience: anything the prefill cannot express is a field a
 * correction would silently drop.
 */
export interface FarmActivityDefinition {
    treatmentGroupId: string;
    /** The GROUP's version, returned as `If-Match` on a correction. */
    version: number;
    /** PRUNE, CULTIVATE or HARVEST — never correctable (see the module docblock). */
    kind: string;
    /** `null` when no line is marked yet, so there is no farm day to show. */
    occurredOn: string | null;
    /** The one total for the activity, in kg. Null unless a HARVEST recorded one. */
    harvestKg: number | null;
    parcelCount: number;
    lines: FarmActivityLine[];
}

export interface CorrectFarmActivityInput {
    occurredOn?: string;
    /** `null` CLEARS the total — a weight recorded by mistake must be removable. */
    harvestKg?: number | null;
}

/** The fields a correction may name, in the order the trail lists them. */
const CORRECTABLE_FIELDS = ['occurredOn', 'harvestKg'] as const;

/**
 * Load an activity for reading or editing, refusing everything a correction
 * cannot act on BEFORE any write.
 *
 * The refusal ORDER is load-bearing and matches the treatment path's: not found,
 * then mixed authorship, then permission, then "this is not an activity". A
 * caller who may not edit must not learn from the error whether the handle is a
 * treatment or an activity.
 */
async function loadActivityForEdit(
    db: PrismaTx,
    ctx: RequestContext,
    handle: string,
): Promise<{ definition: FarmActivityDefinition; taskIds: string[]; lineIds: string[] }> {
    const tasks = await db.task.findMany({
        where: { tenantId: ctx.tenantId, treatmentGroupId: handle, deletedAt: null },
        select: { id: true, createdByUserId: true, operationType: true },
        orderBy: { createdAt: 'asc' },
    });
    if (tasks.length === 0) {
        throw codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
            reference: 'treatmentGroupId',
        });
    }

    const creators = new Set(tasks.map((t) => t.createdByUserId));
    if (creators.size !== 1) {
        throw codedConflict(
            'ACTIVITY_MIXED_AUTHORSHIP',
            'This activity was recorded by more than one person, so it cannot be corrected '
                + 'as a whole. The restriction applies to administrators too.',
            { reference: 'treatmentGroupId' },
        );
    }
    // The treatments rule unchanged — creator or farm admin. A correction must
    // not be easier to make than a withdrawal, and reusing the function rather
    // than restating the rule is what keeps that true if the rule moves.
    assertCanEditTreatment(ctx, { createdByUserId: tasks[0].createdByUserId });

    const taskIds = tasks.map((t) => t.id);
    const lines = await db.operationParcel.findMany({
        where: { tenantId: ctx.tenantId, taskId: { in: taskIds } },
        select: {
            id: true,
            parcelId: true,
            completedAt: true,
            treatedAreaHa: true,
            productItemId: true,
            doseValue: true,
            doseUnitId: true,
            parcel: { select: { name: true, locationId: true } },
            task: { select: { operationType: true } },
        },
        orderBy: { id: 'asc' },
    });

    // A handle whose lines APPLY something is a treatment, and it has its own
    // correction route carrying the product fields this one does not. The mirror
    // of `NOT_A_TREATMENT`.
    //
    // Checked on the LINE first, so a row whose `operationType` is null is read
    // by what it actually holds. With NO lines there is nothing to read — a
    // partially-written record — and the task's declared type decides instead.
    // Without that fallback a treatment whose lines were never marked would be
    // accepted here, and a correction would write a trail row and bump the
    // version on a record this route cannot represent.
    // ONE rule, shared with both trail reads and asked over rows already in
    // hand. Written inline here first, and that copy is exactly what let the
    // corrections READ serve an activity under a treatment's contract — the
    // discriminator existed in one place and the route that needed it had none.
    if (classifyFromRows(tasks[0], lines[0] ?? null) === 'TREATMENT') {
        throw codedBadRequest(
            'NOT_AN_ACTIVITY',
            'This record applies a product, so it is a treatment rather than a field '
                + 'activity. Correct it through the treatment route.',
            { reference: 'treatmentGroupId' },
        );
    }

    const group = await db.treatmentGroup.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: handle } },
        select: { version: true },
    });

    const stamped = lines.find((l) => l.completedAt != null);
    const kind = tasks[0].operationType ?? 'OTHER';

    // The total, read from wherever it was written rather than recomputed. Only
    // a HARVEST has one, and a non-harvest reads null rather than 0 — 0 kg is a
    // measured harvest of nothing, which is a different statement.
    const quantity =
        kind === 'HARVEST'
            ? await db.logQuantity.findFirst({
                  where: {
                      tenantId: ctx.tenantId,
                      measure: 'WEIGHT',
                      logEntry: { operationParcel: { taskId: { in: taskIds } } },
                  },
                  select: { value: true },
              })
            : null;

    return {
        definition: {
            treatmentGroupId: handle,
            version: group?.version ?? 0,
            kind,
            occurredOn: stamped?.completedAt
                ? dayKeyInTz(stamped.completedAt, FARM_TIME_ZONE)
                : null,
            harvestKg: quantity ? Number(quantity.value) : null,
            parcelCount: lines.length,
            lines: lines.map((l) => ({
                parcelId: l.parcelId,
                parcelName: l.parcel?.name ?? null,
                locationId: l.parcel?.locationId ?? null,
                treatedAreaHa: l.treatedAreaHa == null ? null : Number(l.treatedAreaHa),
            })),
        },
        taskIds,
        lineIds: lines.map((l) => l.id),
    };
}

/**
 * The prefill for «Коригирай» on a bare activity.
 *
 * WRITE-gated, like the treatment definition read and for the same reason: the
 * body is the whole record and its only purpose is to be edited and sent back.
 * `loadActivityForEdit` then applies the creator-or-admin rule, so a reader who
 * can see the activity in the journal but may not correct it gets a 403 here.
 *
 * A client deciding whether to OFFER the control should not probe this — the
 * journal list already carries a server-computed `mayCorrect` over the same
 * population.
 */
export async function getFarmActivityDefinition(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<FarmActivityDefinition> {
    assertCanWrite(ctx);
    const handle = treatmentGroupId.trim();
    if (!handle) {
        throw codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
            reference: 'treatmentGroupId',
        });
    }
    return runInTenantContext(ctx, async (db) => (await loadActivityForEdit(db, ctx, handle)).definition);
}

/**
 * The correction history of a bare activity (#2373).
 *
 * ## A READ gate, where the prefill is a write gate
 *
 * `getFarmActivityDefinition` requires `canWrite` and then creator-or-admin,
 * because its body exists to be edited. This one exists to be READ: a corrected
 * entry shows «Коригирано на … от …» with the previous values legible to an
 * inspector, and an inspector is exactly the person the prefill's 403 is for.
 * Putting the trail behind that gate would hide it from its audience.
 *
 * That is not a widening of what a reader may learn. Every `previous` is a
 * definition of the SAME activity they are already looking at; the only new fact
 * is that a value used to be different, which is the fact the record exists to
 * state.
 *
 * ## Why this route exists rather than reusing the treatments' one
 *
 * The table is shared and the envelope is identical — `readCorrectionTrail`
 * serves both, so they cannot drift. What cannot be shared is `previous`: it
 * holds the whole definition of whatever was corrected, so one endpoint would
 * return a `TreatmentDefinition` or a `FarmActivityDefinition` with nothing to
 * discriminate on, under a path naming only one of them.
 *
 * So the refusals are exact complements, as they are on the definition routes: a
 * bare handle sent to the treatments trail is `NOT_A_TREATMENT`, a treatment
 * handle sent here is `NOT_AN_ACTIVITY`. One rule for a client — gate the
 * control on `mayCorrect`, pick the address by `kind` — and no third thing to
 * learn for the history.
 */
export async function getFarmActivityCorrections(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<CorrectionTrail<FarmActivityDefinition>> {
    assertCanRead(ctx);

    const handle = treatmentGroupId.trim();
    if (!handle) {
        throw codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
            reference: 'treatmentGroupId',
        });
    }

    return runInTenantContext(ctx, async (db) => {
        // Existence from the RECORD, not from the trail: a handle with no
        // corrections and a handle that was never used both have an empty
        // trail, and answering 200 with `corrections: []` to the second would
        // confirm an activity that is not there. The existence-hiding 404 stays
        // contentless.
        const kind = await classifyHandle(db, ctx, handle);
        if (kind === null) {
            throw codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
                reference: 'treatmentGroupId',
            });
        }
        if (kind === 'TREATMENT') {
            throw codedBadRequest(
                'NOT_AN_ACTIVITY',
                'This record applies a product, so it is a treatment rather than a field '
                    + 'activity. Read its correction history through the treatment route.',
                { reference: 'treatmentGroupId' },
            );
        }

        return readCorrectionTrail<FarmActivityDefinition>(db, ctx, handle);
    });
}

export async function correctFarmActivity(
    ctx: RequestContext,
    treatmentGroupId: string,
    input: CorrectFarmActivityInput,
    expectedVersion?: number,
): Promise<FarmActivityDefinition> {
    assertCanWrite(ctx);

    const handle = treatmentGroupId.trim();
    if (!handle) {
        throw codedNotFound('ACTIVITY_NOT_FOUND', 'No activity was recorded under that handle.', {
            reference: 'treatmentGroupId',
        });
    }

    // Parsed BEFORE the transaction opens, so a malformed day is a 400 that
    // never took a row lock to discover. `parseRecordedDay` keeps the
    // `TREATMENT_` prefix on its codes because `refusal-codes-read-in-bulgarian`
    // pins their exact text — the prefix is the code's name, not a claim that
    // this is a treatment.
    const day = input.occurredOn !== undefined ? parseRecordedDay(input.occurredOn) : null;

    return runInTenantContext(ctx, async (db) => {
        // The group row must exist before the compare-and-swap has anything to
        // swap. `recordFarmActivity` upserts it the same way; `update: {}` so
        // this does not itself count as a change.
        await db.treatmentGroup.upsert({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: handle } },
            create: { id: handle, tenantId: ctx.tenantId },
            update: {},
        });

        const { definition: previous, taskIds } = await loadActivityForEdit(db, ctx, handle);

        // A harvest total on something that is not a harvest. Refused rather
        // than ignored: a client that sends it believes it recorded a weight,
        // and silently dropping it would leave «Продукция» empty on a record
        // the farmer thinks carries one.
        if (input.harvestKg !== undefined && previous.kind !== 'HARVEST') {
            throw codedBadRequest(
                'HARVEST_TOTAL_NOT_APPLICABLE',
                'Only a harvest records a quantity. Record the yield against the harvest '
                    + 'instead of this activity.',
                { reference: 'harvestKg' },
            );
        }

        // ── The precondition, against the version just read ──
        //
        // This is what `If-Match` MEANS, and the swap below is not a substitute:
        // that one guards `previous.version`, read inside this transaction
        // moments earlier, so it compares a value against itself. The swap is
        // the concurrency backstop — under READ COMMITTED another correction can
        // commit between this read and this write.
        if (expectedVersion !== undefined && expectedVersion !== previous.version) {
            throw staleData(
                'This activity was corrected by someone else while you were editing it. '
                    + 'Reopen it to see the current values.',
                { reference: 'treatmentGroupId' },
            );
        }

        const changed = CORRECTABLE_FIELDS.filter((f) => {
            if (input[f] === undefined) return false;
            if (f === 'occurredOn') return input.occurredOn !== previous.occurredOn;
            return (input.harvestKg ?? null) !== previous.harvestKg;
        });

        // A correction that changes nothing writes nothing — no trail row, no
        // version bump. Otherwise re-submitting an unchanged form would invent
        // a correction in the history of a regulated record and invalidate
        // every `If-Match` another client was holding.
        if (changed.length === 0) return previous;

        if (day) {
            // BOTH, and the register-versus-list split is why. The journal list
            // sorts and filters on `LogEntry.occurredAt`; the printed record
            // reads the line's `completedAt`. Moving one would leave the
            // corrected activity on the old day in the list while the document
            // showed the new one — two surfaces disagreeing about when the work
            // happened.
            await db.operationParcel.updateMany({
                where: {
                    tenantId: ctx.tenantId,
                    taskId: { in: taskIds },
                    completedAt: { not: null },
                },
                data: { completedAt: day.day },
            });
            await db.logEntry.updateMany({
                where: { tenantId: ctx.tenantId, treatmentGroupId: handle },
                data: { occurredAt: day.day },
            });
        }

        let harvestKg = previous.harvestKg;
        if (changed.includes('harvestKg')) {
            const next = input.harvestKg ?? null;
            const { entryId, kgUnitId } = await resolveHarvestTarget(db, ctx, taskIds);
            // Addressed by the ENTRY, not by a stored id: the total belongs to
            // whichever line `resolveHarvestTarget` picks, and both the record
            // and this correction ask it the same question in the same order.
            const existing = await db.logQuantity.findFirst({
                where: { tenantId: ctx.tenantId, logEntryId: entryId, measure: 'WEIGHT' },
                select: { id: true },
            });
            if (next === null) {
                if (existing) {
                    await db.logQuantity.delete({ where: { id: existing.id } });
                }
            } else if (existing) {
                await db.logQuantity.update({ where: { id: existing.id }, data: { value: next } });
            } else {
                await db.logQuantity.create({
                    data: {
                        tenantId: ctx.tenantId,
                        logEntryId: entryId,
                        measure: 'WEIGHT',
                        value: next,
                        unitId: kgUnitId,
                        label: 'Общо за мероприятието',
                    },
                });
            }
            harvestKg = next;
        }

        // The WHOLE previous definition, not a diff. A diff reconstructed from
        // field names needs the reader to already hold the state it was a diff
        // against, and the point of the record is that the state is gone.
        await db.treatmentCorrection.create({
            data: {
                tenantId: ctx.tenantId,
                groupId: handle,
                previous: previous as unknown as Prisma.InputJsonValue,
                changedFields: [...changed],
                correctedByUserId: ctx.userId ?? null,
            },
        });

        const bumped = await db.treatmentGroup.updateMany({
            where: { tenantId: ctx.tenantId, id: handle, version: previous.version },
            data: { version: { increment: 1 } },
        });
        if (bumped.count !== 1) {
            throw staleData(
                'This activity was corrected by someone else while you were editing it. '
                    + 'Reopen it to see the current values.',
                { reference: 'treatmentGroupId' },
            );
        }

        await logEvent(db, ctx, {
            action: 'ENTITY_UPDATED',
            entityType: 'Task',
            entityId: handle,
            details: `Activity ${handle} corrected (${changed.join(', ')})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'FarmActivity',
                operation: 'updated',
                changedFields: [...changed],
                // `before` is deliberately not sent though the schema admits it:
                // the whole previous definition is already on the
                // `TreatmentCorrection` row, and two copies of one record are
                // two things that can disagree.
                summary: `${changed.length} field(s) corrected across ${taskIds.length} block(s)`,
            },
        });

        return {
            ...previous,
            version: previous.version + 1,
            ...(day ? { occurredOn: input.occurredOn ?? previous.occurredOn } : {}),
            harvestKg,
        };
    });
}
