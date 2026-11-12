/**
 * The shared vocabulary behind the machine read surface — #2948 stage 3.
 *
 * Every assertion here is about a rule that two or more endpoints have to
 * agree on. A second spelling of any of them is the #1664 class, where two
 * renderings of one rule made the divergence a DISCLOSURE rather than a wrong
 * sentence.
 */
import { MACHINE_ASSET_TYPES } from '@/lib/agriculture/machine-asset-types';
import {
    LOCATABLE_ASSET_TYPES,
    LOCATABLE_ASSET_WHERE,
    MOVING_SPEED_KPH,
    RAW_POSITION_RETENTION_DAYS,
    SELF_PROPELLED_ASSET_TYPES,
    decimalToNumber,
    isDayRetained,
    isMoving,
    isSelfPropelled,
    resolvePositionSource,
} from '@/lib/machines/fleet-view';

describe('which assets are locatable', () => {
    it('is a SUBSET of the machine register, never a rival list', () => {
        // The load-bearing one. `MACHINE_ASSET_TYPES` calls itself "the one
        // definition" of what counts as a machine, so this must narrow it
        // rather than diverge from it. A new AssetType added to the register
        // and forgotten here would be silently absent from every fleet screen;
        // one added here and NOT in the register would be a second definition.
        for (const t of LOCATABLE_ASSET_TYPES) {
            expect(MACHINE_ASSET_TYPES).toContain(t);
        }
    });

    it('excludes exactly the two that carry no position source', () => {
        const excluded = MACHINE_ASSET_TYPES.filter(
            (t) => !LOCATABLE_ASSET_TYPES.includes(t),
        );
        // Asserted as a SET rather than a count: a count is satisfied by
        // excluding the wrong two.
        expect([...excluded].sort()).toEqual(['LIVESTOCK_EQUIPMENT', 'TOOL']);
    });

    it('keeps IMPLEMENT, which the tie-break depends on existing', () => {
        // If a trailed implement were not locatable, #2948's whole
        // self-propelled-first rank would be ordering a one-element list.
        expect(LOCATABLE_ASSET_TYPES).toContain('IMPLEMENT');
        expect(isSelfPropelled('IMPLEMENT')).toBe(false);
    });

    it('prints its denominator', () => {
        console.log(
            `[machines-locatable] ${LOCATABLE_ASSET_TYPES.length} of `
                + `${MACHINE_ASSET_TYPES.length} machine asset type(s) are locatable, `
                + `${SELF_PROPELLED_ASSET_TYPES.length} self-propelled`,
        );
        expect(LOCATABLE_ASSET_TYPES.length).toBeGreaterThan(0);
    });

    it('carries the not-retired / not-deleted half rather than restating it', () => {
        // Spread from MACHINE_ASSET_WHERE, so a change to the soft-delete
        // convention lands in one place. A retired machine on a "where is it
        // now" screen is the defect this prevents.
        expect(LOCATABLE_ASSET_WHERE.deletedAt).toBeNull();
        expect(LOCATABLE_ASSET_WHERE.status).toEqual({ not: 'RETIRED' });
    });
});

describe('isMoving', () => {
    it('is false at a standstill, including the GPS jitter band', () => {
        // The reason the constant is not zero: a parked receiver reports a
        // small nonzero speed as its position wanders inside its own error
        // circle, so `> 0` renders every parked tractor as moving.
        expect(isMoving(0)).toBe(false);
        expect(isMoving(0.4)).toBe(false);
        expect(isMoving(MOVING_SPEED_KPH - 0.01)).toBe(false);
    });

    it('is true from the threshold up, including real working speeds', () => {
        expect(isMoving(MOVING_SPEED_KPH)).toBe(true);
        expect(isMoving(7)).toBe(true);
        expect(isMoving(42)).toBe(true);
    });

    it('is FALSE for an unknown speed, not null', () => {
        // Absence of evidence is not evidence of movement, and the field is a
        // boolean the phone renders as a badge.
        expect(isMoving(null)).toBe(false);
    });

    it('separates the two populations rather than sitting inside one', () => {
        // A sprayer works at 8-15 km/h and a combine at 4-7, so the threshold
        // must be below every working speed and above jitter. If somebody
        // raises it to 5 this fails, which is the point.
        expect(MOVING_SPEED_KPH).toBeGreaterThan(0);
        expect(MOVING_SPEED_KPH).toBeLessThan(4);
    });
});

describe('resolvePositionSource', () => {
    it('reports nothing connected as null', () => {
        expect(
            resolvePositionSource({ hasLiveTracker: false, liveTelematicsProvider: null }),
        ).toBeNull();
    });

    it('reports a tracker with no vendor', () => {
        expect(
            resolvePositionSource({ hasLiveTracker: true, liveTelematicsProvider: null }),
        ).toEqual({ kind: 'TRACKER', provider: null });
    });

    it('prefers TELEMATICS when a machine has BOTH', () => {
        // Not a preference — a singular field has to pick, and picking by
        // "whichever reported last" makes it flicker as data arrives.
        expect(
            resolvePositionSource({
                hasLiveTracker: true,
                liveTelematicsProvider: 'JOHN_DEERE',
            }),
        ).toEqual({ kind: 'TELEMATICS', provider: 'JOHN_DEERE' });
    });

    it('carries the provider for telematics with no tracker', () => {
        expect(
            resolvePositionSource({ hasLiveTracker: false, liveTelematicsProvider: 'CLAAS' }),
        ).toEqual({ kind: 'TELEMATICS', provider: 'CLAAS' });
    });
});

describe('isDayRetained', () => {
    const today = '2026-11-12';

    it('retains today and the whole window', () => {
        expect(isDayRetained('2026-11-12', today)).toBe(true);
        expect(isDayRetained('2026-11-11', today)).toBe(true);
        // Exactly at the boundary — 30 days back is still held.
        expect(isDayRetained('2026-10-13', today)).toBe(true);
    });

    it('does not retain the day past the window', () => {
        // 31 days back.
        expect(isDayRetained('2026-10-12', today)).toBe(false);
        expect(isDayRetained('2026-01-01', today)).toBe(false);
    });

    it('treats a FUTURE day as retained, not deleted', () => {
        // `retained: false` means "we deleted this". A day that has not
        // happened has nothing to delete, and saying otherwise tells the phone
        // we discarded something that never existed.
        expect(isDayRetained('2026-11-13', today)).toBe(true);
        expect(isDayRetained('2027-01-01', today)).toBe(true);
    });

    it('refuses a malformed day rather than guessing', () => {
        expect(isDayRetained('not-a-date', today)).toBe(false);
        expect(isDayRetained('2026-11-12', 'not-a-date')).toBe(false);
    });

    it('matches the window the sweep will delete by', () => {
        expect(RAW_POSITION_RETENTION_DAYS).toBe(30);
    });

    it('is not fooled by a DST boundary', () => {
        // Compared on the DAY in UTC rather than on local instants, so the
        // 25-hour day in late October does not make a day inside the window
        // read as outside it. Bulgaria's clocks went back on 2026-10-25.
        expect(isDayRetained('2026-10-25', '2026-11-12')).toBe(true);
        expect(isDayRetained('2026-10-24', '2026-11-12')).toBe(true);
    });
});

describe('decimalToNumber', () => {
    it('maps a Prisma Decimal through its STRING, not through valueOf', () => {
        expect(decimalToNumber({ toString: () => '12.5' })).toBe(12.5);
    });

    it('passes null and undefined through as null', () => {
        expect(decimalToNumber(null)).toBeNull();
        expect(decimalToNumber(undefined)).toBeNull();
    });

    it('returns null rather than NaN for an unparseable value', () => {
        // NaN serialises to `null` in JSON anyway, so returning it would be a
        // silent null with a confusing intermediate value.
        expect(decimalToNumber({ toString: () => 'oops' })).toBeNull();
    });
});
