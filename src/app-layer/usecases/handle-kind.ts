/**
 * What kind of record a journal handle names — a TREATMENT or a bare ACTIVITY.
 *
 * One question asked in four places as of #2373: the activity definition read,
 * the correction write, and now BOTH trail reads. It was written inline once and
 * that was already one time too many — the refusals on either side of it
 * (`NOT_A_TREATMENT` / `NOT_AN_ACTIVITY`) have to be exact complements, and two
 * copies of a discriminator are two things that can come to disagree about the
 * same row.
 *
 * ## Why the trail reads need it at all
 *
 * `TreatmentCorrection` is keyed on `(tenantId, groupId)` and a bare activity's
 * handle already upserts a `TreatmentGroup`, so the table is shared and needed no
 * change for #2373. The READ is a different matter: `previous` holds the whole
 * definition of whatever was corrected, so one endpoint serving both would return
 * a `TreatmentDefinition` or a `FarmActivityDefinition` with nothing to
 * discriminate on — under a path that names only one of them.
 *
 * Found by the agrent-ios session reading the branch before building against it,
 * which is the only reason it did not ship: the PR's own claim that the trail
 * "needed no change" was true of the table and silently false of the route.
 *
 * ## The LINE decides, and the task type is the fallback
 *
 * A line that applies a product is a treatment, whatever its task's
 * `operationType` says — legacy rows have none, and the line holds the truth.
 * With NO lines there is nothing to read (a partially-written record), and then
 * the declared type decides. Without that fallback a treatment whose lines were
 * never marked would classify as an activity.
 */

import type { PrismaTx } from '@/lib/db-context';
import { appliesAProduct, type OperationLineDoseFields } from '@/lib/operations/line-kind';
import { isBareActivityKind } from '@/lib/operations/activity-labels';
import { RequestContext } from '../types';

export type HandleKind = 'TREATMENT' | 'ACTIVITY';

/**
 * `null` means NOTHING exists under the handle.
 *
 * Deliberately not a throw: each caller raises its own 404 with its own code and
 * its own wording, and an existence-hiding 404 has to stay contentless. A shared
 * refusal here would make every route answer in the treatments' vocabulary.
 */
export async function classifyHandle(
    db: PrismaTx,
    ctx: RequestContext,
    handle: string,
): Promise<HandleKind | null> {
    const task = await db.task.findFirst({
        where: { tenantId: ctx.tenantId, treatmentGroupId: handle, deletedAt: null },
        select: { id: true, operationType: true },
        orderBy: { createdAt: 'asc' },
    });
    if (!task) return null;

    const line = await db.operationParcel.findFirst({
        // `deletedAt: null` on the TASK, not just on the handle. `Task` deletes
        // are SOFT (middleware), and a withdrawal soft-deletes the tasks while
        // leaving their lines — `OperationParcel` has no `deletedAt` column at
        // all. Without this a withdrawn treatment's line could classify a handle
        // as TREATMENT when the live record under it is an activity, and this is
        // now the ONE discriminator four call sites trust.
        //
        // The treatments path gets this for free because it derives its taskIds
        // from a `deletedAt: null` query first; stating it here is what keeps the
        // two from disagreeing.
        where: {
            tenantId: ctx.tenantId,
            task: { treatmentGroupId: handle, deletedAt: null },
        },
        // Exactly the three fields `appliesAProduct` tests. The CHECK keeps them
        // all-or-nothing; a fourth field selected here is how a select drifts
        // from the predicate it feeds.
        select: { productItemId: true, doseValue: true, doseUnitId: true },
        orderBy: { id: 'asc' },
    });

    return classifyFromRows(task, line);
}

/**
 * The rule itself, over rows a caller ALREADY has.
 *
 * `loadActivityForEdit` reads the tasks and the lines anyway, and making it call
 * `classifyHandle` would re-query both to answer a question it can already
 * answer. So the rule lives here once and the fetching wrapper above is the
 * convenience, not the authority — otherwise the caller with the data in hand
 * is the one tempted to write its own copy.
 */
export function classifyFromRows(
    task: { operationType: string | null },
    line: OperationLineDoseFields | null,
): HandleKind {
    if (line) return appliesAProduct(line) ? 'TREATMENT' : 'ACTIVITY';
    return isBareActivityKind(task.operationType ?? '') ? 'ACTIVITY' : 'TREATMENT';
}
