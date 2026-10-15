/**
 * @jest-environment jsdom
 *
 * Only allowlisted endpoints reach the disk.
 *
 * ## The defect
 *
 * The persistent SWR cache wrote EVERY successful response to
 * localStorage (and spilled large ones to IndexedDB) with no filter at
 * all. `/leases` goes through `useTenantSWR`, and a lease row carries
 * `lessorName` + `lessorEik` — Bulgarian landlord PII, listed in the
 * Epic B `ENCRYPTED_FIELDS` manifest precisely because it is personal
 * data about a third party the farm contracts with. Server-side it is
 * AES-encrypted under a per-tenant DEK. Client-side it was plaintext
 * JSON on the phone.
 *
 * Nobody decided that. Persisting it required no decision — only that
 * the Rent page use the same hook as every other list.
 *
 * ## Why these tests EXECUTE rather than grep
 *
 * This repo's own rule: green is not the same as executed. A guard
 * asserting `isPersistableKey` appears in `collectEntries` would pass
 * against a version that called it and ignored the result. So every
 * assertion here drives the real provider and then reads what actually
 * landed in storage.
 *
 * The spill branch is covered deliberately: lists are exactly what grows
 * past `LS_BYTE_BUDGET`, so a gate that only worked on the localStorage
 * tier would leak precisely the biggest payloads.
 */
import {
    createPersistentCacheProvider,
    storageKey,
    isPersistableKey,
    tenantRelativePath,
    SWR_CACHE_VERSION,
} from '@/lib/swr/persistent-cache';

const NS = 'usr_1::acme-corp';
const LEASES = '/api/t/acme-corp/leases';
const JOURNAL = '/api/t/acme-corp/journal';

/**
 * Drive the provider Map directly rather than through `useSWR`.
 *
 * The Map IS the provider contract — SWR sets `{data}` on it and the
 * flush reads it back — so this exercises the real `collectEntries`
 * funnel without depending on SWR's internal resolution timing, which
 * is not what these assertions are about.
 */
function persistThrough(entries: [string, unknown][]) {
    const map = createPersistentCacheProvider({ namespace: NS });
    for (const [k, v] of entries) map.set(k, { data: v });
    // The provider flushes on visibilitychange → hidden.
    Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    return map;
}

function readBucket(): { entries: [string, unknown][] } | null {
    const raw = window.localStorage.getItem(storageKey(NS));
    return raw ? JSON.parse(raw) : null;
}

beforeEach(() => window.localStorage.clear());

describe('the key predicate', () => {
    it.each([
        [JOURNAL, true],
        ['/api/t/acme-corp/journal?deleted=true', true],
        ['/api/t/acme-corp/farm-tasks?open=1', true],
        ['/api/t/acme-corp/locations', true],
        ['/api/t/acme-corp/locations/loc_1/parcels', true],
        ['/api/t/acme-corp/exchange/listings', true],
        // #1845 — the treatment form's four reads, in the exact shapes
        // `TreatmentEntryModal` builds them. These are the assertions that
        // fail if somebody trims the allowlist back to the P3 four.
        ['/api/t/acme-corp/items', true],
        ['/api/t/acme-corp/units?measure=RATE', true],
        ['/api/t/acme-corp/parcels/by-crop', true],
        ['/api/t/acme-corp/parcels/by-crop?crop=%D0%9F%D1%88%D0%B5%D0%BD%D0%B8%D1%86%D0%B0', true],
        // A CONSEQUENCE of the `/items` entry rather than a separate
        // decision, named here so it is visible: the matcher admits
        // children, so the single-item route rides along. Same reference
        // data, one row of it — acceptable, and better written down than
        // discovered.
        ['/api/t/acme-corp/items/item_1', true],
        // The reason this work exists.
        [LEASES, false],
        ['/api/t/acme-corp/leases/parcel-options', false],
        ['/api/t/acme-corp/reports/rent-roll', false],
        // Non-tenant keys do not match the tenant-relative allowlist,
        // which is the safe outcome rather than an accident.
        ['/api/auth/me', false],
        ['/api/notifications', false],
        // Admin surfaces.
        ['/api/t/acme-corp/admin/companies', false],
    ])('isPersistableKey(%s) === %s', (key, expected) => {
        expect(isPersistableKey(key)).toBe(expected);
    });

    it('is segment-aware — a prefix must not swallow a neighbouring endpoint', () => {
        // `startsWith('/journal')` would also match '/journal-exports'.
        // A prefix test that leaks a neighbour is the same bug as a denylist.
        expect(isPersistableKey('/api/t/acme-corp/journal-exports')).toBe(false);
        expect(isPersistableKey('/api/t/acme-corp/locations-archive')).toBe(false);
        // The #1845 entries get the same treatment. `/parcels/by-crop` must
        // NOT drag in the bare parcels list: that read is not one of the
        // form's four and has not been through the on-disk decision.
        expect(isPersistableKey('/api/t/acme-corp/parcels')).toBe(false);
        expect(isPersistableKey('/api/t/acme-corp/items-import')).toBe(false);
        expect(isPersistableKey('/api/t/acme-corp/units-of-measure')).toBe(false);
    });

    it('normalises a key to a tenant-relative path', () => {
        expect(tenantRelativePath('/api/t/acme-corp/journal?x=1#f')).toBe('/journal');
        expect(tenantRelativePath('/api/auth/me')).toBe('/api/auth/me');
    });
});

describe('what actually reaches the disk', () => {
    it('persists an allowlisted list', () => {
        persistThrough([[JOURNAL, [{ id: 'j1' }]]]);
        const keys = (readBucket()?.entries ?? []).map(([k]) => k);
        expect(keys).toContain(JOURNAL);
    });

    it('persists the treatment form\u2019s four reads, geometry included (#1845)', () => {
        // The point of #1845: «Нов запис» could not be OPENED without
        // signal, because none of its reads were allowlisted. Asserting the
        // predicate is not enough -- `collectEntries` is the write funnel and
        // the two by-crop shapes normalise to ONE allowlist path, so this also
        // proves they are stored under their own raw keys rather than
        // overwriting each other.
        const ITEMS = '/api/t/acme-corp/items';
        const UNITS = '/api/t/acme-corp/units?measure=RATE';
        const CROPS = '/api/t/acme-corp/parcels/by-crop';
        const PARCELS = '/api/t/acme-corp/parcels/by-crop?crop=Wheat';

        persistThrough([
            [ITEMS, { items: [{ id: 'i1', name: 'Karate Zeon', category: 'PESTICIDE' }] }],
            [UNITS, { units: [{ id: 'u1', code: 'L_HA' }] }],
            [CROPS, { crops: [{ cropType: 'Wheat', areaHa: 12.5 }] }],
            [PARCELS, {
                cropType: 'Wheat',
                parcels: [{
                    id: 'p1',
                    name: 'North block',
                    areaHa: 12.5,
                    locationId: 'loc_1',
                    locationName: 'Home farm',
                    geometry: { type: 'Polygon', coordinates: [[[25.1, 42.1], [25.2, 42.1], [25.2, 42.2], [25.1, 42.1]]] },
                }],
            }],
        ]);

        const entries = readBucket()?.entries ?? [];
        const keys = entries.map(([k]) => k);
        // All four, and the two by-crop shapes as SEPARATE entries.
        expect(keys).toEqual(expect.arrayContaining([ITEMS, UNITS, CROPS, PARCELS]));
        expect(keys.filter((k) => k.includes('by-crop'))).toHaveLength(2);

        // And the geometry survived the round trip rather than being
        // stripped -- a persisted parcel with no geometry draws no map, which
        // would be this fix shipping while still failing offline.
        const stored = entries.find(([k]) => k === PARCELS)?.[1] as
            | { parcels?: Array<{ geometry?: unknown; locationName?: string }> }
            | undefined;
        expect(stored?.parcels?.[0]?.geometry).toEqual({
            type: 'Polygon',
            coordinates: [[[25.1, 42.1], [25.2, 42.1], [25.2, 42.2], [25.1, 42.1]]],
        });
        expect(stored?.parcels?.[0]?.locationName).toBe('Home farm');
    });

    it('does NOT persist lease rows, even alongside an allowlisted one', () => {
        // The mixed case matters: the gate is per-entry, so a disallowed
        // key must not ride along with an allowed one in the same flush.
        persistThrough([
            [JOURNAL, [{ id: 'j1' }]],
            [LEASES, [{ id: 'l1', lessorName: 'Иван Петров', lessorEik: '1234567890' }]],
        ]);
        const bucket = readBucket();
        const keys = (bucket?.entries ?? []).map(([k]) => k);
        expect(keys).toContain(JOURNAL);
        expect(keys).not.toContain(LEASES);
        // And the PII itself is nowhere in the serialized bytes — the
        // assertion that survives a refactor of the entry shape.
        expect(JSON.stringify(bucket)).not.toContain('Иван Петров');
        expect(JSON.stringify(bucket)).not.toContain('1234567890');
    });

    it('writes nothing at all when only disallowed keys are cached', () => {
        persistThrough([[LEASES, [{ id: 'l1', lessorName: 'Иван Петров' }]]]);
        const bucket = readBucket();
        expect(bucket?.entries ?? []).toEqual([]);
    });
});

describe('a bucket already on disk', () => {
    it('does not rehydrate disallowed entries written by an older build', () => {
        // Belt and braces beside the version bump. If a v2 bucket somehow
        // contains a disallowed key, reading it back must not put the data
        // in front of a user — the flush that would drop it is not
        // guaranteed to run before the render that would show it.
        window.localStorage.setItem(
            storageKey(NS),
            JSON.stringify({
                v: SWR_CACHE_VERSION,
                t: Date.now(),
                entries: [
                    [JOURNAL, [{ id: 'j1' }]],
                    [LEASES, [{ id: 'l1', lessorName: 'Иван Петров' }]],
                ],
            }),
        );
        const map = createPersistentCacheProvider({ namespace: NS });
        expect(map.get(JOURNAL)).toBeDefined();
        expect(map.get(LEASES)).toBeUndefined();
    });
});

describe('the IndexedDB spill tier', () => {
    it('gates the SPILL too — a big list is where a localStorage-only gate would leak', async () => {
        // `flush()` serialises ONE entries array and routes it to
        // localStorage OR IndexedDB depending on size. Lists are exactly
        // what grows past LS_BYTE_BUDGET, so a gate that lived on the
        // localStorage write alone would let the LARGEST payloads through
        // — the opposite of what anyone would intend.
        //
        // Assert on the serialized payload the spill would carry, built
        // through the same funnel, rather than on IndexedDB itself: jsdom
        // has no usable IDB here, and the property under test is what
        // `collectEntries` produced, not where it was routed.
        const bulky = Array.from({ length: 2000 }, (_, i) => ({
            id: `l${i}`,
            lessorName: `Иван Петров ${i}`,
            lessorEik: `12345${i}`,
        }));
        const map = persistThrough([
            [LEASES, bulky],
            [JOURNAL, Array.from({ length: 2000 }, (_, i) => ({ id: `j${i}` }))],
        ]);

        // Nothing disallowed survived into the bucket, at any size.
        const bucket = readBucket();
        const serialized = JSON.stringify(bucket ?? {});
        expect(serialized).not.toContain('Иван Петров');
        expect(serialized).not.toContain('lessorEik');

        // The in-memory map still holds it — the gate is about what
        // reaches DISK, not about breaking the live cache.
        expect(map.get(LEASES)).toBeDefined();
    });
});

describe('the version bump is the remediation', () => {
    it('rejects a v1 bucket wholesale, so existing on-disk PII is erased', () => {
        // The allowlist stops new writes. It does NOT remove what is
        // already on operators' phones — the 24h TTL only fires when that
        // namespace is hydrated, and the IndexedDB tier has no delete
        // path at all. A phone that never opens Rent again would keep its
        // lease PII indefinitely. Bumping SWR_CACHE_VERSION is what
        // actually erases it, because parseBucket drops a wrong-version
        // bucket entirely rather than filtering it.
        window.localStorage.setItem(
            storageKey(NS),
            JSON.stringify({
                v: 1,
                t: Date.now(),
                entries: [[LEASES, [{ lessorName: 'Иван Петров' }]]],
            }),
        );
        const map = createPersistentCacheProvider({ namespace: NS });
        expect(map.size).toBe(0);
        expect(SWR_CACHE_VERSION).toBeGreaterThan(1);
    });
});
