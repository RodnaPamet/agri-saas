/**
 * The two database effects the Codec 8 listener performs — #2948 §3.
 *
 * ## Why these are HERE and not in `scripts/machine-listener.ts`
 *
 * They were in the script, and that was wrong for the same reason the session
 * state machine is not in an `on('data')` handler: the script calls
 * `server.listen()` at import, so nothing can import it to test these two
 * functions. The allowlist query is the security boundary of the whole feature
 * and the store is where a timezone or Decimal mistake becomes a wrong row —
 * both need a test that runs them against a real database.
 *
 * ## The timestamp trap this file's test exists to pin
 *
 * `MachinePosition.recordedAt` is `timestamp without time zone`, and a RAW
 * `pg` read of such a column applies the CLIENT's timezone — so reading a
 * Prisma-written instant with node-pg in a `Europe/Sofia` process returns it
 * two hours off, and it looks exactly like an ingest bug. Measured while
 * smoke-testing this listener: the stored text was `2026-11-10 12:00:00`
 * (correct UTC) while a raw read printed `10:00:00.000Z`. Prisma writes and
 * reads UTC correctly in both directions; the READER was wrong.
 *
 * That matters because a two-hour shift on a GPS track is invisible until
 * somebody asks which day a machine worked — and `?date=` is a Europe/Sofia
 * calendar day resolved server-side, so a shifted row lands on the wrong one.
 * The test asserts the STORED TEXT, which is the only reading that is not
 * itself timezone-dependent.
 */
import type { PrismaClient } from '@prisma/client';

import type { Codec8Position } from './codec8';
import type { TrackerIdentity } from './listener-session';

/** Anything with the two delegates used here — so a test can pass a client. */
type IngestClient = Pick<PrismaClient, 'machineTracker' | 'machinePosition'>;

/**
 * Resolve an IMEI to the row that admits it. NO CACHE, deliberately.
 *
 * A cache of POSITIVE results would keep a REMOVED tracker admitted for its
 * TTL — an allowlist that fails open on staleness. The query volume it would
 * save is already bounded by the in-memory rate cap, which runs first, and by
 * a fleet measured in single-digit farms. When that stops being true the fix
 * is a cache of NEGATIVE results, which cannot admit anybody.
 *
 * `removedAt: null` IS the allowlist: a tracker that was pulled stops being
 * admitted, while the positions it already sent still resolve to the machine
 * they came from. Dropping that clause would let a decommissioned box keep
 * writing, which is the one way this query can fail open.
 */
export function makeTrackerLookup(prisma: IngestClient) {
    return async function lookupTracker(imei: string): Promise<TrackerIdentity | null> {
        const row = await prisma.machineTracker.findFirst({
            where: { imei, removedAt: null },
            select: { id: true, assetId: true, tenantId: true },
        });
        if (!row) return null;
        return { trackerId: row.id, assetId: row.assetId, tenantId: row.tenantId };
    };
}

/**
 * ONE batched insert per frame.
 *
 * `skipDuplicates` is deliberately NOT used: there is no unique key on
 * `MachinePosition`, so it would silently do nothing — and a device replaying a
 * buffered backlog after a GSM outage is EXPECTED to resend, which is a product
 * question about de-duplication rather than something to paper over at the
 * insert.
 *
 * `lat`/`lon` go in as STRINGS, and that is the load-bearing part: the columns
 * are `Decimal(10,7)` and `toFixedDegrees` builds those strings by integer
 * arithmetic precisely so no binary float is ever involved. Converting them to
 * numbers here would undo that one line immediately before the write.
 *
 * `speedKph` is passed as a NUMBER. It was `String(...)` for symmetry and a
 * mutation removing that left all 9 tests green — correctly, because Codec 8
 * sends speed as a `uint16`, so it is ALWAYS an integer and no float artefact
 * is reachable. Kept as a number rather than as an unkillable conversion that
 * implies the same precision risk as the coordinates, which it does not share.
 *
 * It writes PRIVILEGED — the listener acts for no user, so there is no session
 * context and `superuser_bypass` applies. What makes that safe is not this
 * function's `where`: `MachinePosition`'s `[assetId, tenantId] -> Asset[id,
 * tenantId]` composite FK means the DATABASE refuses a pairing from two
 * different farms.
 */
export async function storePositions(
    prisma: IngestClient,
    identity: TrackerIdentity,
    positions: readonly Codec8Position[],
): Promise<number> {
    if (positions.length === 0) return 0;
    const res = await prisma.machinePosition.createMany({
        data: positions.map((p) => ({
            tenantId: identity.tenantId,
            assetId: identity.assetId,
            trackerId: identity.trackerId,
            recordedAt: p.recordedAt,
            lat: p.lat,
            lon: p.lon,
            speedKph: p.speedKph,
            headingDeg: p.headingDeg,
            satellites: p.satellites,
            ignition: p.ignition,
        })),
    });
    return res.count;
}
