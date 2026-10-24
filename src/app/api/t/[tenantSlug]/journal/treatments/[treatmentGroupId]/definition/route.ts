import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getDiaryTreatmentDefinition } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * A recorded treatment's COMPLETE definition, for a correction to prefill (#2172).
 *
 * ## Why a sub-resource rather than fields on `../`
 *
 * `GET ../` is the SUMMARY the journal detail view reads — it takes one line
 * and selects `completedAt` and `phenophase`. Widening it would put every
 * parcel, every treated area, the product, the dose and both units on the
 * payload of every journal detail read, for the sake of the one caller that is
 * about to open a correction form. `./farm-record` is already a sub-resource
 * for the same reason.
 *
 * ## It is a WRITE-gated read
 *
 * `getDiaryTreatmentDefinition` requires `canWrite`, then establishes single
 * authorship, then applies `assertCanEditTreatment`. So this answers 403 to a
 * reader who may see the treatment in the journal but may not correct it —
 * deliberately, because the body is the whole record and its only purpose is to
 * be edited and sent back.
 *
 * A client that wants to decide whether to OFFER the control should not probe
 * this: the journal list already carries a server-computed `mayDelete` for the
 * same population, and the treatment edit rule is the same creator-or-admin
 * test. Offering a control that 403s is worse than an absent one, which is the
 * reasoning `swipe-eligibility.ts` already records.
 *
 * The handle stays in the PATH, never a query parameter: iOS writes the full
 * URL including the query string to the device log, unsuppressably.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const definition = await getDiaryTreatmentDefinition(ctx, params.treatmentGroupId);
        return jsonResponse(definition);
    },
);
