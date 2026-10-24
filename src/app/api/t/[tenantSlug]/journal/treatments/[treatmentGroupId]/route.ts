import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { deleteDiaryTreatment, getDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedNotFound } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * Look a recorded treatment up by its handle (#1740).
 *
 * The handle is in the PATH rather than a query parameter deliberately: iOS
 * writes the full URL including the query string to the device log,
 * unsuppressably, and a path segment is the one place an identifier can sit
 * without that. It is a server-minted UUID or the client's own
 * `Idempotency-Key`, so it names nothing about a person either way.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const treatment = await getDiaryTreatment(ctx, params.treatmentGroupId);
        if (!treatment) {
            throw codedNotFound(
                'TREATMENT_NOT_FOUND',
                'No treatment was recorded under that handle.',
                { reference: 'treatmentGroupId' },
            );
        }
        return jsonResponse(treatment);
    },
);

/**
 * Remove a treatment (#1777, widened by #2175).
 *
 * Began as the escape hatch for a treatment whose marking keeps failing:
 * without it a farmer is left with one that will neither finish nor go away,
 * because re-sending under the same handle retries the same failing step.
 *
 * Since the owner's 2026-10-22 ruling it removes a COMPLETE treatment too. The
 * 409 `TREATMENT_COMPLETE` that used to refuse one is GONE, and the gate is no
 * longer ADMIN-only: it is the treatment's creator or a farm admin
 * (`TREATMENT_DELETE_NOT_PERMITTED`).
 *
 * The delete is AUDITED and the register stops printing the treatment —
 * `farm-record-diary.ts` filters `task.deletedAt` on the lines it prints. That
 * last part is what makes it a withdrawal rather than a view-level hide.
 *
 * It is **no longer RESTORABLE**, and this docblock said it was until #2172
 * went looking. `./restore` was removed with «Кошче» in #2254 (owner ruling
 * 2026-10-24, "everything deleted is gone"), and the withdrawal now physically
 * deletes the `OperationParcel` lines and the `LogEntry` rows while
 * soft-deleting only the tasks. Reversibility was one of the three protections
 * the 2026-10-22 widening of this gate rested on — #2280 carries that back to
 * the owner.
 *
 * See `deleteDiaryTreatment` for what the owner ruled, what the earlier ruling
 * traded, and why the remaining protections are shaped as they are. The old
 * reasoning is kept there verbatim rather than rewritten.
 */
export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');
        const result = await deleteDiaryTreatment(ctx, params.treatmentGroupId);
        return jsonResponse(result);
    },
);
