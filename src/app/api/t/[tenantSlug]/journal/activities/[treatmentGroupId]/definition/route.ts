import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getFarmActivityDefinition,
    correctFarmActivity,
} from '@/app-layer/usecases/farm-activity-correction';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { CorrectFarmActivitySchema } from '@/lib/schemas';
import { jsonResponse } from '@/lib/api-response';
import { parseIfMatch, etagFor } from '@/lib/http/if-match';

/**
 * A recorded bare activity's definition, for a correction to prefill (#2373).
 *
 * Deliberately the SAME shape as `../../treatments/{handle}/definition` — a
 * sub-resource, write-gated, carrying the group version in both the body and a
 * strong ETag — so a client holds one mental model for «Коригирай» and switches
 * only the path. What differs is the fields, which is the whole reason this is a
 * second route: an activity has no product, dose, pest or quarantine period, and
 * the treatment route refuses a bare handle with `NOT_A_TREATMENT` precisely
 * because prefilling a correction form with an empty product invites a farmer to
 * overwrite a real record with blanks.
 *
 * The handle stays in the PATH, never a query parameter: iOS writes the full URL
 * including the query string to the device log, unsuppressably.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'JOURNAL');

        const definition = await getFarmActivityDefinition(ctx, params.treatmentGroupId);
        // The version travels BOTH ways: in the body, where the form reads it,
        // and as a strong ETag, which is what `parseIfMatch` accepts verbatim.
        return jsonResponse(definition, { headers: { ETag: etagFor(definition.version) } });
    },
);

/**
 * Correct a recorded bare activity (#2373).
 *
 * Owner approved a correction route for резитба, обработка на почвата and
 * прибиране on 2026-10-25. Until now there was none, while the journal row's
 * `mayCorrect` already said there was — the flag is computed from authorship
 * with no condition on the kind, so a farmer was told they could correct a
 * pruning and the treatment route then refused the handle.
 *
 * ## What it corrects
 *
 * The DAY and, for a harvest, the TOTAL. Not the kind, not the title, not the
 * parcel set — each absent for its own reason, recorded on
 * `CorrectFarmActivitySchema` and on #2373 rather than left to be discovered.
 *
 * ## `If-Match` carries the GROUP version
 *
 * Not a line version: a correction touches every recorded line of the activity,
 * so there is no stable tuple of row versions a client could send back.
 * `TreatmentGroup.version` exists to be the one thing it can (#2279).
 * Present-but-unparseable is a 400 from `parseIfMatch` — #1182's lesson, where a
 * `/^\d+$/` test fell through to UNGUARDED on `"5"`, the strong tag a
 * well-behaved client actually sends.
 *
 * An ABSENT `If-Match` is allowed through unguarded, matching every other
 * versioned route here. The loss that admits is a last-write-wins overwrite
 * between two people correcting the same activity at once, recoverable from the
 * `TreatmentCorrection` row, which stores the whole previous definition.
 *
 * ## Nothing it can do reaches a regulated document
 *
 * Bare activities are excluded from the БАБХ register, so unlike the treatment
 * correction this route cannot alter a form a farmer signs. That is why it can
 * be narrower rather than merely smaller — and why the fields it does not yet
 * carry are a deferral rather than a risk.
 */
export const PUT = withApiErrorHandling(
    withValidatedBody(
        CorrectFarmActivitySchema,
        async (
            req: NextRequest,
            {
                params: paramsPromise,
            }: { params: Promise<{ tenantSlug: string; treatmentGroupId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'JOURNAL');

            const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
            const definition = await correctFarmActivity(
                ctx,
                params.treatmentGroupId,
                body,
                expectedVersion,
            );
            return jsonResponse(definition, { headers: { ETag: etagFor(definition.version) } });
        },
    ),
);
