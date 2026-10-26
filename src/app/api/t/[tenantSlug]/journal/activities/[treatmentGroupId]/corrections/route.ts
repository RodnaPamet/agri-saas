import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getFarmActivityCorrections } from '@/app-layer/usecases/farm-activity-correction';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * A bare activity's correction history (#2373).
 *
 * The same ENVELOPE as `../../treatments/{handle}/corrections` — one
 * `readCorrectionTrail` serves both, so they cannot drift — with `previous`
 * holding a `FarmActivityDefinition` instead of a `TreatmentDefinition`.
 *
 * ## Why this is a second route and not a widening
 *
 * `TreatmentCorrection` is one table, and an activity's handle already upserts a
 * `TreatmentGroup`, so the trail needed no schema change. The READ is a
 * different matter: `previous` is the whole definition of whatever was
 * corrected, so one endpoint would answer with either shape and nothing for a
 * client to discriminate on, under a path naming only one of them.
 *
 * Caught by the agrent-ios session reading the branch before building against
 * it. The correction PR's own claim that the trail "needed no change" was true
 * of the table and silently false of the route — exactly the kind of half-true
 * statement that ships.
 *
 * Refusals are exact complements of the treatments trail's: a bare handle there
 * is `NOT_A_TREATMENT`, a treatment handle here is `NOT_AN_ACTIVITY`. So a
 * client keeps ONE rule — gate the control on `mayCorrect`, pick the address by
 * `kind` — for the prefill, the correction and the history alike.
 *
 * READ-gated, not write-gated, unlike `./definition`: the trail exists so an
 * inspector can see «Коригирано на … от …» and what the record said before, and
 * an inspector is exactly the person the prefill's 403 is for.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const trail = await getFarmActivityCorrections(ctx, params.treatmentGroupId);
        return jsonResponse(trail);
    },
);
