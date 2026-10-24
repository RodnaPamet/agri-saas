import { randomUUID } from 'node:crypto';
import { dayKeyInTz, FARM_TIME_ZONE, farmToday } from '@/lib/calendar-day-key';
import { RequestContext } from '../types';
import { assertCanAdmin, assertCanRead, assertCanWrite } from '../policies/common';
import {
    assertCanDeleteTreatment,
    assertCanEditTreatment,
    canDeleteTreatment,
} from '../policies/task.policies';
import { codedBadRequest, codedClientError, codedConflict, codedNotFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { withDeleted } from '@/lib/soft-delete';
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
    /** Фенофаза/BBCH as observed on the day, stored per line (#2072). */
    phenophase?: string;
    /** Per-parcel treated area in hectares; absent means the whole parcel (#2072). */
    parcels?: Array<{ parcelId: string; treatedAreaHa: number }>;
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

/**
 * How much of a treatment is actually RECORDED, counted the only way that
 * means anything.
 *
 * A line is created `PENDING` by `createFieldOperation` and marked `DONE`
 * afterwards, and **the mark is what writes the ДНЕВНИК entry**. So the
 * existence of a line says the work was planned, not that it was recorded.
 *
 * This replaced `parcelCount > 0`, which counted lines and therefore reported
 * a treatment as complete the moment the FIRST block's lines committed — even
 * with nothing marked and no register entry anywhere. Deterministic repro,
 * no killed transaction needed: send a sample-archetype product. Creation is
 * allowed, the first mark throws `PRODUCT_IS_SAMPLE_ARCHETYPE`, and the old
 * code then answered `complete: true` with `occurredOn: null` and replayed a
 * retry that finished nothing. The contradiction in that pair — complete, yet
 * undatable, because nothing was ever marked — is the tell.
 *
 * One function, because the write's replay arm and the read's `complete` are
 * the same question. Two spellings would let a retry short-circuit on a
 * treatment the read calls incomplete.
 *
 * Two counts rather than fetching the lines: bounded regardless of how many
 * parcels a treatment touches.
 */
async function summariseTreatmentLines(
    ctx: RequestContext,
    taskIds: string[],
): Promise<{ parcelCount: number; completedCount: number; complete: boolean }> {
    if (taskIds.length === 0) return { parcelCount: 0, completedCount: 0, complete: false };
    return runInTenantContext(ctx, async (db) => {
        const [parcelCount, completedCount] = await Promise.all([
            db.operationParcel.count({
                where: { tenantId: ctx.tenantId, taskId: { in: taskIds } },
            }),
            db.operationParcel.count({
                where: { tenantId: ctx.tenantId, taskId: { in: taskIds }, status: 'DONE' },
            }),
        ]);
        return {
            parcelCount,
            completedCount,
            complete: parcelCount > 0 && completedCount === parcelCount,
        };
    });
}

/** What a treatment looks like when asked for by its handle. */
export interface DiaryTreatmentSummary {
    treatmentGroupId: string;
    /** Lines across every block — planned, not necessarily recorded. */
    parcelCount: number;
    /** Of those, how many are DONE and so have a register entry. */
    completedCount: number;
    /** One per block, oldest first. */
    taskIds: string[];
    /** The calendar day the treatment happened, `YYYY-MM-DD`. */
    occurredOn: string | null;
    /**
     * Фенофаза/BBCH as recorded, so an entry reopened for editing shows what
     * was saved rather than an empty field (#2072).
     *
     * Read from the same first stamped line as `occurredOn`, and uniform
     * across the treatment for the same reason: one request writes one value
     * to every line it marks.
     *
     * `null` means not captured — including every line written before the
     * column existed.
     */
    phenophase: string | null;
    /**
     * True only when EVERY line is DONE.
     *
     * A line is created PENDING and marked DONE afterwards, and the mark is
     * what writes the ДНЕВНИК entry. So `complete` asks whether the register
     * actually has the treatment, not whether rows exist.
     *
     * It is a THIRD answer, not a detail, and a client needs all three after
     * a save whose response was lost:
     *
     *   404                  nothing landed      -> safe to write afresh
     *   200 complete: true   fully recorded      -> do not write again
     *   200 complete: false  partly recorded     -> retry on the SAME handle,
     *                                               which finishes the rest
     *
     * ## The partial state is NOT "a task with no lines"
     *
     * That was this field's first definition and it was wrong — the handle is
     * stamped in the same transaction as the lines, so a task with no lines
     * has no handle and the read answers 404. It is unreachable from the
     * write, and the test for it had to build the row by hand. **Needing to
     * fabricate a state is the warning that it may not be the state that
     * happens.**
     *
     * The reachable partial state is lines that exist and are not all marked:
     * every block's lines are created first, then marked, so any failure in
     * the mark loop leaves earlier blocks recorded and later ones not. A
     * sample-archetype product reproduces it with no fault injection —
     * creation is allowed and the first mark throws
     * `PRODUCT_IS_SAMPLE_ARCHETYPE`.
     *
     * Collapsing it into either neighbour is a real defect in both
     * directions: as a 404 the client writes a duplicate treatment; as a
     * plain 200 it reports a compliance record whose lines never reached the
     * register.
     */
    complete: boolean;
}

/**
 * Look a treatment up by its handle (#1740).
 *
 * Exists because the write REPLAYS a reused `Idempotency-Key` without
 * comparing the body (owner ruling 2026-10-14, #1765). That makes this read
 * load-bearing rather than convenient: a save whose response is lost, followed
 * by an edit, goes out under a NEW key and writes a SECOND treatment if the
 * first had landed. Asking whether the earlier handle exists is the only way a
 * client can tell, so this ships with the write rather than after the PDF.
 *
 * Returns `null` rather than throwing, so the route owns the 404 and the
 * per-entry PDF can reuse this without catching.
 */
export async function getDiaryTreatment(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<DiaryTreatmentSummary | null> {
    assertCanRead(ctx);

    const handle = treatmentGroupId.trim();
    if (!handle) return null;

    const tasks = await runInTenantContext(ctx, (db) =>
        db.task.findMany({
            where: { tenantId: ctx.tenantId, treatmentGroupId: handle, deletedAt: null },
            select: {
                id: true,
                // One MARKED line is enough to date the treatment — every line
                // is stamped with the same day. An unmarked line has no date
                // at all, which is why the filter is here and not in code.
                operationParcels: {
                    where: { completedAt: { not: null } },
                    select: { completedAt: true, phenophase: true },
                    take: 1,
                },
            },
            orderBy: { createdAt: 'asc' },
        }),
    );

    if (tasks.length === 0) return null;

    const taskIds = tasks.map((t) => t.id);
    const { parcelCount, completedCount, complete } = await summariseTreatmentLines(ctx, taskIds);
    const stamped = tasks.flatMap((t) => t.operationParcels)[0];

    return {
        treatmentGroupId: handle,
        parcelCount,
        completedCount,
        taskIds,
        // Read back from the UTC date parts, which is the exact inverse of how
        // the write stored it (`Date.UTC(y, mo, d)` for the farm's calendar
        // day). This is deliberately NOT `farmToday`'s zone: converting a
        // stored UTC midnight into Sofia and taking ITS date would be a second
        // conversion of a value already converted once, and near midnight it
        // would hand back the wrong day.
        occurredOn: stamped?.completedAt ? stamped.completedAt.toISOString().slice(0, 10) : null,
        phenophase: stamped?.phenophase ?? null,
        complete,
    };
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
    //
    // ONE query, both states. The live tasks drive the replay below; the
    // soft-deleted ones mean this handle was ABANDONED, and resending it must
    // not quietly undo that — see the refusal immediately after.
    const priorTasks = await runInTenantContext(ctx, (db) =>
        db.task.findMany(
            // `withDeleted`, or this read cannot see the thing it is for.
            //
            // A Prisma extension injects `deletedAt: null` into every read of
            // a soft-delete model unless the caller names `deletedAt` or opts
            // out through this helper (`src/lib/soft-delete.ts`). Omitting it
            // here returned ZERO rows for an abandoned handle, so the refusal
            // below never fired and the resend recreated the treatment — the
            // exact hole this change exists to close, reproduced by the fix
            // for it. The integration test caught that because it reads the
            // same rows through a RAW client, which the extension does not
            // wrap.
            withDeleted({
                where: { tenantId: ctx.tenantId, treatmentGroupId },
                select: { id: true, deletedAt: true },
                orderBy: { createdAt: 'asc' as const },
            }),
        ),
    );
    const existing = priorTasks.filter((t) => t.deletedAt === null);

    /**
     * A resend of an ABANDONED handle is refused, not honoured (#1777 follow-up).
     *
     * Found by the agrent-ios session reading the merged code, and it is a
     * hole this endpoint's own fix opened. The abandon releases
     * `clientMutationId` so the handle stops colliding, and the replay lookup
     * only sees live tasks — so a client still retrying would sail past the
     * replay, reach the create path, and write the WHOLE treatment again
     * under the same handle.
     *
     * That is not theoretical: the phone's outbox resends a treatment whose
     * 201 came back short on every launch and foreground (agrent-ios #325).
     * So an admin abandons a stuck treatment, the phone wakes up, and the
     * treatment is back — every parcel with its ДНЕВНИК entry. Worse when the
     * dead-end cause was a task in a terminal status, because the fresh tasks
     * do not share it: the resend COMPLETES, and the abandon is undone with
     * nobody seeing it happen.
     *
     * 410 rather than 404 or 409: the treatment existed and was deliberately
     * removed, which is exactly what Gone means, and it tells a client the
     * difference between "never landed, write afresh" (404) and "do not send
     * this again". A client that wants to record the work after all mints a
     * new handle, which both clients already do per save.
     *
     * This is now the load-bearing protection, and the `clientMutationId`
     * release is not redundant behind it: the key belongs to a dead row, and
     * leaving it there would trip any future path that creates with the same
     * derived key.
     */
    if (existing.length === 0 && priorTasks.length > 0) {
        throw codedClientError(
            410,
            'TREATMENT_ABANDONED',
            'This treatment was abandoned by an administrator. Do not send it again — ' +
                'record it afresh under a new key if the work still needs a register entry.',
            { reference: 'treatmentGroupId' },
        );
    }

    if (existing.length > 0) {
        const prior = await summariseTreatmentLines(ctx, existing.map((t) => t.id));
        // Replay ONLY a treatment that is fully recorded.
        //
        // Anything less falls through and this request finishes the job. That
        // is safe to re-run: each block's operation carries the derived
        // idempotency key `<handle>:<locationId>` under a unique index, so a
        // block that already exists is replayed rather than duplicated, and
        // the mark loop below only touches lines still PENDING.
        //
        // The old test was `parcelCount > 0`, which short-circuited on a
        // half-finished treatment and returned `replayed: true` having
        // finished nothing — the retry became a no-op exactly when it was
        // needed, and the client was told it had synced.
        if (prior.complete) {
            return {
                treatmentGroupId,
                parcelCount: prior.parcelCount,
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
            select: { id: true, locationId: true, areaHa: true },
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

    // ── Treated area, bounded by the parcel itself (#2072 part B) ──────
    //
    // Here rather than in the request schema because only this point holds the
    // parcel row. The structural half — every `parcels[].parcelId` appearing in
    // `parcelIds`, and no parcel twice — is already refused by the schema.
    //
    // A parcel whose own `areaHa` is NULL has nothing to bound against. Such a
    // line accepts any positive value rather than being refused for a fact
    // nobody recorded: `Parcel.areaHa` is nullable and a farm can hold parcels
    // with no measured area, and refusing there would block a legitimate
    // register entry over missing cadastral data.
    const treatedByParcel = new Map<string, number>();
    if (input.parcels?.length) {
        const areaOf = new Map(parcels.map((p) => [p.id, p.areaHa]));
        for (const entry of input.parcels) {
            const area = areaOf.get(entry.parcelId);
            if (area != null && entry.treatedAreaHa > Number(area)) {
                throw codedBadRequest(
                    'TREATMENT_AREA_EXCEEDS_PARCEL',
                    'The treated area cannot exceed the parcel\u2019s own area',
                    { reference: 'parcels' },
                );
            }
            treatedByParcel.set(entry.parcelId, entry.treatedAreaHa);
        }
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

    // ── Refuse a sample product BEFORE anything is written ──────────────
    //
    // `markOperationParcel` refuses a sample-archetype product on the way into
    // DONE (`PRODUCT_IS_SAMPLE_ARCHETYPE`), and that check is correct where it
    // is. But by then this write has already created the blocks and their
    // lines, so the refusal leaves a PARTIAL treatment — and because the cause
    // repeats, every retry fails identically at the same point. The treatment
    // can then be neither finished nor abandoned by a client: there is no
    // delete-by-handle yet.
    //
    // That is the one reachable way to strand a treatment, and it is reachable
    // only by ID — a typed NAME never resolves to a sample, and a created
    // product is never one. So checking the id here costs one bounded read and
    // removes the whole class: the request refuses with nothing written, which
    // is what a 4xx should mean.
    //
    // Deliberately only the ids. This is not a second copy of the archetype
    // rule — `markOperationParcel` remains the authority and still refuses
    // anything that reaches it by another path. This is a pre-flight so the
    // common path fails cleanly.
    const inputItemIds = [input.productItemId, input.fertilizerItemId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (inputItemIds.length > 0) {
        const archetypes = await runInTenantContext(ctx, (db) =>
            db.item.findMany({
                where: { id: { in: inputItemIds }, tenantId: ctx.tenantId, isArchetype: true },
                select: { name: true },
            }),
        );
        if (archetypes.length > 0) {
            throw codedBadRequest(
                'PRODUCT_IS_SAMPLE_ARCHETYPE',
                `"${archetypes[0].name}" is a sample product, not a registered one. ` +
                    `The farm record requires a product's trade name, so add your ` +
                    `own product and select it before recording this treatment.`,
                { product: archetypes[0].name },
            );
        }
    }

    // ── The group row, before the blocks ────────────────────────────────
    //
    // #2172 gave the treatment a row so a correction has a unit to commit in
    // and somewhere to keep a version. This is where it comes into existence.
    //
    // BEFORE the loop, not inside it and not after: each block is its own
    // transaction (`createFieldOperation`), and this write is atomic PER BLOCK
    // by #1740's decision, so a partial failure leaves the committed blocks
    // recorded. Creating the group first means a partial treatment still has a
    // group row — the same shape it has today, plus the row — and the replay
    // path finishes the job. Creating it afterwards would leave the one state
    // nothing can describe: recorded blocks with no group.
    //
    // `upsert`, because the replay path re-enters this function with the same
    // handle and a second `create` would fail on the primary key. The update
    // branch is deliberately EMPTY: a replay is the same write arriving twice,
    // not a change, so it must not bump `version`.
    await runInTenantContext(ctx, (db) =>
        db.treatmentGroup.upsert({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: treatmentGroupId } },
            create: { id: treatmentGroupId, tenantId: ctx.tenantId },
            update: {},
        }),
    );

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
            // PENDING only. On a first run that is every line; on a retry
            // finishing a half-written treatment it is exactly the remainder.
            //
            // The positive state, not `not: 'DONE'`, so a line a person
            // CANCELLED is never silently marked done by a replay. That is
            // the case this filter actually protects.
            //
            // It is NOT what stops a retry duplicating register entries —
            // measured: dropping the filter leaves all 19 cases green,
            // because `recordInputApplication` is already idempotent on
            // `operationParcelId` ("a spray line is applied at most once")
            // with a `spray:<lineId>` dedup key behind it. Defence in depth,
            // and worth knowing which layer is load-bearing before someone
            // removes the wrong one.
            where: { taskId: { in: taskIds }, tenantId: ctx.tenantId, status: 'PENDING' },
            // `parcelId` so the per-parcel treated area can be matched to
            // the line it belongs to (#2072 part B).
            select: { id: true, taskId: true, version: true, parcelId: true },
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
            {
                recordedInDiary: true,
                occurredAt: day,
                // The period the farmer stated, captured on the line (#1775).
                // Before this it only reached `newProductRegistration`, so on
                // a product the farm already had it was silently dropped.
                quarantinePeriodDays: input.quarantinePeriodDays ?? null,
                // The growth stage the farmer observed, captured on the line
                // for the same reason (#2072): it is an observation made on a
                // day, and nothing can re-derive it later.
                phenophase: input.phenophase ?? null,
                // Per LINE and per PARCEL, so a treatment covering three
                // parcels can record a different area for each — which is the
                // whole point, since the register prints one row per parcel.
                // `undefined` (not null) when the caller gave none, so the
                // mark leaves the column alone rather than clearing it.
                treatedAreaHa: treatedByParcel.get(line.parcelId),
                // Denormalised onto each journal entry so the ДНЕВНИК list
                // folds the treatment's N entries into one row without
                // joining through OperationParcel -> Task (#1740).
                treatmentGroupId,
            },
        );
    }

    // Re-counted rather than summed from what THIS request created: a run
    // that finished a half-written treatment created fewer lines than the
    // treatment has, and the saved screen must show the treatment.
    const finalCount = await summariseTreatmentLines(ctx, taskIds);
    return { treatmentGroupId, parcelCount: finalCount.parcelCount, taskIds, replayed: false };
}

/**
 * Abandon a treatment that cannot be finished (#1777).
 *
 * ## The hole this closes
 *
 * A treatment write is resumable, not atomic: every block's lines are
 * created, then every line is marked DONE, and the MARK is what writes the
 * ДНЕВНИК entry. A failure during marking leaves a treatment partly
 * recorded, which `GET /journal/treatments/{handle}` reports as
 * `complete: false` and a re-send under the same handle finishes — that is
 * the designed contract, and agrent-ios preferred it to holding a
 * transaction open across N block creations and N marks.
 *
 * It has one dead end. If the cause REPEATS — a task moved to a terminal
 * status, a product soft-deleted between the create and the mark, a
 * persistent constraint failure — every retry fails identically and the
 * farmer is left with a treatment that will neither finish nor go away. The
 * one input-driven cause (a sample-archetype product) is already refused
 * before anything is written, so what remains is exactly the set a client
 * cannot fix by trying again.
 *
 * ## What "delete" means here, and who decided
 *
 * Owner ruling 2026-10-15: **soft-delete the whole treatment**, including the
 * register entries already written for the lines that DID complete.
 *
 * That is a real cost and it was put to the owner as one — a partial
 * treatment holds true ДНЕВНИК records of applications that really happened,
 * and this removes them. The alternatives offered were cancelling only the
 * unfinished remainder, and abandoning the remainder while keeping what was
 * recorded. The owner chose the whole treatment, so the protections are what
 * make it defensible rather than the scope:
 *
 *   • **ADMIN only** (`assertCanAdmin`), the same posture as the journal's
 *     own soft-delete / restore / purge, rather than the `canWrite` that
 *     records a treatment.
 *   • **SOFT**, so every row stays on disk with its audit history and a
 *     restore is a database operation away.
 *   • **Audited** as one event naming the handle and what it removed.
 *   • **INCOMPLETE ONLY.** A complete treatment is a finished compliance
 *     record and is refused here with a code pointing at the journal's own
 *     ADMIN flow. Letting both through one endpoint would make this a
 *     convenience route that drops БАБХ records, which is the thing the
 *     issue was written to prevent.
 *
 * ## SUPERSEDED in part, 2026-10-22 (#2175) — read this before the four above
 *
 * The owner reversed the last two of those protections. The original is kept
 * verbatim rather than rewritten, because its reasoning is still the best
 * account of what this costs, and a reader should see what was traded rather
 * than a tidy description of where we ended up.
 *
 *   • **INCOMPLETE ONLY is gone.** A complete treatment may now be removed
 *     through this endpoint — precisely the "convenience route that drops
 *     БАБХ records" the paragraph above exists to prevent, and it was put to
 *     the owner in those terms.
 *   • **ADMIN ONLY is widened** to the treatment's creator, via
 *     `assertCanDeleteTreatment`. A non-admin EDITOR can now withdraw a
 *     finished record they wrote.
 *
 * ## 2026-10-24: the protection that made it defensible is GONE
 *
 * The paragraph above said this was defensible because the delete was SOFT,
 * AUDITED and RESTORABLE from «Кошче». The owner has now removed «Кошче»
 * altogether — "what's deleted is deleted" — and chose, when asked what
 * 'deleted' should mean, "erased from the database: the rows are physically
 * deleted, with no trace beyond the audit log line", over the recommended
 * "gone for everyone, kept hidden for audit".
 *
 * So of those three only AUDITED survives, and the audit row is now the sole
 * record that a treatment ever existed. Both earlier rulings are kept above
 * rather than tidied away: this endpoint has been widened twice and then had
 * its safety net removed, and each step was taken knowing the last.
 *
 * The register no longer needs the `task.deletedAt` filter to honour a
 * withdrawal — the lines are gone, not hidden. `farm-record-diary.ts` keeps
 * the filter anyway, where it is now a no-op guarding against a soft-deleted
 * row that nothing produces.
 *
 * **`clientMutationId` is released for every treatment now.** It used to be
 * kept for a complete one so a restore could be exact; with no restore and no
 * surviving row to occupy `@@unique([tenantId, clientMutationId])`, both
 * halves of that rule are gone.
 *
 * ## Why the three mechanisms collapsed into one
 *
 * They used to differ: `Task` and `LogEntry` carry `deletedAt` and were
 * soft-deleted; `OperationParcel` has only a status, so its unfinished lines
 * moved to `SKIPPED`, the existing "deliberately not done" state that the
 * completion pass already refuses to touch.
 *
 * Now all three are simply deleted. The tasks go, `OperationParcel` cascades
 * with them, and the journal entries are deleted EXPLICITLY — which is the
 * one subtlety left in this function. `LogEntry.operationParcel` is an
 * optional relation declaring no `onDelete`, so Prisma defaults it to SET
 * NULL: cascading from the task alone would leave every entry alive with a
 * null `operationParcelId` and its `treatmentGroupId` intact, still listed
 * and still printed. The schema says this by saying nothing, which is the
 * hardest kind of thing to notice.
 *
 * The handle stops resolving because there is no row left to resolve.
 *
 * ## THE GENERIC TASK DELETE IS HARD TOO — the asymmetry is gone
 *
 * `deleteTask` in `usecases/task.ts` calls `db.task.delete`. Until
 * 2026-10-24 this route was the soft counterpart and that difference was the
 * subject of #2215; both are now physical, so the same `Task` row has one
 * fate whichever route reaches it.
 *
 * What still differs, and why `deleteTask` REFUSES a task carrying a
 * `treatmentGroupId` (#2220):
 *
 *   • this route takes the WHOLE group by its handle; the task route would
 *     take one block's share and leave a half-treatment;
 *   • this route writes one audit event naming the treatment and its counts,
 *     where the task route writes a generic `ENTITY_DELETED` — and with the
 *     rows gone, that event is the only surviving record.
 *
 * `tests/guards/task-delete-semantics-are-deliberate.test.ts` pins both ends
 * so neither docblock can quietly go stale.
 */
export async function deleteDiaryTreatment(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<{ treatmentGroupId: string; tasks: number; entries: number; lines: number }> {
    // `canWrite` first, narrowed by the creator check below once the rows say
    // who recorded it. No longer `assertCanAdmin` — see SUPERSEDED above.
    assertCanWrite(ctx);

    const tasks = await runInTenantContext(ctx, (db) =>
        db.task.findMany({
            where: { tenantId: ctx.tenantId, treatmentGroupId, deletedAt: null },
            select: { id: true, createdByUserId: true },
        }),
    );
    if (tasks.length === 0) {
        throw codedNotFound(
            'TREATMENT_NOT_FOUND',
            'No treatment was recorded under that handle.',
            { reference: 'treatmentGroupId' },
        );
    }

    const taskIds = tasks.map((t) => t.id);

    // Whoever recorded it, or an admin. Every task of one treatment is written
    // by one person in one request, so the first is the creator — but that is
    // ASSERTED rather than assumed: a mixed set would mean the handle had been
    // reused across people, and then "who may delete this" has no single
    // answer and the safe reply is to refuse rather than to pick one.
    const creators = new Set(tasks.map((t) => t.createdByUserId));
    if (creators.size !== 1) {
        throw codedConflict(
            'TREATMENT_MIXED_AUTHORSHIP',
            'This treatment has tasks recorded by more than one person, so it cannot be '
                + 'removed as a whole. Ask an administrator.',
            { reference: 'treatmentGroupId' },
        );
    }
    assertCanDeleteTreatment(ctx, { createdByUserId: tasks[0].createdByUserId });

    const summary = await summariseTreatmentLines(ctx, taskIds);
    // The completeness refusal is GONE (#2175). `summary` is still read because
    // the audit entry records what the deletion took with it, and because the
    // `clientMutationId` decision below turns on it.

    return runInTenantContext(ctx, async (db) => {
        // ── The register lines, deleted EXPLICITLY ──
        //
        // Not by cascade, and that is the crux of this function. `Task` is in
        // `SOFT_DELETE_MODELS`, so `withSoftDeleteExtension` rewrites
        // `db.task.delete`/`deleteMany` into an UPDATE setting `deletedAt`.
        // An update cascades nothing — so deleting the tasks leaves every
        // `OperationParcel` row exactly where it was, and the ДНЕВНИК would
        // keep printing the lines of a treatment the farmer had erased.
        //
        // Measured, because the source reads like a hard delete and is not:
        //     delete     -> SOFT (deletedAt=true)
        //     deleteMany -> SOFT (deletedAt=true)
        // through the real tenant client. See #2242 — a source-text guard
        // asserted the opposite and passed, because no scan of a call site can
        // see an extension rewriting the call.
        //
        // `OperationParcel` is NOT in the allowlist, so this one is real.
        const lines = await db.operationParcel.deleteMany({
            where: { tenantId: ctx.tenantId, taskId: { in: taskIds } },
        });
        const lineCount = lines.count;

        // ── PHYSICAL, owner ruling 2026-10-24: "what's deleted is deleted" ──
        //
        // The register entries go FIRST, and explicitly, because nothing else
        // reaches them. `LogEntry.operationParcel` is an OPTIONAL relation
        // with no `onDelete`, so Prisma's default for it is SET NULL: deleting
        // the tasks cascades the `OperationParcel` lines and would leave every
        // journal entry sitting there with a null `operationParcelId` and its
        // `treatmentGroupId` intact — still live, still listed, still printed.
        // That is the opposite of the ruling, and it is invisible unless you
        // read the schema for a relation that declares no action.
        //
        // No `deletedAt: null` filter: rows soft-deleted before this shipped
        // are taken too. There is no state left in which a withdrawn
        // treatment half-exists.
        const entries = await db.logEntry.deleteMany({
            where: { tenantId: ctx.tenantId, treatmentGroupId },
        });

        // `clientMutationId` is RELEASED along with the task, and that is not
        // tidiness — it is what makes the handle reusable.
        //
        // Each block's task is created with the derived key
        // `<handle>:<locationId>` under `@@unique([tenantId, clientMutationId])`.
        // A soft-deleted row still occupies that key, while the replay lookup
        // filters `deletedAt: null` and so does not find it — so re-sending
        // the abandoned handle skipped the replay, went to create, and died on
        // the unique constraint. A 500 where there used to be a resumable
        // treatment: strictly worse than the dead end this endpoint exists to
        // clear. Found by the DB-backed test, which is the only place it could
        // have been found.
        //
        // `treatmentGroupId` is deliberately KEPT, so the abandoned rows still
        // say which treatment they belonged to. Only the idempotency key goes,
        // and it is a key rather than a record of anything.
        // The tasks. This one goes through the extension and lands as a SOFT
        // delete — a flagged shell with no entries, no lines and no links that
        // any reader reaches, which `purgeSoftDeletedOlderThan` erases on its
        // schedule (it iterates `SOFT_DELETE_MODELS` with raw SQL that
        // deliberately bypasses the extension).
        //
        // Owner ruling 2026-10-24 asks for rows "physically deleted". Every
        // row a farmer or an inspector can see is, immediately: the journal
        // entries and the register lines above. The shell is a DELAY, not a
        // permanence, and making it immediate means taking `Task` out of
        // `SOFT_DELETE_MODELS` — which changes `DELETE /tasks/{id}` for every
        // task in the product and the retention sweep with it. That belongs in
        // its own change, not bundled into a treatment feature.
        //
        // `clientMutationId` is still released for an INCOMPLETE treatment and
        // kept for a complete one, unchanged: the soft row DOES still occupy
        // `@@unique([tenantId, clientMutationId])` while the replay lookup
        // filters `deletedAt: null`, which is the dead-end-handle problem the
        // long note above describes. That reasoning survives intact — it was
        // only ever about the soft row, and the row is still soft.
        const removed = await db.task.updateMany({
            where: { tenantId: ctx.tenantId, id: { in: taskIds }, deletedAt: null },
            data: {
                deletedAt: new Date(),
                deletedByUserId: ctx.userId ?? null,
                ...(summary.complete ? {} : { clientMutationId: null }),
            },
        });

        await logEvent(db, ctx, {
            action: 'ENTITY_DELETED',
            entityType: 'Task',
            entityId: treatmentGroupId,
            details: `Unfinished treatment ${treatmentGroupId} abandoned`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Treatment',
                // `deleted`, not `soft_deleted` (#2109). The canonical enum is
                // `created|updated|upserted|deleted|restored|purged`, and
                // `restored` is already in it — so the PAIR expresses the soft
                // lifecycle and a separate soft verb would be, in the enum's
                // own words about the batch verbs, "a second spelling of a fact
                // the row already states". The reversibility is recorded by the
                // existence of the restore, not by the delete's name.
                operation: 'deleted',
                summary:
                    `Abandoned an unfinished treatment: ${removed.count} task(s), ` +
                    `${entries.count} journal entr(ies) and ${lineCount} register line(s).`,
                before: {
                    parcelCount: summary.parcelCount,
                    completedCount: summary.completedCount,
                    complete: summary.complete,
                },
            },
        });

        return {
            treatmentGroupId,
            tasks: removed.count,
            entries: entries.count,
            lines: lineCount,
        };
    });
}


/**
 * The «Кошче» listing: treatments that were withdrawn and can be put back.
 *
 * Folded on `treatmentGroupId` rather than returned as tasks, because a
 * treatment over three blocks is three tasks and a trash view listing it three
 * times would invite three restores of one thing.
 *
 * Ordered by when it was withdrawn, newest first: the thing somebody wants back
 * is almost always the thing they just removed.
 */

// ─────────────────────────────────────────────────────────────────────
// The DEFINITION read — what a correction form prefills from (#2172)
// ─────────────────────────────────────────────────────────────────────

/**
 * One parcel line of a treatment, as the correction form needs it.
 *
 * `treatedAreaHa` stays NULLABLE and null keeps meaning THE WHOLE PARCEL — the
 * register prints `treatedAreaHa ?? parcel.areaHa`, so substituting the parcel
 * area here would turn an absence into a claim, and a correction that
 * round-tripped the prefill would then persist a number nobody typed.
 */
export interface TreatmentDefinitionLine {
    parcelId: string;
    parcelName: string;
    /** The block the parcel sits in — the treatment's fan-out key. */
    locationId: string | null;
    /** NULL means the whole parcel. See the interface note. */
    treatedAreaHa: number | null;
}

/**
 * A recorded treatment's COMPLETE definition, plus the version to send back.
 *
 * Field-for-field re-submittable as `RecordDiaryTreatmentInput`, which is the
 * requirement rather than a convenience: a correction replaces the definition,
 * so anything the prefill cannot express is a field a correction would silently
 * drop.
 */
export interface TreatmentDefinition {
    treatmentGroupId: string;
    /**
     * The group's version, to be returned as `If-Match` on the correction.
     *
     * From `TreatmentGroup` (#2172), not from the lines: `OperationParcel.version`
     * is per row and a correction may ADD or DROP a parcel, so there is no
     * stable set of row versions to compare against.
     *
     * `0` for a treatment recorded before the group row existed — the backfill
     * starts every row at 0 rather than claiming a version it never served.
     */
    version: number;
    kind: 'SPRAY' | 'FERTILIZE';
    /** `null` when no line has been completed yet, so there is no farm day to show. */
    occurredOn: string | null;
    title: string | null;
    applicationTechnique: string | null;
    targetNote: string | null;
    productItemId: string;
    productName: string;
    /** From the PRODUCT, not the line — it is a property of the registration. */
    pppRegistrationNo: string | null;
    doseValue: number;
    doseUnitId: string;
    waterRateValue: number | null;
    waterRateUnitId: string | null;
    /**
     * Point-in-time observations, carried through unchanged.
     *
     * Each has written no-backfill reasoning on its column: nothing records what
     * the quarantine period WAS when a line was completed, and a plausible
     * phenophase guess would make a regulated document authoritative about
     * something nobody observed. The prefill shows what was captured, including
     * nothing.
     */
    quarantinePeriodDays: number | null;
    phenophase: string | null;
    lines: TreatmentDefinitionLine[];
}

/**
 * The full definition of a recorded treatment, for a correction to prefill.
 *
 * ## Why not `getDiaryTreatment`
 *
 * That one is a SUMMARY for the detail view: it reads the lines with `take: 1`
 * and selects `completedAt` and `phenophase` only. It cannot prefill a
 * correction form — every parcel, its treated area, the product, the dose and
 * the units are all absent from it — and widening it would put the whole
 * definition on the payload of every journal detail read.
 *
 * ## The gate, in this order, and the order matters
 *
 *   1. `assertCanWrite` — the same floor the withdrawal uses. A prefill is only
 *      wanted by someone who intends to write, and the definition is the whole
 *      record, so it is not a read for every reader.
 *   2. SINGLE AUTHORSHIP, refused with `TREATMENT_MIXED_AUTHORSHIP` — the same
 *      409 the withdrawal raises, and for the same reason: a handle reused
 *      across people has no single creator for the permission rule to admit,
 *      and that binds admins too.
 *   3. `assertCanEditTreatment` on that single creator.
 *
 * Establishing authorship BEFORE the permission check is what makes step 3
 * meaningful; doing it after would let an admin read a definition the
 * correction route would then refuse to write.
 */
export async function getDiaryTreatmentDefinition(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<TreatmentDefinition> {
    assertCanWrite(ctx);

    const handle = treatmentGroupId.trim();
    if (!handle) {
        throw codedNotFound(
            'TREATMENT_NOT_FOUND',
            'No treatment was recorded under that handle.',
            { reference: 'treatmentGroupId' },
        );
    }

    return runInTenantContext(ctx, async (db) => {
        const tasks = await db.task.findMany({
            where: { tenantId: ctx.tenantId, treatmentGroupId: handle, deletedAt: null },
            select: {
                id: true,
                createdByUserId: true,
                operationType: true,
                title: true,
                applicationTechnique: true,
            },
            orderBy: { createdAt: 'asc' },
        });
        if (tasks.length === 0) {
            throw codedNotFound(
                'TREATMENT_NOT_FOUND',
                'No treatment was recorded under that handle.',
                { reference: 'treatmentGroupId' },
            );
        }

        const creators = new Set(tasks.map((t) => t.createdByUserId));
        if (creators.size !== 1) {
            throw codedConflict(
                'TREATMENT_MIXED_AUTHORSHIP',
                'This treatment has tasks recorded by more than one person, so it cannot be '
                    + 'corrected as a whole. Ask an administrator.',
                { reference: 'treatmentGroupId' },
            );
        }
        assertCanEditTreatment(ctx, { createdByUserId: tasks[0].createdByUserId });

        const lines = await db.operationParcel.findMany({
            where: { tenantId: ctx.tenantId, taskId: { in: tasks.map((t) => t.id) } },
            select: {
                parcelId: true,
                productItemId: true,
                doseValue: true,
                doseUnitId: true,
                waterRateValue: true,
                waterRateUnitId: true,
                targetNote: true,
                quarantinePeriodDays: true,
                phenophase: true,
                treatedAreaHa: true,
                completedAt: true,
                parcel: { select: { name: true, locationId: true } },
                product: { select: { name: true, pppRegistrationNo: true } },
            },
            orderBy: [{ parcelId: 'asc' }],
        });
        if (lines.length === 0) {
            // A treatment with tasks and no lines is the stranded shape
            // `recordDiaryTreatment` documents: a partial write that failed
            // before any line landed. There is no definition to correct, and
            // saying so is better than returning a shell the form would fill
            // with defaults and then save as if it were the record.
            throw codedNotFound(
                'TREATMENT_NOT_FOUND',
                'That treatment has no recorded parcel lines, so there is nothing to correct.',
                { reference: 'treatmentGroupId' },
            );
        }

        // The group row, for the version a correction sends back. `findUnique`
        // on the composite key — the handle is unique PER TENANT, not globally.
        const group = await db.treatmentGroup.findUnique({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: handle } },
            select: { version: true },
        });

        // One treatment is one product at one dose across its blocks — that is
        // what `recordDiaryTreatment` writes from a single input. Read from the
        // first line rather than asserted uniform: a mixed set would mean the
        // lines had been edited individually through the parcel-mark path, and
        // #2172's correction route is the thing that will settle what that
        // means. Until then the prefill shows the treatment as it was RECORDED.
        const first = lines[0];
        const stamped = lines.find((l) => l.completedAt != null);

        return {
            treatmentGroupId: handle,
            version: group?.version ?? 0,
            kind: tasks[0].operationType === 'FERTILIZE' ? 'FERTILIZE' : 'SPRAY',
            occurredOn: stamped?.completedAt
                ? stamped.completedAt.toISOString().slice(0, 10)
                : null,
            title: tasks[0].title ?? null,
            applicationTechnique: tasks[0].applicationTechnique ?? null,
            targetNote: first.targetNote ?? null,
            productItemId: first.productItemId,
            productName: first.product.name,
            pppRegistrationNo: first.product.pppRegistrationNo ?? null,
            doseValue: Number(first.doseValue),
            doseUnitId: first.doseUnitId,
            waterRateValue: first.waterRateValue == null ? null : Number(first.waterRateValue),
            waterRateUnitId: first.waterRateUnitId ?? null,
            quarantinePeriodDays: first.quarantinePeriodDays ?? null,
            phenophase: first.phenophase ?? null,
            lines: lines.map((l) => ({
                parcelId: l.parcelId,
                parcelName: l.parcel.name,
                locationId: l.parcel.locationId ?? null,
                // NULL stays NULL — see `TreatmentDefinitionLine`.
                treatedAreaHa: l.treatedAreaHa == null ? null : Number(l.treatedAreaHa),
            })),
        };
    });
}
