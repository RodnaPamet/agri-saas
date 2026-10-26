/**
 * Reading the correction history of a journal handle — shared by treatments and
 * bare activities (#2373).
 *
 * `TreatmentCorrection` is ONE table keyed on `(tenantId, groupId)`, and a bare
 * activity's handle already upserts a `TreatmentGroup`, so both kinds of record
 * write their trail here. What differs is the kind GATE on each route and the
 * shape of `previous` — not the envelope.
 *
 * ## Why shared rather than mirrored
 *
 * The agrent-ios session asked for the activity trail's envelope to be identical
 * to the treatments' one, field for field, so the phone can decode both with one
 * type. Writing a second reader would PROMISE that; sharing one GUARANTEES it.
 * The alternative is the failure mode this whole issue was about: two copies of
 * one rule, drifting, with nothing failing when they do.
 *
 * The existence check stays with each CALLER, deliberately. A handle with no
 * corrections and a handle that was never used both have an empty trail, so
 * answering 200 with `corrections: []` to the second would confirm a record that
 * is not there — and each route has to answer that 404 in its own vocabulary
 * (`TREATMENT_NOT_FOUND` / `ACTIVITY_NOT_FOUND`). A shared refusal would make
 * every route speak the treatments'.
 */

import type { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export interface CorrectionTrailEntry<P> {
    correctedAt: string;
    /**
     * The actor's DISPLAY NAME, resolved per read, or null when the correction
     * was not made by a user session.
     *
     * `TreatmentCorrection` stores the id. Storing the name at correction time
     * would freeze it, so a renamed person would show their old name on old
     * corrections and their new one on new ones.
     */
    correctedBy: string | null;
    changedFields: string[];
    previous: P | null;
}

export interface CorrectionTrail<P> {
    treatmentGroupId: string;
    /** The record's current version, so a client can tell a stale trail. */
    version: number;
    /** Newest first. Empty for a record nobody has corrected. */
    corrections: CorrectionTrailEntry<P>[];
}

/**
 * The trail, assuming the caller has ALREADY established that the handle exists
 * and is of the kind its route serves.
 *
 * `P` is the shape of `previous` — a `TreatmentDefinition` or a
 * `FarmActivityDefinition`. It is a type parameter rather than a union because
 * each route serves exactly one, and a union would push the discrimination onto
 * every client instead of onto the path they already chose.
 */
export async function readCorrectionTrail<P>(
    db: PrismaTx,
    ctx: RequestContext,
    handle: string,
): Promise<CorrectionTrail<P>> {
    const [group, rows] = await Promise.all([
        db.treatmentGroup.findUnique({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: handle } },
            select: { version: true },
        }),
        db.treatmentCorrection.findMany({
            where: { tenantId: ctx.tenantId, groupId: handle },
            select: {
                correctedAt: true,
                correctedByUserId: true,
                changedFields: true,
                previous: true,
            },
            orderBy: { correctedAt: 'desc' },
            // Bounded. A record corrected hundreds of times is not a shape to
            // design for, but it is a shape a client should not have to receive
            // in one payload.
            take: 50,
        }),
    ]);

    const actorIds = [...new Set(rows.map((r) => r.correctedByUserId).filter((v): v is string => !!v))];
    const names = new Map<string, string | null>();
    if (actorIds.length > 0) {
        const users = await db.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true },
        });
        for (const u of users) names.set(u.id, u.name ?? null);
    }

    return {
        treatmentGroupId: handle,
        version: group?.version ?? 0,
        corrections: rows.map((r) => ({
            correctedAt: r.correctedAt.toISOString(),
            correctedBy: r.correctedByUserId ? (names.get(r.correctedByUserId) ?? null) : null,
            changedFields: [...r.changedFields],
            previous: (r.previous ?? null) as unknown as P | null,
        })),
    };
}
