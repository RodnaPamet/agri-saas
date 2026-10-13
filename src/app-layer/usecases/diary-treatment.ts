import { randomUUID } from 'node:crypto';
import { farmToday } from '@/lib/calendar-day-key';
import { RequestContext } from '../types';
import { assertCanWrite } from '../policies/common';
import { codedBadRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { createFieldOperation, markOperationParcel } from './field-operation';
import type { CreateFieldOperationInput } from './field-operation';

/**
 * Record a treatment a farmer already carried out, across parcels in any
 * number of blocks, as one request (#1740).
 *
 * This is the write behind the two-step «Нов запис»: the fields, then the
 * crop's parcels across the whole farm, then save. It composes machinery that
 * already exists rather than reimplementing it — `createFieldOperation` for
 * the per-block validation and prescription lines, `markOperationParcel` for
 * completing each one, which is what emits the ДНЕВНИК-feeding journal entry.
 *
 * ## One task per block, which is not a style choice
 *
 * The БАБХ register joins `Location → taskLink → DONE operationParcel`
 * (`field-operation.ts`). A single task linking three blocks would therefore
 * match ALL of its parcels under EACH of them, printing a parcel's treatment
 * under a block it was never on — in the document a farmer hands to an
 * inspector. So N blocks become N tasks, each linking only its own.
 *
 * The request is consequently atomic PER BLOCK rather than across the whole
 * treatment, which is what #1740 sanctioned ("applied atomically per block").
 * A partial failure leaves the blocks that committed recorded and the rest
 * absent, and the replay path below finishes the job rather than duplicating
 * it.
 *
 * ## The handle
 *
 * Every task of one treatment carries the same `treatmentGroupId`, which is
 * what the client holds: the write returns it, the per-entry PDF takes it, the
 * list folds on it, and edit/delete act on it. None of the other ids can be
 * that handle — a treatment over 12 parcels in 3 blocks is 3 tasks and 12
 * journal entries.
 *
 * Its value is the request's `Idempotency-Key` when one is sent, so a client
 * knows the handle before the response arrives and a lost 200 does not cost it
 * the id.
 *
 * ## Idempotency is request-level, and has to be
 *
 * `recordInputApplication` is already idempotent — but on `operationParcelId`,
 * which protects a replay of a line that EXISTS. A replayed request mints new
 * lines with new ids, so that check never fires. The guard is therefore the
 * key, resolved against `treatmentGroupId`.
 *
 * Per-block keys are DERIVED from it (`<key>:<locationId>`), because
 * `Task` is `@@unique([tenantId, clientMutationId])` and N tasks cannot share
 * one. The cost batch derives per-line keys the same way.
 *
 * ## What it deliberately does not do
 *
 * **No stock deduction** — owner ruling 2026-10-13. The Дневник is a
 * compliance record; stock stays managed through Задачи and adjustments. That
 * is carried by `recordedInDiary`, which `recordInputApplication` reads to
 * suppress the CONSUMPTION, so there is no way to record a diary treatment
 * that deducts.
 *
 * **No assignment notification.** This function requires an assignee, so the
 * only honest one for work already done is the person recording it — who must
 * not then be emailed about it. See #1755: nothing compares the assignee
 * against the actor, so any self-assignment notifies today.
 */
export interface RecordDiaryTreatmentInput {
    /** Spraying fills химични обработки; fertilising fills торове. */
    kind: 'SPRAY' | 'FERTILIZE';
    /**
     * The calendar DAY the treatment happened, `yyyy-mm-dd`.
     *
     * A day and not an instant, because that is what the register records and
     * what a farmer knows. It dates both the journal entries and the lines —
     * a backdated treatment stamped with the save time would sort as today's
     * and fall outside a period filter, silently absent from the document for
     * the period it happened in.
     */
    occurredOn: string;
    /** Parcels from ANY number of blocks; grouped here, not by the caller. */
    parcelIds: string[];
    productName?: string;
    productItemId?: string;
    fertilizerName?: string;
    fertilizerItemId?: string;
    /** ЗЗР рег. № for a pesticide the farm does not have yet. */
    pppRegistrationNo?: string;
    /** Карантинен срок, per entry — the phone prefills and lets it be edited. */
    quarantinePeriodDays?: number;
    newProductCategory?: 'PESTICIDE' | 'FERTILIZER';
    /** Вредител — the pest or disease treated. */
    targetNote?: string;
    doseValue: number;
    doseUnitId: string;
    /** Техника за приложение. */
    applicationTechnique?: string;
    title?: string;
}

export interface RecordDiaryTreatmentResult {
    /** The handle. One per treatment, stable across a replay. */
    treatmentGroupId: string;
    /** Parcels actually recorded, so a saved screen stays truthful on a replay. */
    parcelCount: number;
    /** One per block, in the order the blocks were written. */
    taskIds: string[];
    /** True when this request reconstructed an earlier one rather than writing. */
    replayed: boolean;
}

/**
 * Midnight UTC on the given calendar day.
 *
 * Parsed strictly rather than handed to `new Date(string)`: that accepts
 * plenty of things that are not a day (`'2026-3'`, `'tomorrow'` in some
 * runtimes) and silently resolves others against the server's zone, which
 * would move a treatment across a date boundary depending on where the server
 * runs.
 */
function parseTreatmentDay(value: string): { day: Date; key: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) {
        throw codedBadRequest(
            'TREATMENT_DATE_INVALID',
            'The treatment date must be a calendar day in the form YYYY-MM-DD.',
            { field: 'occurredOn' },
        );
    }
    const [, y, mo, d] = m;
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    // Round-trip check: `Date.UTC(2026, 1, 31)` silently becomes 2 March, so
    // a nonsense day would otherwise be accepted and recorded as a real one.
    if (
        day.getUTCFullYear() !== Number(y) ||
        day.getUTCMonth() !== Number(mo) - 1 ||
        day.getUTCDate() !== Number(d)
    ) {
        throw codedBadRequest(
            'TREATMENT_DATE_INVALID',
            'That calendar day does not exist.',
            { field: 'occurredOn' },
        );
    }
    // The key is the day as the register writes it, rebuilt from the matched
    // groups rather than re-derived from `day` — `day` is a UTC instant and
    // reading a calendar day back out of it is the mistake this function
    // exists to prevent one level down.
    return { day, key: `${y}-${mo}-${d}` };
}

export async function recordDiaryTreatment(
    ctx: RequestContext,
    input: RecordDiaryTreatmentInput,
    idempotencyKey?: string | null,
): Promise<RecordDiaryTreatmentResult> {
    assertCanWrite(ctx);

    const { day, key: dayKey } = parseTreatmentDay(input.occurredOn);
    // Compared against today AS THE FARM SEES IT, not as the server's UTC
    // clock sees it.
    //
    // This comment used to claim the UTC comparison meant "today" is never
    // refused for a farm whose clock is ahead of the server's, and that was
    // exactly backwards. `new Date()` with `setUTCHours(23,59,59,999)` is the
    // end of the SERVER's day: at 00:30 on 14 October in Sofia it is 21:30
    // UTC on the 13th, so `2026-10-14` parsed as UTC midnight sat PAST the
    // end of UTC the 13th and a farmer recording what they had just sprayed
    // got TREATMENT_DATE_IN_FUTURE. Every night from local midnight to 03:00
    // (02:00 in winter), while the screen beside them — rendered through
    // `format-date.ts`, in the same zone — showed that day as today. The
    // guard refused the one day it most needed to allow.
    //
    // String comparison on `YYYY-MM-DD`: fixed-width and zero-padded, so
    // lexicographic order is calendar order, and there is no Date arithmetic
    // to get wrong at a DST boundary.
    if (dayKey > farmToday()) {
        throw codedBadRequest(
            'TREATMENT_DATE_IN_FUTURE',
            'A treatment cannot be recorded for a future date.',
            { field: 'occurredOn' },
        );
    }

    if (input.parcelIds.length === 0) {
        throw codedBadRequest(
            'TREATMENT_NO_PARCELS',
            'Select at least one parcel that was treated.',
            { field: 'parcelIds' },
        );
    }

    const treatmentGroupId = idempotencyKey?.trim() || randomUUID();

    // ── Replay ──────────────────────────────────────────────────────────
    //
    // Resolved on the HANDLE rather than on the per-block derived keys,
    // because the handle is the one thing a replay of the same treatment is
    // guaranteed to carry. A per-block lookup would also have to know the
    // block set, which is what the replay is trying to avoid recomputing.
    const existing = await runInTenantContext(ctx, (db) =>
        db.task.findMany({
            where: { tenantId: ctx.tenantId, treatmentGroupId, deletedAt: null },
            select: { id: true, _count: { select: { operationParcels: true } } },
            orderBy: { createdAt: 'asc' },
        }),
    );
    if (existing.length > 0) {
        const parcelCount = existing.reduce((n, t) => n + t._count.operationParcels, 0);
        // A group whose tasks carry NO lines is the partial-commit shape
        // `createFieldOperation` documents: the task committed and its
        // second transaction died. Answering 200 with `parcelCount: 0` would
        // tell the client it synced and let its outbox drop the body, so fall
        // through and finish the job from this request instead.
        if (parcelCount > 0) {
            return {
                treatmentGroupId,
                parcelCount,
                taskIds: existing.map((t) => t.id),
                replayed: true,
            };
        }
    }

    // ── Group the flat parcel list by block ─────────────────────────────
    //
    // The caller sends one list across the whole farm; which block each
    // parcel sits in is the server's to know. A parcel the tenant does not
    // own simply is not returned, so the difference in counts is the refusal.
    const parcels = await runInTenantContext(ctx, (db) =>
        db.parcel.findMany({
            where: { id: { in: input.parcelIds }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, locationId: true },
        }),
    );
    if (parcels.length !== input.parcelIds.length) {
        // One code for the whole cross-tenant class (owner ruling), with the
        // entity in `params.reference`. 400 and not 404 deliberately: a 404
        // would confirm the parcel exists in SOME tenant, which is what a
        // cross-tenant probe is for.
        throw codedBadRequest(
            'REFERENCE_NOT_IN_TENANT',
            'One or more chosen parcels were not found or belong to a different tenant',
            { reference: 'parcels' },
        );
    }

    const byBlock = new Map<string, string[]>();
    for (const p of parcels) {
        const list = byBlock.get(p.locationId);
        if (list) list.push(p.id);
        else byBlock.set(p.locationId, [p.id]);
    }

    // ── One field operation per block ───────────────────────────────────
    const isFertilizer = input.kind === 'FERTILIZE';
    const taskIds: string[] = [];
    let parcelCount = 0;

    for (const [locationId, blockParcelIds] of byBlock) {
        // NO `as CreateFieldOperationInput` here, deliberately. The first
        // version of this object carried one, and it hid two real errors that
        // tsc would otherwise have caught: the fertiliser fields are
        // `fertilizerDoseValue`/`fertilizerDoseUnitId` rather than
        // `...RateValue`, and `newProductRegistration` is an OBJECT, not the
        // registration string. Both would have silently dropped data — the
        // fertiliser dose would never have reached the line.
        const perBlock: CreateFieldOperationInput = {
            title: input.title,
            operationType: isFertilizer ? 'FERTILIZE' : 'SPRAY',
            // The only honest assignee for work already done is whoever
            // recorded it. The notification is suppressed below.
            assigneeUserId: ctx.userId,
            parcelIds: blockParcelIds,
            targetNote: input.targetNote ?? null,
            applicationTechnique: input.applicationTechnique ?? null,
            ...(isFertilizer
                ? {
                      fertilizerItemId: input.fertilizerItemId ?? null,
                      fertilizerName: input.fertilizerName ?? null,
                      fertilizerDoseValue: input.doseValue,
                      fertilizerDoseUnitId: input.doseUnitId,
                  }
                : {
                      productItemId: input.productItemId ?? null,
                      productName: input.productName ?? null,
                      doseValue: input.doseValue,
                      doseUnitId: input.doseUnitId,
                      newProductCategory: input.newProductCategory ?? null,
                      // Consulted only when a typed name has to CREATE a
                      // product. Built from the flat fields the phone sends,
                      // and omitted entirely when it carries nothing, so an
                      // empty object cannot look like a declared registration.
                      ...(input.pppRegistrationNo != null ||
                      input.quarantinePeriodDays != null
                          ? {
                                newProductRegistration: {
                                    pppRegistrationNo: input.pppRegistrationNo ?? null,
                                    quarantinePeriodDays: input.quarantinePeriodDays ?? null,
                                },
                            }
                          : {}),
                  }),
        };

        const created = await createFieldOperation(
            ctx,
            locationId,
            perBlock,
            // DERIVED per block: Task is unique on (tenantId, clientMutationId),
            // so the N tasks of one treatment cannot share the handle itself.
            `${treatmentGroupId}:${locationId}`,
            { suppressAssignmentNotification: true, treatmentGroupId },
        );
        taskIds.push(created.taskId);
        parcelCount += created.parcelCount;
    }

    // ── Complete every line, which is what writes the record ────────────
    //
    // ONE read for every line across every task, deliberately outside the
    // loop above. Reading them per block was an N+1 that
    // `query-shape-guardrails` caught, and hoisting it is simply better:
    // the number of queries no longer grows with the number of blocks a
    // treatment touches.
    //
    // Marking a line DONE is what emits its INPUT_APPLICATION journal entry.
    // `recordedInDiary` makes that entry visible in the manual-only list AND
    // suppresses the stock deduction; `occurredAt` dates both the entry and
    // the line by the treatment's own day.
    //
    // The marks themselves stay one-per-line, because each carries its own
    // optimistic-lock version and emits its own journal entry — that is the
    // operation's shape rather than a loop that could be collapsed.
    const lines = await runInTenantContext(ctx, (db) =>
        db.operationParcel.findMany({
            where: { taskId: { in: taskIds }, tenantId: ctx.tenantId },
            select: { id: true, taskId: true, version: true },
        }),
    );
    for (const line of lines) {
        await markOperationParcel(
            ctx,
            line.taskId,
            line.id,
            'DONE',
            input.targetNote ?? null,
            line.version,
            { recordedInDiary: true, occurredAt: day },
        );
    }

    return { treatmentGroupId, parcelCount, taskIds, replayed: false };
}
