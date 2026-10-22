/**
 * Which write a swipe on a journal row performs, if any (#2175).
 *
 * Extracted from `JournalClient` so it can be EXECUTED by a test. The decision
 * is the security-relevant half of the gesture — it decides whether a
 * destructive control is offered at all — and reaching it through a mount of
 * the journal page would mean standing up SWR, the filter provider, the
 * offline sync bar and the cursor accumulator to assert a boolean.
 *
 * ## Two writes, because a journal row is two different things
 *
 * A folded row with `parcelCount > 0` stands for a TREATMENT: N tasks and N
 * register lines across its blocks. A row without one is a single entry.
 *
 * The distinction is not cosmetic. `renderFarmRecordDiary` builds its
 * treatment rows from `operationParcel` and never reads `LogEntry` for them,
 * so deleting the ENTRY under a treatment row would leave every printed line
 * in the ДНЕВНИК. Only the withdrawal reaches them. Sending both through one
 * route would make the gesture a no-op on exactly the rows a farmer most wants
 * gone.
 */

export type JournalSwipeKind = 'treatment' | 'entry';

export interface SwipeEligibilityRow {
    id: string;
    treatment?: {
        parcelCount: number;
        /** Server-computed; see `JournalRow`. */
        mayDelete?: boolean;
    } | null;
}

/**
 * `null` means the row does not swipe — no gesture, and no hidden button for a
 * keyboard to reach either.
 *
 * Three refusals, each for its own reason:
 *
 *   - an OPTIMISTIC row has no server record yet, so there is nothing to
 *     withdraw and the id would 404;
 *   - a treatment whose `mayDelete` is explicitly `false` would answer 403
 *     (not the creator) or 409 (recorded by more than one person, which
 *     refuses admins too) — offering a control that refuses is worse than an
 *     absent one;
 *   - an entry on a page whose caller cannot write.
 *
 * **`mayDelete === false`, never `!mayDelete`.** An ABSENT flag is a row
 * cached before the field existed, and this list reads through the persistent
 * SWR cache. Treating absence as denial would hide the control from the person
 * who recorded the treatment; the server re-checks either way, so a stale
 * permit costs one refusal and a stale denial costs a farmer their own entry.
 */
export function journalSwipeKind(
    row: SwipeEligibilityRow,
    opts: { canWrite: boolean },
): JournalSwipeKind | null {
    if (row.id.startsWith('optimistic-')) return null;

    const isTreatment = !!row.treatment && row.treatment.parcelCount > 0;
    if (isTreatment) {
        return row.treatment!.mayDelete === false ? null : 'treatment';
    }
    return opts.canWrite ? 'entry' : null;
}
