/**
 * The position-source contract, and the one design decision in it that is
 * worth making executable: the Codec 8 listener is a source but NOT a pull
 * source.
 *
 * The ruling asked for "one interface" across all five. Four are PULL (we hold
 * a credential and call them); the fifth is PUSH (devices dial into a socket).
 * Forcing one interface gives the Codec 8 adapter a `positionsSince` that can
 * only throw, and a contract whose implementations must refuse half of it has
 * stopped describing anything. So there are two populations, and `isPullSource`
 * is how code tells them apart — which means a future adapter cannot land in
 * the wrong one silently.
 */
import {
    isPullSource,
    type PositionSource,
    type PullPositionSource,
    type SourcePosition,
} from '@/lib/machines/position-source';

/** The push source: a descriptor and nothing to poll. */
const codec8: PositionSource = {
    id: 'codec8',
    descriptor: { kind: 'TRACKER', provider: null },
};

/** A pull source, standing in for the four vendors. */
const vendor: PullPositionSource = {
    id: 'john-deere',
    descriptor: { kind: 'TELEMATICS', provider: 'JOHN_DEERE' },
    listMachines: async () => [{ externalMachineId: 'JD-1', name: '6155M' }],
    positionsSince: async () => ({ positions: [], cursor: null, complete: true }),
};

describe('§1 the two populations are told apart by a function', () => {
    it('a vendor source IS a pull source', () => {
        expect(isPullSource(vendor)).toBe(true);
    });

    it('the Codec 8 listener is NOT — it has nothing to poll', () => {
        // The design decision, executable. If someone later adds a throwing
        // `positionsSince` to the tracker adapter to satisfy "one interface",
        // this goes red — which is the point.
        expect(isPullSource(codec8)).toBe(false);
    });

    it('the guard reads the METHOD, not the kind', () => {
        // So the simulator — kind SIMULATED, not TELEMATICS — is still
        // correctly a pull source, and a future push-based vendor would
        // correctly not be.
        const simulator: PullPositionSource = {
            ...vendor,
            id: 'simulator',
            descriptor: { kind: 'SIMULATED', provider: null },
        };
        expect(isPullSource(simulator)).toBe(true);

        const pushVendor: PositionSource = {
            id: 'hypothetical',
            descriptor: { kind: 'TELEMATICS', provider: 'CLAAS' },
        };
        expect(isPullSource(pushVendor)).toBe(false);
    });
});

describe('§2 the descriptor is what a read surface reports', () => {
    it('provider is null for the sources that have no manufacturer', () => {
        expect(codec8.descriptor.provider).toBeNull();
    });

    it('provider is set for a vendor', () => {
        expect(vendor.descriptor).toEqual({ kind: 'TELEMATICS', provider: 'JOHN_DEERE' });
    });

    it('every provider value is a legal descriptor provider', () => {
        // Derived from the enum rather than listed, so a fifth provider added
        // to the schema cannot be forgotten here.
        const { TelematicsProvider } = jest.requireActual('@prisma/client');
        for (const p of Object.keys(TelematicsProvider)) {
            const d: PositionSource = {
                id: `x-${p}`,
                descriptor: { kind: 'TELEMATICS', provider: p as never },
            };
            expect(d.descriptor.provider).toBe(p);
        }
        expect(Object.keys(TelematicsProvider)).toEqual(['JOHN_DEERE', 'CNH', 'CLAAS', 'AGCO']);
    });
});

describe('§3 a neutral position carries no tenant, and that is deliberate', () => {
    it('is keyed by the VENDOR machine id, not by an asset', async () => {
        // An adapter that could name an asset would be an adapter that could
        // name the WRONG asset, and the vendor machine id is
        // attacker-influenced in the way an IMEI is. Tenant resolution lives
        // in one place: the orchestrator, through MachineTelematicsLink.
        const r = await vendor.positionsSince({ accessToken: 't' }, ['JD-1'], null);
        expect(r.positions).toEqual([]);
        // The shape a caller may rely on, asserted structurally.
        const sample: SourcePosition = {
            externalMachineId: 'JD-1',
            recordedAt: new Date('2026-11-10T12:00:00.000Z'),
            lat: '42.6977000',
            lon: '23.3219000',
            speedKph: 12,
            headingDeg: 180,
            ignition: true,
            satellites: 11,
        };
        expect(Object.keys(sample).sort()).toEqual([
            'externalMachineId', 'headingDeg', 'ignition', 'lat', 'lon',
            'recordedAt', 'satellites', 'speedKph',
        ]);
        // No tenantId, no assetId — if either appears here, resolution has
        // leaked into the adapter layer.
        expect(Object.keys(sample)).not.toContain('tenantId');
        expect(Object.keys(sample)).not.toContain('assetId');
    });

    it('coordinates are STRINGS, so no value passes through a float', () => {
        const sample: SourcePosition['lat'] = '42.6977000';
        expect(typeof sample).toBe('string');
    });
});

describe('§4 cursor and completeness are separate facts', () => {
    it('a null cursor does NOT mean caught up', async () => {
        // `cursor: null` means "no resumable position, start over"; `complete`
        // means "nothing more to give". Collapsing them would make a backfill
        // of months either loop for ever or stop after one page.
        const r = await vendor.positionsSince({ accessToken: 't' }, ['JD-1'], null);
        expect(r.cursor).toBeNull();
        expect(r.complete).toBe(true);
        // The two are independent, which is the property worth pinning.
        const partial = { positions: [], cursor: 'abc', complete: false };
        expect(partial.cursor).not.toBeNull();
        expect(partial.complete).toBe(false);
    });
});
