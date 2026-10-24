import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getDiaryTreatmentCorrections } from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * A treatment's correction history (#2172).
 *
 * ## A READ gate, unlike its sibling
 *
 * `./definition` is write-gated: `canWrite`, then single authorship, then
 * creator-or-admin, because its body exists to be edited and sent back. This
 * one is `canRead`. The owner asked (#392, 22 Oct) that a corrected entry show
 * «Коригирано на … от …» with the previous values readable for an INSPECTOR —
 * and an inspector is precisely who the prefill's 403 is for, so sharing that
 * gate would hide the trail from its audience.
 *
 * A reader learns no new class of fact: every `previous` is a definition of the
 * same treatment they are already looking at. The new fact is that a value used
 * to be different, which is what the record exists to state.
 *
 * ## Its own path rather than fields on `./definition`
 *
 * Two reasons, and the gate is only the first. The trail is also unbounded
 * where a definition is one object, so folding it in would put a growing list
 * on the payload of every correction prefill — and a client showing
 * «Коригирано на …» on a journal row needs the trail WITHOUT wanting to open an
 * editor.
 *
 * The handle stays a PATH segment, never a query parameter: iOS writes the full
 * URL including the query string to the device log, unsuppressably.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const trail = await getDiaryTreatmentCorrections(ctx, params.treatmentGroupId);
        return jsonResponse(trail);
    },
);
