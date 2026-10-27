/**
 * Why a treatment-scoped ДНЕВНИК came back empty, as a refusal (#2019).
 *
 * `generateFarmRecordDiaryPdfScoped` returns null for a treatment handle with
 * nothing the БАБХ register covers, and that single null stands for two
 * different facts about the farm. Deciding between them needs a second query,
 * which is why this is a function rather than a constant.
 *
 * Extracted from `GET /journal/treatments/{id}/farm-record` when the Drive
 * export grew a second caller. It is here rather than duplicated because the
 * reasoning below is the kind that gets copied once and then diverges: the next
 * person to touch one of the two call sites would have no way to know the other
 * existed.
 *
 * ## The three codes, and why a sowing needs its own
 *
 * A handle with no recorded lines is a 404 rather than an empty register. A
 * blank document is indistinguishable from a real one whose treatment happened
 * to record nothing, and a farmer cannot tell which they are holding.
 *
 * But a SOWING is a third case (#2316), and reporting it as either of the other
 * two would be a false statement about real data. The record EXISTS and prints
 * in «ДНЕВНИК НА СТОПАНСТВОТО»; it is only the БАБХ register that excludes it,
 * because that form covers «РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ И ТОРЕНЕ» and a
 * sowing is neither.
 *
 *   - `TREATMENT_NOT_FOUND` would say the handle names nothing, which is untrue
 *     and would send someone looking for a write that did not fail.
 *   - `NOT_A_TREATMENT` (#2344) would say it is a field activity, which is also
 *     untrue — сеитба goes through the treatments route precisely because it
 *     applies a product.
 *
 * Hence a third code.
 */

import { treatmentKindOf } from '@/app-layer/usecases/diary-treatment';
import type { RequestContext } from '../../types';
import { codedNotFound, type NotFoundError } from '@/lib/errors/types';

/**
 * Returns the error to throw, rather than throwing it. Call it as
 * `throw await farmRecordAbsence(ctx, id)`.
 *
 * That shape is not a style preference. A `Promise<never>` helper that throws
 * reads better at the call site — `if (!doc) await refuse(...)` — but
 * TypeScript does not narrow across it: control-flow analysis only treats a
 * call as terminating when it is a direct call to a `never`-returning
 * function, and `await` breaks that. The caller then fails to narrow `doc` and
 * the next line errors on `PDFDocument | null`. Returning the error keeps
 * `throw` as the terminator, where narrowing does work.
 */
export async function farmRecordAbsence(
    ctx: RequestContext,
    treatmentGroupId: string,
): Promise<NotFoundError> {
    const kind = await treatmentKindOf(ctx, treatmentGroupId);
    if (kind === 'SEED') {
        return codedNotFound(
            'NOT_IN_BABH_REGISTER',
            'A sowing is not part of the БАБХ register, which covers plant protection '
                + 'and fertilising. It appears in the whole-farm journal instead.',
            { reference: 'treatmentGroupId' },
        );
    }
    return codedNotFound(
        'TREATMENT_NOT_FOUND',
        'No treatment was recorded under that handle.',
        { reference: 'treatmentGroupId' },
    );
}
