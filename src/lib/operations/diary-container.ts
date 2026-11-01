/**
 * A diary record's bookkeeping tasks are not the farm's work list.
 *
 * Owner, 2026-11-01 (#2696), opening Дневник → «Обработка на почвата — 20688.13» (an
 * activity recorded through «Нов запис» on 26 Oct): *"This can not be printed
 * and also is in tasks and in journal as well — does the journal page only
 * contain journals or not?"*
 *
 * It appeared in both because it IS in both. `recordFarmActivity` and
 * `recordDiaryTreatment` each create one `FIELD_OPERATION` task per block as
 * the CONTAINER the register's lines hang off — `createFieldOperation` is what
 * writes `OperationParcel` rows, and a line needs a task to belong to. So one
 * diary entry across three blocks is three rows in Задачи, every one of them
 * «Очаква преглед», for work the farmer has already done and is only
 * recording.
 *
 * ## The marker is `treatmentGroupId`, and it was already load-bearing
 *
 * Not `type`, and not a new column. `createFieldOperation` has exactly three
 * callers and only two of them pass a group: `POST /locations/{id}/operations`
 * PLANS an operation and leaves it NULL, while `recordFarmActivity` and
 * `recordDiaryTreatment` both pass the handle. So the column already separates
 * "work somebody intends to do" from "bookkeeping behind a record", and
 * `assertTaskIsNotTreatmentShare` (#2220) already refuses to delete a task on
 * exactly this test — `mayDelete` is `treatmentGroupId === null` today. This
 * rule is the same line drawn on the same column, applied to visibility
 * instead of deletion.
 *
 * `journal.prisma`'s own note on `TreatmentGroup` calls it "the discriminator
 * for a real treatment", so nothing here is new policy — it is the existing
 * discriminator reaching the one surface that had not asked it.
 *
 * ## It cannot hide a mechanisator's work, and that is checkable
 *
 * The worry with hiding anything from `GET /farm-tasks` is that it is a
 * sprayer's queue. It cannot cost one a job here, because neither writer ever
 * assigns a container to anybody else: both pass `assigneeUserId: ctx.userId`
 * under the comment *"the only honest assignee for work already done is
 * whoever recorded it"*, and both pass `suppressAssignmentNotification` so the
 * recorder is not belled about work they just finished typing. A container is
 * therefore always assigned to the person who recorded it, retrospectively,
 * and is never anybody's outstanding job.
 *
 * ## LISTS filter; a lookup BY ID does not
 *
 * The line is between a surface that ENUMERATES tasks for a person and one
 * that resolves a task somebody already has the id of. A notification, a
 * deep link or a saved URL must still open — and when it does, #2220's 409
 * explains that the row belongs to a recorded treatment and points at
 * `treatmentGroupId`. Hiding it from the list while refusing to resolve it
 * would turn a coherent "this is part of a record" into a dead link.
 *
 * A NAME is not the test, though, and this one nearly fooled me:
 * `listRowsByIds` sounds like a by-id resolution and is not — its one caller
 * is `listTasksForParcel`, so it is a parcel's task LIST reached through an id
 * set, and it filters. Its neighbours over the SAME ids do not:
 * `listResolutionsByIds` builds the parcel's comment and closing-note history,
 * and `listByIds` is a write path's existence check. Classify by what the read
 * is FOR, not by its signature.
 *
 * Single-row reads stay unfiltered, and the diary machinery that reads
 * containers ON PURPOSE — the correction trail, the withdrawal path, the
 * register gatherers — is not merely unfiltered but must never be filtered.
 * `tests/guards/diary-container-visibility.test.ts` holds both populations
 * from the filesystem, so a sixth list surface has to decide rather than
 * inherit.
 *
 * ## What this does NOT change
 *
 * The record itself, which lives in Дневник and is the farmer's compliance
 * artefact. The БАБХ register, which gathers lines through the containers and
 * would be empty without them. A parcel's comment history, which is notes
 * people wrote rather than a task list — `listParcelComments` shares
 * `parcelTaskIds` with the task list and is deliberately NOT filtered here,
 * because a closing note somebody typed is information and its container
 * being bookkeeping does not make the note bookkeeping.
 */
import type { Prisma } from '@prisma/client';

/**
 * The where-fragment every person-facing task LIST spreads.
 *
 * `treatmentGroupId: null` rather than `{ not: { not: null } }` or an `isSet`
 * test: the column is a nullable `String?` and Prisma's null means IS NULL,
 * which is the whole of the rule.
 */
export const EXCLUDE_DIARY_CONTAINERS = {
    treatmentGroupId: null,
} as const satisfies Prisma.TaskWhereInput;

/**
 * True when this task is one block's share of a diary record.
 *
 * For a row already in hand — the in-memory half of the same rule, so a
 * caller that has rows does not re-query to ask. Returns false for
 * `undefined`, because a projection that did not SELECT the column cannot
 * answer the question and must not be read as answering "no": the two are
 * told apart here rather than at each call site.
 */
export function isDiaryContainerTask(task: { treatmentGroupId?: string | null }): boolean {
    return typeof task.treatmentGroupId === 'string';
}
