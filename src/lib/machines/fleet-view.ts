/**
 * The machine read surface's shared vocabulary — #2948 stage 3.
 *
 * Three endpoints under `/machines` and three under `/farm-tasks` answer
 * overlapping questions about the same rows, and every one of them has to
 * agree on four things: what a position looks like, what `moving` means,
 * which of a machine's two possible sources wins, and which asset types are
 * findable at all. A second spelling of any of those is the #1664 class —
 * where two renderings of one rule made the divergence a DISCLOSURE rather
 * than a wrong sentence.
 *
 * ## Coordinates leave as STRINGS, and the display scalars leave as numbers
 *
 * `MachinePosition.lat` / `.lon` are `Decimal(10, 7)` because "a day's track
 * is compared and aggregated by the worked-parcel derivation, and binary
 * floating point makes two equal coordinates occasionally unequal". That
 * argument does not survive a `Number()` at the DTO boundary, so it does not
 * happen: the stored decimal reaches the response as the string Prisma hands
 * back. `track-simplify` was built to the same rule — it takes `lon`/`lat` as
 * strings, converts to numbers for the GEOMETRY only, and returns a subset of
 * the input objects by reference, so no coordinate is ever rebuilt from the
 * float the maths used.
 *
 * `speedKph`, `areaHa` and `confidence` are display scalars — nothing compares
 * them for equality or sums them into an identity — so they leave as numbers,
 * which is what a client actually wants to render. The split is deliberate and
 * the phone has to know it, which is why it is stated here rather than implied
 * by whatever the first endpoint happened to do.
 */
import type { AssetType, MachinePositionSource, TelematicsProvider } from '@prisma/client';

import {
    MACHINE_ASSET_TYPE_LIST,
    MACHINE_ASSET_WHERE,
} from '@/lib/agriculture/machine-asset-types';

/**
 * Below this, a machine is standing still.
 *
 * NOT zero, and that is the whole reason this constant exists. A GPS receiver
 * at a standstill reports a small nonzero speed — the position wanders inside
 * its own error circle and the device differentiates that wander — so
 * `speedKph > 0` renders a parked tractor as permanently moving, which is the
 * one thing the field is asked to answer.
 *
 * 1.0 km/h is ~0.28 m/s. It is below any working speed (a sprayer works at
 * 8–15 km/h, a combine at 4–7) and above typical standstill jitter, so it
 * separates the two populations rather than sitting inside either.
 */
export const MOVING_SPEED_KPH = 1.0;

/**
 * Hard ceiling on positions READ for one machine-day.
 *
 * Distinct from simplification, and the response reports both separately:
 * `truncated` means rows were never CONSIDERED, `simplified` means every row
 * was read and the line was reduced for display. Collapsing them would let a
 * partial day render as a clean one.
 *
 * A 30-second tracker writes ~2,880 points a day and a 10-second one ~8,640,
 * so this is well clear of any sane device while still bounding a malfunctioning
 * one — which is the case it exists for, since the writer is a public socket.
 */
export const MAX_POSITIONS_PER_DAY = 20_000;

/**
 * Asset types that can carry a position source.
 *
 * DERIVED from `MACHINE_ASSET_TYPES` rather than listed independently, because
 * that constant is already "the one definition" of what counts as a machine in
 * this product, and a second free-standing list is how two surfaces come to
 * disagree. This is a NARROWING of it, not a rival to it — and the two answer
 * genuinely different questions, which is why the narrowing exists at all:
 * `MACHINE_ASSET_WHERE` answers "can a field operation be performed WITH this"
 * (a hand tool, yes), and this answers "can this report where it is".
 *
 * Excluded from that set here:
 *   - TOOL — a hand tool carries no box and no telematics.
 *   - LIVESTOCK_EQUIPMENT — barn-bound; it does not drive to a field.
 *
 * `IMPLEMENT` IS included. A trailed implement can carry a tracker, and
 * #2948's tie-break exists precisely because one task can have both a tractor
 * and a tracked implement.
 *
 * The subset relation is asserted by this module's test, so adding an
 * `AssetType` to the machine register forces a decision here rather than
 * silently leaving a new machine type off every fleet screen.
 */
const NOT_LOCATABLE: readonly AssetType[] = ['TOOL', 'LIVESTOCK_EQUIPMENT'] as const;

export const LOCATABLE_ASSET_TYPES: readonly AssetType[] = MACHINE_ASSET_TYPE_LIST.filter(
    (t) => !NOT_LOCATABLE.includes(t),
);

/** Mutable copy for Prisma's `{ in: [...] }`, which wants a plain array. */
export const LOCATABLE_ASSET_TYPE_LIST: AssetType[] = [...LOCATABLE_ASSET_TYPES];

/**
 * The `where` fragment every locatable-machine read shares.
 *
 * Spreads `MACHINE_ASSET_WHERE` so the not-retired / not-soft-deleted half
 * stays in ONE place, then narrows `type`. A retired machine keeps its history
 * in /assets and must not appear on a screen asking where things are now.
 */
export const LOCATABLE_ASSET_WHERE = {
    ...MACHINE_ASSET_WHERE,
    type: { in: LOCATABLE_ASSET_TYPE_LIST },
} as const;

/**
 * Self-propelled types, the tie-break's first rank.
 *
 * #2948: "an implement has no engine and, if tracked at all, is physically
 * wherever the tractor pulling it is. A mechanisator asking 'where is my
 * machine' wants the thing that moves under its own power."
 */
export const SELF_PROPELLED_ASSET_TYPES: readonly AssetType[] = [
    'TRACTOR',
    'HARVESTER',
    'VEHICLE',
] as const;

export function isSelfPropelled(type: AssetType): boolean {
    return SELF_PROPELLED_ASSET_TYPES.includes(type);
}

/** What a machine's position source IS — configuration, never liveness. */
export interface PositionSourceView {
    kind: MachinePositionSource;
    /** Set only for `TELEMATICS`; a tracker has no vendor. */
    provider: TelematicsProvider | null;
}

export interface PositionView {
    /** `Decimal(10, 7)` as its stored string. Never a float. */
    lat: string;
    lon: string;
    recordedAt: string;
    speedKph: number | null;
    ignition: boolean | null;
    /** Server-derived from `speedKph` against `MOVING_SPEED_KPH`. */
    moving: boolean;
}

export interface MachineRowView {
    assetId: string;
    name: string;
    type: AssetType;
    /**
     * CONFIGURATION. `null` means nothing is connected — which is a different
     * statement from `lastPosition: null`, meaning connected and never heard
     * from. #2948 settles that split with these two fields rather than a third.
     */
    positionSource: PositionSourceView | null;
    /** LIVENESS. Staleness is the client's judgement from `recordedAt`. */
    lastPosition: PositionView | null;
}

/**
 * Is this machine moving?
 *
 * `null` speed yields `false`, not `null`. A device that reports no speed has
 * told us nothing, and the field is a boolean the phone renders as a badge —
 * so the question is "do we have evidence of movement", and absence of
 * evidence is not evidence of movement. Deliberately NOT derived from
 * `ignition`: an idling tractor has the engine on and is not moving, which is
 * the exact case a driver looking for their machine cares about.
 */
export function isMoving(speedKph: number | null): boolean {
    if (speedKph === null) return false;
    return speedKph >= MOVING_SPEED_KPH;
}

/** A `Decimal | null` from Prisma as a display number. */
export function decimalToNumber(v: { toString(): string } | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : null;
}

/**
 * Which source a machine reports through, when it has both.
 *
 * TELEMATICS beats TRACKER — #2948, and the reason is not preference: a
 * singular field has to pick, and picking by "whichever reported last" makes
 * it FLICKER as data arrives. Configuration is stable; liveness is not. The
 * vendor path also wins on merit, being authenticated and carrying more than
 * coordinates, where a Codec 8 box's whole identity is an IMEI.
 */
export function resolvePositionSource(args: {
    hasLiveTracker: boolean;
    liveTelematicsProvider: TelematicsProvider | null;
}): PositionSourceView | null {
    if (args.liveTelematicsProvider !== null) {
        return { kind: 'TELEMATICS', provider: args.liveTelematicsProvider };
    }
    if (args.hasLiveTracker) return { kind: 'TRACKER', provider: null };
    return null;
}

/**
 * How long raw positions are kept — owner ruling, #2948 §2.
 *
 * The nightly sweep deletes past this, and `/track` reports `retained: false`
 * for a day outside it. Both must read THIS constant: if the read's window and
 * the sweep's window ever disagree, the endpoint claims to hold a day it has
 * deleted (an empty track read as "the machine sat idle") or disclaims a day it
 * still holds. The sweep does not exist yet; when it lands it imports this.
 */
export const RAW_POSITION_RETENTION_DAYS = 30;

/**
 * Is a farm day still inside the raw-position window?
 *
 * Compared on the DAY, not the instant, because the retention promise is about
 * calendar days and an instant comparison would make the answer flip
 * mid-request for a day exactly on the boundary.
 */
export function isDayRetained(dayKey: string, today: string): boolean {
    const day = Date.parse(`${dayKey}T00:00:00Z`);
    const now = Date.parse(`${today}T00:00:00Z`);
    if (Number.isNaN(day) || Number.isNaN(now)) return false;
    const ageDays = Math.round((now - day) / 86_400_000);
    // A future day is not "unretained" — it has nothing to retain, and
    // reporting `false` there would tell the phone we deleted something that
    // never existed.
    if (ageDays < 0) return true;
    return ageDays <= RAW_POSITION_RETENTION_DAYS;
}
