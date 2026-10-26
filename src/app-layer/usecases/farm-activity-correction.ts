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

import type { FieldOperationType, Prisma } from '@prisma/client';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import {
    codedBadRequest,
    codedConflict,
    codedNotFound,
    configurationError,
    staleData,
} from '@/lib/errors/types';
import { parseRecordedDay } from '@/lib/operations/recorded-day';
import { classifyFromRows, classifyHandle } from './handle-kind';
import { readCorrectionTrail, type CorrectionTrail } from './correction-trail';
import { dayKeyInTz, FARM_TIME_ZONE } from '@/lib/calendar-day-key';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { assertCanEditTreatment } from '../policies/task.policies';
import { logEvent } from '../events/audit';
import { resolveHarvestTarget } from './farm-activity';
import { createFieldOperation, markOperationParcel } from './field-operation';
import { ACTIVITY_LABELS_BG } from '@/lib/operations/activity-labels';

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
    /** The WHOLE corrected set, not a delta. Absent means unchanged. */
    parcelIds?: string[];
    /** Worked areas, refining `parcelIds`. Applies to retained parcels too. */
    parcels?: { parcelId: string; treatedAreaHa: number }[];
}

/** The SCALAR fields a correction may name, in the order the trail lists them. */
const CORRECTABLE_FIELDS = ['occurredOn', 'harvestKg'] as const;

interface ParcelSetChange {
    added: string[];
    dropped: string[];
}

/**
 * The parcel set as a DELTA against what is recorded, or null when unchanged.
 *
 * The request carries the whole set so an editor can submit the form back
 * unchanged — which must be a no-op, not a drop-and-re-add of every line. So the
 * delta is computed here rather than asked for.
 */
function parcelSetChange(
    previous: FarmActivityDefinition,
    input: CorrectFarmActivityInput,
): ParcelSetChange | null {
    if (!input.parcelIds) return null;
    const now = new Set(input.parcelIds);
    const before = new Set(previous.lines.map((l) => l.parcelId));
    const added = [...now].filter((id) => !before.has(id));
    const dropped = [...before].filter((id) => !now.has(id));
    return added.length === 0 && dropped.length === 0 ? null : { added, dropped };
}

/**
 * Which retained parcels get a DIFFERENT area, or null when none do.
 *
 * Separate from the set change because a correction may move an area without
 * touching the membership — a mistyped hectare figure on a parcel that was
 * always in the set. `null` and a number are different values here: a stored
 * NULL means "the whole parcel" and the diary prints `treatedAreaHa ??
 * parcel.areaHa`, so clearing an area is a real change rather than an absence.
 */
function changedAreas(
    previous: FarmActivityDefinition,
    input: CorrectFarmActivityInput,
): Map<string, number | null> | null {
    if (!input.parcelIds) return null;
    const sent = new Map(input.parcels?.map((p) => [p.parcelId, p.treatedAreaHa]) ?? []);
    const out = new Map<string, number | null>();
    for (const id of input.parcelIds) {
        const next = sent.get(id) ?? null;
        const line = previous.lines.find((l) => l.parcelId === id);
        // An ADDED parcel is not an area change — it arrives with its area.
        if (!line) continue;
        if (line.treatedAreaHa !== next) out.set(id, next);
    }
    return out.size === 0 ? null : out;
}

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

/**
 * Validate a corrected parcel set and prepare any BLOCK the activity does not
 * yet cover — before the write transaction opens.
 *
 * ## Why the minting cannot be inside that transaction
 *
 * A block's task is created through `createFieldOperation`, which has no `tx`
 * option and commits in TWO transactions of its own: `createTask` opens one so
 * `clientMutationId` is durable before the links and lines are written. So it
 * cannot join the correction's interactive transaction, and re-implementing task
 * creation here would be a second copy of the audit event, the notification
 * suppression and the key handling — the kind of duplicate that drifts.
 *
 * ## Why the cost is bounded
 *
 * A task minted here and then abandoned — because the correction failed its
 * `If-Match` a moment later — is not an orphan to clean up. The key is
 * `<handle>:<locationId>` under `@@unique([tenantId, clientMutationId])`, so the
 * NEXT attempt resolves the same key and ADOPTS it rather than minting a second.
 * An empty `FIELD_OPERATION` task carries no lines, so it prints nothing and the
 * journal row's counts are unchanged. That is exactly how `recordFarmActivity`
 * already behaves for a half-written activity, and its docblock makes the same
 * argument: a partially-written record keeps a handle a replay can address.
 *
 * The `If-Match` is checked here too, against the version this read sees — not
 * as the precondition (the transaction re-checks it, which is what makes it
 * one), but so an obviously stale editor is refused BEFORE anything is minted.
 */
async function planParcelChange(
    ctx: RequestContext,
    handle: string,
    input: CorrectFarmActivityInput,
    expectedVersion: number | undefined,
): Promise<{
    /**
     * The delta as it stood BEFORE anything was minted.
     *
     * Carried out of here rather than re-derived inside the transaction, and
     * that is not a shortcut — it is a correctness requirement. Minting a block
     * goes through `createFieldOperation`, which writes that block's LINES as
     * well as its task. So by the time the transaction loads the record, the
     * "added" parcel is already present, `parcelSetChange` sees no change at
     * all, and the correction takes its no-op path — leaving a PENDING line
     * with no journal entry, invisible in «Дневник». That is the defect #2354
     * was, reintroduced from a new direction, and a test caught it.
     */
    delta: ParcelSetChange | null;
    areas: Map<string, number | null> | null;
    blockOfAdded: Map<string, string>;
    mintedTaskOfBlock: Map<string, string>;
}> {
    const { definition: previous } = await runInTenantContext(ctx, (db) =>
        loadActivityForEdit(db, ctx, handle),
    );

    if (expectedVersion !== undefined && expectedVersion !== previous.version) {
        throw staleData(
            'This activity was corrected by someone else while you were editing it. '
                + 'Reopen it to see the current values.',
            { reference: 'treatmentGroupId' },
        );
    }

    const setChange = parcelSetChange(previous, input);
    const areas = changedAreas(previous, input);
    const blockOfAdded = new Map<string, string>();
    const mintedTaskOfBlock = new Map<string, string>();
    if (!setChange) return { delta: null, areas, blockOfAdded, mintedTaskOfBlock };

    // Dropping EVERY parcel is a withdrawal wearing a correction's clothes. The
    // withdrawal has its own route, its own permission and its own audit event,
    // and it RELEASES the idempotency key so the handle stays resumable — none
    // of which a correction does. An activity with zero lines would also put a
    // row in «ДНЕВНИК НА СТОПАНСТВОТО» summing nothing.
    if (setChange.dropped.length >= previous.lines.length && setChange.added.length === 0) {
        throw codedBadRequest(
            'ACTIVITY_CORRECTION_WOULD_EMPTY',
            'A correction cannot remove every parcel. Withdraw the activity instead.',
            { reference: 'parcels' },
        );
    }

    if (setChange.added.length === 0) {
        return { delta: setChange, areas, blockOfAdded, mintedTaskOfBlock };
    }

    const addedParcels = await runInTenantContext(ctx, (db) =>
        db.parcel.findMany({
            where: { id: { in: setChange.added }, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, locationId: true },
        }),
    );
    // A parcel of another farm: 400 and NO echo of the id, the same choice the
    // record path makes, so a refusal does not confirm the row exists in someone
    // else's tenant.
    if (addedParcels.length !== setChange.added.length) {
        throw codedBadRequest('REFERENCE_NOT_IN_TENANT', 'One of those parcels is not in this farm.', {
            reference: 'parcels',
        });
    }

    const covered = new Set(previous.lines.map((l) => l.locationId).filter((v): v is string => !!v));
    for (const pa of addedParcels) {
        if (pa.locationId == null) {
            // A parcel with no block cannot be placed: the activity's tasks are
            // per block, and the diary resolves a row's block through the task's
            // location link. Refused rather than filed against an arbitrary one.
            throw codedBadRequest(
                'REFERENCE_NOT_IN_TENANT',
                'One of those parcels is not in a block.',
                { reference: 'parcels' },
            );
        }
        blockOfAdded.set(pa.id, pa.locationId);
    }

    // The NEW blocks. Owner decision 2026-10-26: allowed, unlike the treatment
    // correction, whose refusal rests on the БАБХ register printing one table
    // per block. Activities are not in that register, and the whole-farm diary
    // prints ONE row per activity summing its parcels' areas — so a new block
    // changes nothing about the document's shape.
    const newBlocks = [...new Set([...blockOfAdded.values()].filter((b) => !covered.has(b)))];
    for (const locationId of newBlocks) {
        const parcelIds = [...blockOfAdded.entries()]
            .filter(([, b]) => b === locationId)
            .map(([p]) => p);
        // `createFieldOperation` requires an assignee, and the only honest one
        // for work already done is whoever is recording it. `assertCanWrite`
        // has already established a user session, so a null here would be a
        // programming error rather than a request a farmer can make — stated
        // instead of coerced, because `?? undefined` would have failed inside
        // the create with a message about a different field.
        if (!ctx.userId) {
            throw configurationError(
                'A correction that mints a block needs an acting user, and this context has none.',
            );
        }
        const created = await createFieldOperation(
            ctx,
            locationId,
            {
                title: ACTIVITY_LABELS_BG[previous.kind as FieldOperationType],
                operationType: previous.kind as FieldOperationType,
                assigneeUserId: ctx.userId,
                parcelIds,
            },
            // The SAME derived key the record path uses, which is what makes an
            // abandoned task adoptable rather than duplicated.
            `${handle}:${locationId}`,
            { suppressAssignmentNotification: true, treatmentGroupId: handle },
        );
        mintedTaskOfBlock.set(locationId, created.taskId);
    }

    return { delta: setChange, areas, blockOfAdded, mintedTaskOfBlock };
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

    // Validated, and any NEW block's task minted, BEFORE the write transaction —
    // see `planParcelChange` for why it cannot be inside it and why an
    // abandoned task is adopted rather than orphaned.
    const plan = input.parcelIds
        ? await planParcelChange(ctx, handle, input, expectedVersion)
        : {
              delta: null,
              areas: null,
              blockOfAdded: new Map<string, string>(),
              mintedTaskOfBlock: new Map<string, string>(),
          };

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

        const changedScalars = CORRECTABLE_FIELDS.filter((f) => {
            if (input[f] === undefined) return false;
            if (f === 'occurredOn') return input.occurredOn !== previous.occurredOn;
            return (input.harvestKg ?? null) !== previous.harvestKg;
        });
        // From the PLAN, which measured the delta before it minted anything —
        // see `planParcelChange`'s `delta` for why re-deriving here is wrong
        // rather than merely redundant. The VERSION is still re-checked against
        // this transaction's own read below; it is only the membership delta
        // that has to predate the minting.
        const setChange = plan.delta;
        const areas = plan.areas;
        const changed: string[] = [
            ...changedScalars,
            ...(setChange ? ['parcels'] : []),
            ...(areas ? ['treatedAreaHa'] : []),
        ];

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

        // ── Dropped parcels ──
        if (setChange && setChange.dropped.length > 0) {
            const droppedLines = await db.operationParcel.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    taskId: { in: taskIds },
                    parcelId: { in: setChange.dropped },
                },
                select: { id: true },
            });
            const ids = droppedLines.map((l) => l.id);
            if (ids.length > 0) {
                // The journal ENTRIES go first and explicitly, because nothing
                // else reaches them: `LogEntry.operationParcel` is an optional
                // relation with no `onDelete`, so Prisma's default is SET NULL —
                // deleting the line would leave its entry live, listed and
                // printed, with a null link and its `treatmentGroupId` intact.
                // The treatment withdrawal documents the same trap.
                await db.logEntry.deleteMany({
                    where: { tenantId: ctx.tenantId, operationParcelId: { in: ids } },
                });
                // PHYSICAL: `OperationParcel` has no `deletedAt` column at all,
                // so there is no soft-delete to prefer here.
                await db.operationParcel.deleteMany({
                    where: { tenantId: ctx.tenantId, id: { in: ids } },
                });
            }
        }

        // ── Added parcels ──
        if (setChange && setChange.added.length > 0) {
            // Which task covers which block. ONE read for every line, not one
            // per line: `previous.lines` knows a parcel's block and this knows
            // its task, so the join is done in memory. A `findFirst` per line
            // here was an N+1 that `query-shape-guardrails` caught — correctly;
            // the query count must not grow with the number of parcels.
            const rows = await db.operationParcel.findMany({
                where: { tenantId: ctx.tenantId, taskId: { in: taskIds } },
                select: { parcelId: true, taskId: true },
            });
            const taskOfParcel = new Map(rows.map((r) => [r.parcelId, r.taskId]));
            const taskOfBlock = new Map<string, string>();
            for (const l of previous.lines) {
                if (l.locationId == null) continue;
                const taskId = taskOfParcel.get(l.parcelId);
                if (taskId) taskOfBlock.set(l.locationId, taskId);
            }

            // The farm day the added line is stamped with: the corrected one when
            // the day moved, otherwise the day the activity already carries.
            // Parsed rather than re-derived from an instant — reading a calendar
            // day back out of a UTC instant is the mistake `parseRecordedDay`
            // exists to prevent.
            const effOccurredAt =
                day?.day ?? (previous.occurredOn ? parseRecordedDay(previous.occurredOn).day : undefined);
            const sentAreas = new Map(input.parcels?.map((p) => [p.parcelId, p.treatedAreaHa]) ?? []);

            // Lines that ALREADY exist for the added parcels — one read for the
            // whole set. These arise two ways: a minted block whose task
            // `createFieldOperation` populated, and a re-sent correction. The
            // task set includes the minted ones, which is why it is rebuilt here
            // rather than reusing `taskIds`.
            const allTaskIds = [...new Set([...taskIds, ...plan.mintedTaskOfBlock.values()])];
            const existingAdded = await db.operationParcel.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    taskId: { in: allTaskIds },
                    parcelId: { in: setChange.added },
                },
                select: { id: true, version: true, status: true, parcelId: true },
            });
            const existingOfAdded = new Map(existingAdded.map((l) => [l.parcelId, l]));

            for (const parcelId of setChange.added) {
                const block = plan.blockOfAdded.get(parcelId);
                const taskId = block
                    ? (taskOfBlock.get(block) ?? plan.mintedTaskOfBlock.get(block))
                    : undefined;
                // Unreachable: `planParcelChange` either found the block covered
                // or minted its task. Asserted rather than assumed, because
                // silently skipping a parcel would answer 200 to a correction
                // that did not happen.
                if (!taskId) {
                    throw codedBadRequest(
                        'ACTIVITY_CORRECTION_BLOCK_UNRESOLVED',
                        'That parcel could not be placed in a block of this activity.',
                        { reference: 'parcels' },
                    );
                }

                // A minted block's task already carries ITS parcels as lines —
                // `createFieldOperation` wrote them — so creating another here
                // would double them. Only a parcel joining an EXISTING block
                // needs its line written. Looked up from the single read above
                // rather than per parcel.
                const existing = existingOfAdded.get(parcelId);
                const lineId = existing
                    ? existing.id
                    : (
                          await db.operationParcel.create({
                              data: { tenantId: ctx.tenantId, taskId, parcelId },
                              select: { id: true },
                          })
                      ).id;

                // MARKED rather than written whole: `markOperationParcel` is what
                // gives a line its journal entry and its audit event, so an added
                // parcel that skipped it would exist in the register with no
                // entry — invisible in «Дневник», which is the defect #2354 was.
                // It joins THIS transaction via `tx`; a nested `$transaction`
                // would deadlock on the rows this one holds.
                if (!existing || existing.status !== 'DONE') {
                    await markOperationParcel(ctx, taskId, lineId, 'DONE', null, existing?.version ?? 0, {
                        tx: db,
                        recordedInDiary: true,
                        treatmentGroupId: handle,
                        ...(effOccurredAt ? { occurredAt: effOccurredAt } : {}),
                        treatedAreaHa: sentAreas.get(parcelId) ?? null,
                    });
                }
            }
        }

        // ── Areas on parcels that were already there ──
        if (areas) {
            for (const [parcelId, treatedAreaHa] of areas) {
                await db.operationParcel.updateMany({
                    where: { tenantId: ctx.tenantId, taskId: { in: taskIds }, parcelId },
                    data: { treatedAreaHa },
                });
            }
        }

        // ── The harvest total, re-anchored ──
        //
        // Re-done whenever the total CHANGED **or the parcel set did**, and the
        // second half is the one that matters.
        //
        // The total lives on ONE journal entry — whichever `resolveHarvestTarget`
        // picks, ordered by `operationParcelId asc`. Dropping a parcel deletes
        // its entry (it must: see above), and `LogQuantity.logEntry` is
        // `onDelete: Cascade`. So dropping the lowest-id parcel of a harvest
        // would have taken the recorded yield with it — silently, through two
        // relations neither of which is visible at this call site. Adding a
        // parcel can move the anchor the other way and leave a SECOND row.
        //
        // So the total is consolidated rather than patched: every WEIGHT row
        // under the handle is removed and exactly one is written on the current
        // canonical entry. Idempotent, and it cannot leave two.
        let harvestKg = previous.harvestKg;
        const totalMayHaveMoved = changed.includes('harvestKg') || setChange !== null;
        if (previous.kind === 'HARVEST' && totalMayHaveMoved) {
            const next = changed.includes('harvestKg') ? (input.harvestKg ?? null) : previous.harvestKg;

            await db.logQuantity.deleteMany({
                where: {
                    tenantId: ctx.tenantId,
                    measure: 'WEIGHT',
                    logEntry: { treatmentGroupId: handle },
                },
            });

            if (next !== null) {
                // `taskIds` is sufficient, and this is worth stating because it
                // is not obvious. A minted block's task does NOT need a second
                // read: `loadActivityForEdit` runs inside this transaction,
                // which is AFTER `planParcelChange` has minted, so `taskIds`
                // already contains it.
                //
                // An earlier version re-read the task set here and claimed the
                // opposite in a comment. A mutation swapping the re-read for
                // `taskIds` SURVIVED — including on a test written specifically
                // to catch it, where a harvest's only parcel moves to a new
                // block — which is what showed the query was redundant and the
                // comment wrong. Removed rather than kept as insurance: a line
                // defended by a false reason is worse than no line.
                const { entryId, kgUnitId } = await resolveHarvestTarget(db, ctx, taskIds);
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

        // A changed parcel SET is RE-READ rather than patched.
        //
        // Every scalar is assembled from what was written, which is cheap and
        // exact. The line LIST is not a scalar — rows were created and
        // destroyed, and each added one carries values `markOperationParcel`
        // derived rather than values this function chose. Reconstructing that
        // here would be a second implementation of the assembly, and the first
        // thing it would get wrong is what an editor shows back to the farmer.
        //
        // The re-read also picks up the version the compare-and-swap just set,
        // so it is not re-derived either.
        if (setChange || areas) {
            const after = await loadActivityForEdit(db, ctx, handle);
            return after.definition;
        }

        return {
            ...previous,
            version: previous.version + 1,
            ...(day ? { occurredOn: input.occurredOn ?? previous.occurredOn } : {}),
            harvestKg,
        };
    });
}
