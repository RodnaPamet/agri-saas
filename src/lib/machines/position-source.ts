/**
 * The position-source adapter contract — #2948, owner ruling 2026-11-10.
 *
 * Five sources: four manufacturer telematics platforms (John Deere, CNH,
 * CLAAS, AGCO) and the Codec 8 tracker listener from #2973. One per farm,
 * switched on with that farm's credentials and no code change.
 *
 * ## "ONE INTERFACE ACROSS ALL FIVE" IS NOT QUITE RIGHT, AND FORCING IT WOULD
 * ## PRODUCE AN ADAPTER WHOSE MAIN METHOD THROWS
 *
 * The ruling asked for one interface implementing auth, mapping and "fetching
 * history including backfill". Four of the five are PULL sources: we hold a
 * credential, we call them, we page with a cursor. The fifth is a PUSH source:
 * devices dial into a socket we listen on, and there is nothing to poll. A
 * `positionsSince(cursor)` on the Codec 8 adapter could only throw
 * `NOT_APPLICABLE`, and a contract whose implementations must refuse half of it
 * is a contract that has stopped describing anything.
 *
 * So the shared part is split from the pull-only part:
 *
 *   `PositionSource`     what every source has — its KIND and provider, which
 *                        is what a read surface reports as `positionSource`
 *   `PullPositionSource` the four vendors and the simulator: list machines,
 *                        fetch positions since a cursor, refresh a credential
 *
 * The Codec 8 listener is a `PositionSource` and deliberately NOT a
 * `PullPositionSource`. Everything that iterates sources to SYNC iterates the
 * pull ones; everything that reports what a machine's source IS iterates all
 * of them. Two populations, each named, rather than one with a hole in it.
 *
 * ## AN ADAPTER TOUCHES NO DATABASE, and that is the load-bearing choice
 *
 * `positionsSince` returns VENDOR-NEUTRAL positions keyed by the vendor's own
 * machine id. It does not know about tenants, assets or `MachinePosition`; the
 * orchestrator resolves ids to assets through `MachineTelematicsLink` and
 * writes the rows.
 *
 * Which means every adapter is a pure function from a payload to neutral
 * positions — testable against a fixture with no Prisma, no mocks and no
 * network. That matters more here than usual: with no vendor accounts in
 * existence, a fixture is the ONLY thing any of the four can be tested
 * against, so the thing under test had better not need a database to run.
 *
 * It also keeps tenant resolution in ONE place. An adapter that could write
 * rows would be an adapter that could write them to the wrong farm, and the
 * vendor's machine id is attacker-influenced in exactly the way an IMEI is
 * (#2973: "no dynamic tenant resolution from the wire").
 *
 * ## THE FIXTURES MUST BE THE VENDORS' OWN DOCUMENTED SAMPLES
 *
 * An adapter tested on a payload I invented asserts my mapping against my own
 * guess at the shape and passes either way — the `a-probe-with-no-
 * discriminating-power` shape. Each adapter's fixture carries the source URL
 * it came from, and where a vendor publishes no example the adapter says so
 * rather than shipping one that looks equally verified.
 */
import type { TelematicsProvider } from '@prisma/client';

/** What a read surface reports as `positionSource`, per the iOS contract. */
export interface PositionSourceDescriptor {
    kind: 'TRACKER' | 'TELEMATICS' | 'SIMULATED';
    /** `null` for TRACKER and SIMULATED, which have no manufacturer. */
    provider: TelematicsProvider | null;
}

/** Common to all five sources, pull and push alike. */
export interface PositionSource {
    readonly descriptor: PositionSourceDescriptor;
    /**
     * A stable key for logs and counters. NOT user-facing: the phone renders
     * its own label per kind and provider.
     */
    readonly id: string;
}

/** One machine as the vendor describes it. */
export interface SourceMachine {
    /**
     * The vendor's identifier. Opaque — never parsed, never displayed as an
     * identity, and the only thing joining our `Asset` to their fleet.
     */
    externalMachineId: string;
    /** The vendor's label, for an admin reconciling which tractor is which. */
    name: string | null;
}

/**
 * A position as the adapter decoded it, before any tenant exists.
 *
 * Coordinates are STRINGS for `toFixedDegrees`'s reason: the column is
 * `Decimal(10,7)` and the worked-parcel derivation compares coordinates, so no
 * value here passes through a binary float.
 */
export interface SourcePosition {
    externalMachineId: string;
    /**
     * The SOURCE's own timestamp, not arrival time. A vendor API backfills
     * history and a tracker replays a buffer, so arrival order is not
     * chronological order in either case.
     */
    recordedAt: Date;
    lat: string;
    lon: string;
    speedKph: number | null;
    headingDeg: number | null;
    /** `null` where the source does not report it — never defaulted to false. */
    ignition: boolean | null;
    satellites: number | null;
}

export interface PullResult {
    positions: SourcePosition[];
    /**
     * Where to resume. `null` means the adapter has no resumable position and
     * the next call starts over — which is NOT the same as "caught up", and is
     * why `complete` is separate.
     */
    cursor: string | null;
    /**
     * False when the vendor has more to give than this call returned, so the
     * orchestrator knows to come back rather than waiting for the next
     * schedule. A backfill of months is many calls.
     */
    complete: boolean;
}

/** Whatever an adapter needs to authenticate, read from its connection. */
export interface SourceCredentials {
    accessToken?: string;
    refreshToken?: string;
    /** Per-vendor extras — an org id, a partner id, a region host. */
    readonly extra?: Readonly<Record<string, string>>;
}

export interface RefreshedCredentials {
    credentials: SourceCredentials;
    /** When the new access token expires, if the vendor says. */
    expiresAt: Date | null;
}

/**
 * The four vendor platforms and the simulator.
 *
 * NOT implemented by the Codec 8 listener — see the docblock. A push source has
 * no cursor to resume from because nothing is being asked.
 */
export interface PullPositionSource extends PositionSource {
    /**
     * The machines this connection can see. An admin picks from these to
     * create a `MachineTelematicsLink`; nothing is linked automatically, for
     * `channels-are-never-auto-joined`'s reason — a link records a decision,
     * and the drivers-informed columns are required at creation.
     */
    listMachines(credentials: SourceCredentials): Promise<SourceMachine[]>;

    /**
     * Positions newer than `cursor`, or from the beginning when it is null.
     *
     * `machineIds` is passed so a sync asks only about LINKED machines. A
     * vendor organisation may hold machines this farm has not linked — a
     * contractor's, a dealer's demo unit — and pulling those would store
     * positions for a machine nobody consented to track.
     */
    positionsSince(
        credentials: SourceCredentials,
        machineIds: readonly string[],
        cursor: string | null,
    ): Promise<PullResult>;

    /**
     * Exchange a refresh token for a new access token.
     *
     * Optional because not every vendor issues short-lived tokens; an adapter
     * without one is declaring that its credential does not expire, which is a
     * claim a reader can check rather than an omission.
     */
    refreshCredentials?(credentials: SourceCredentials): Promise<RefreshedCredentials>;
}

/** Type guard, so the two populations are told apart by a function. */
export function isPullSource(s: PositionSource): s is PullPositionSource {
    return typeof (s as PullPositionSource).positionsSince === 'function';
}
