import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getDiaryTreatmentDefinition,
    correctDiaryTreatment,
} from '@/app-layer/usecases/diary-treatment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { CorrectDiaryTreatmentSchema } from '@/lib/schemas';
import { jsonResponse } from '@/lib/api-response';
import { parseIfMatch, etagFor } from '@/lib/http/if-match';

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
        // The version travels BOTH ways: in the body, where the form reads it,
        // and as a strong ETag, which is what `parseIfMatch` accepts verbatim.
        // A client that echoes the header needs to reformat nothing, and one
        // that ignores it still has the field.
        return jsonResponse(definition, { headers: { ETag: etagFor(definition.version) } });
    },
);

/**
 * Correct a recorded treatment (#2172).
 *
 * ## `PUT` on the definition, not `PATCH` on the treatment
 *
 * The body is the whole definition because that is what the editor holds and
 * what the prefill handed it. Every field is optional all the same, and an
 * absent field is not a change — so this is idempotent in the way `PUT` is
 * meant to be: sending the same body twice leaves one correction on the record,
 * because the second send finds nothing changed and writes nothing at all.
 *
 * ## `If-Match` carries the GROUP version
 *
 * Not a line version. A correction writes every line of the treatment and the
 * set of lines is itself correctable later, so there is no stable tuple of row
 * versions for a client to send back; `TreatmentGroup.version` exists to be the
 * one thing it can (#2279). Present-but-unparseable is a 400 by `parseIfMatch`
 * — #1182's lesson, where a `/^\d+$/` test fell through to UNGUARDED on `"5"`,
 * the strong tag a well-behaved client actually sends.
 *
 * An ABSENT `If-Match` is allowed through, unguarded, matching every other
 * versioned route in the product. That is a deliberate asymmetry and not a
 * strong one: the correction is still atomic and still trailed, so the loss a
 * missing precondition admits is a last-write-wins overwrite between two people
 * correcting the same treatment at once — recoverable from the
 * `TreatmentCorrection` row, which records the whole previous state.
 *
 * ## What it refuses, and why that is not silence
 *
 * A CHANGED dose, product, water rate or parcel list answers 400
 * `TREATMENT_CORRECTION_FIELD_UNSUPPORTED` with the field names in
 * `params.reference`. An UNCHANGED one is accepted, so the editor may send the
 * whole definition back — see `CorrectDiaryTreatmentSchema`, where #1352 is the
 * precedent in both directions.
 */
export const PUT = withApiErrorHandling(
    withValidatedBody(
        CorrectDiaryTreatmentSchema,
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
            const definition = await correctDiaryTreatment(
                ctx,
                params.treatmentGroupId,
                body,
                expectedVersion,
            );
            return jsonResponse(definition, { headers: { ETag: etagFor(definition.version) } });
        },
    ),
);
