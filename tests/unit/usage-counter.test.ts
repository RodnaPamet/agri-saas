/**
 * The usage counter's BOUNDS, which are the whole design.
 *
 * This writes into a `noeviction` Redis that BullMQ shares. An unbounded field
 * set there does not degrade a dashboard - it fills the instance, and a full
 * `noeviction` Redis fails WRITES, which means job enqueues stop. So every axis
 * being bounded is a correctness property rather than tidiness, and each bound
 * is asserted separately because they fail for different reasons.
 */
import {
    normaliseClient,
    normaliseDevice,
    usageSurface,
    usageField,
    parseUsageField,
    usageBucketKey,
    usageBucketKeys,
    USAGE_WINDOW_DAYS,
} from '@/lib/observability/usage-counter';

describe('client normalisation - a bounded enum, never a rejection', () => {
    it.each([
        ['ios/1.0', 'ios/1.0'],
        ['ios/0.1', 'ios/0.1'],
        ['web/3.70', 'web/3.70'],
        ['android/12.345', 'android/12.345'],
        ['  ios/1.0  ', 'ios/1.0'],
    ])('accepts %p as %p', (input, expected) => {
        expect(normaliseClient(input)).toBe(expected);
    });

    it('absent is `unknown`, and an EMPTY value counts as absent too', () => {
        expect(normaliseClient(null)).toBe('unknown');
        expect(normaliseClient(undefined)).toBe('unknown');
        // `''` is deliberately `unknown` rather than `other`. It is strictly
        // "present but empty", which by the present-vs-absent rule argues for
        // `other` - but HTTP stacks disagree about whether a missing header reads
        // as null or '', and a proxy that normalises one to the other would
        // relabel ALL absent traffic as malformed. Conflating them loses the
        // ability to spot a client sending a blank header; the alternative
        // corrupts the main signal, which is the worse trade.
        expect(normaliseClient('')).toBe('unknown');
        expect(normaliseClient('   ')).toBe('other'); // whitespace IS a value
    });

    it.each([
        ['ios/1.0.3'],
        ['ios/1.0+481'],
        ['iOS/1.0'],
        ['ios/1'],
        ['ios/1234.0'],
        ['curl/8.0'],
        ['ios/1.0; drop'],
    ])('buckets %p as `other` rather than minting a field', (input) => {
        expect(normaliseClient(input)).toBe('other');
    });

    it('an over-long header cannot become a field', () => {
        // The cardinality attack: a client sending a unique 10KB header on every
        // request must not create one field per request.
        expect(normaliseClient('ios/' + '9'.repeat(5000))).toBe('other');
        expect(normaliseClient('a'.repeat(5000) + '/1.0')).toBe('other');
    });

    it('NOTE: the length cap is a CPU guard, and this suite cannot prove it', () => {
        // Found by mutation: deleting MAX_CLIENT_HEADER_BYTES fails NOTHING here.
        // Both inputs above are already rejected without it - the first has no
        // `.` so the grammar misses, the second matches the grammar but fails the
        // platform allowlist. So for the RETURN VALUE the cap is redundant, and a
        // test asserting the return value cannot distinguish its presence.
        //
        // It is kept deliberately: without it a 10KB header is regex-matched on
        // every request, which is a cost rather than a wrong answer. That is not
        // observable from the output, so it is recorded here instead of being
        // dressed up as an assertion - a test that passes with the code deleted
        // is worse than no test, because it reads as cover.
        expect(normaliseClient('a'.repeat(40) + '/1.0')).toBe('other');
    });

    it('NEVER throws - a telemetry header must not be able to fail a request', () => {
        for (const v of [null, undefined, '', ' ', 'a'.repeat(100), ' bad']) {
            expect(() => normaliseClient(v as string)).not.toThrow();
        }
    });
});

describe('device normalisation - exactly three values', () => {
    it('maps the client hint', () => {
        expect(normaliseDevice('?1')).toBe('mobile');
        expect(normaliseDevice('?0')).toBe('desktop');
    });

    it('anything else is `unknown`, which is expected to be COMMON', () => {
        // Safari and curl send no hint at all, so `unknown` is the normal case
        // for a large share of real traffic rather than an error path.
        for (const v of [null, undefined, '', '1', 'true', '?2', 'mobile']) {
            expect(normaliseDevice(v as string)).toBe('unknown');
        }
    });
});

describe('surface derivation - the primary cardinality bound', () => {
    it.each([
        ['/api/t/:tenantSlug/journal', 'journal'],
        ['/api/t/:tenantSlug/journal/:id', 'journal'],
        ['/api/t/:tenantSlug/journal/:id/comments', 'journal'],
        ['/api/auth/me', 'auth'],
        ['/api/t/:tenantSlug/exchange/listings/:id', 'exchange'],
        ['/api/readyz', 'readyz'],
    ])('%p collapses to %p', (route, surface) => {
        expect(usageSurface(route)).toBe(surface);
    });

    it('collapses a whole route family to ONE field', () => {
        // The point of surfaces over route templates: four fields under a
        // per-route scheme, one under this one, both answering the same question
        // - "do people use the journal".
        const family = [
            '/api/t/:tenantSlug/journal',
            '/api/t/:tenantSlug/journal/:id',
            '/api/t/:tenantSlug/journal/:id/comments',
            '/api/t/:tenantSlug/journal/export',
        ].map(usageSurface);
        expect(new Set(family).size).toBe(1);
    });

    it.each([
        ['/api/t/:tenantSlug/WeIrD_Caps', 'other'],
        ['/api/t/:tenantSlug/' + 'x'.repeat(50), 'other'],
        ['/completely/off/pattern', 'other'],
    ])('buckets %p as `other` - a weird path cannot mint a field', (route, expected) => {
        expect(usageSurface(route)).toBe(expected);
    });

    it('an id that escaped normalisation still cannot become a surface', () => {
        // Defence in depth: if normalizeRoute ever missed an id, this shape check
        // is what stops one field per entity.
        expect(usageSurface('/api/t/:tenantSlug/550e8400-e29b-41d4-a716-446655440000')).toBe('other');
    });
});

describe('field encoding round-trips, so a reader can group by any axis', () => {
    it('encodes and parses back', () => {
        const f = usageField('ios/1.0', 'mobile', 'get', 'journal');
        expect(f).toBe('ios/1.0|mobile|GET journal');
        expect(parseUsageField(f)).toEqual({
            client: 'ios/1.0',
            device: 'mobile',
            method: 'GET',
            route: 'journal',
        });
    });

    it('survives a client token containing a slash - it leads, so splitting is unambiguous', () => {
        const parsed = parseUsageField(usageField('web/3.70', 'desktop', 'post', 'exchange'));
        expect(parsed?.client).toBe('web/3.70');
        expect(parsed?.route).toBe('exchange');
    });

    it('rejects a field that is not ours rather than returning a half-parse', () => {
        for (const bad of ['', 'nopipes', 'one|only', '|a|b c']) {
            expect(parseUsageField(bad)).toBeNull();
        }
    });
});

describe('buckets are daily, and cover the window P10 needs', () => {
    it('keys by UTC day', () => {
        expect(usageBucketKey(new Date('2026-10-01T23:59:59.999Z'))).toBe('api:usage:v1:2026-10-01');
        expect(usageBucketKey(new Date('2026-10-02T00:00:00.000Z'))).toBe('api:usage:v1:2026-10-02');
    });

    it('30 days is 30 keys, not 720', () => {
        // Why daily rather than hourly: the consumer is a 30-day window and the
        // hour is not an axis anyone will group by.
        const keys = usageBucketKeys(USAGE_WINDOW_DAYS, new Date('2026-10-30T12:00:00Z'));
        expect(keys).toHaveLength(30);
        expect(new Set(keys).size).toBe(30);
        expect(keys[0]).toBe('api:usage:v1:2026-10-30');
        expect(keys[29]).toBe('api:usage:v1:2026-10-01');
    });
});

describe('no field can carry anything identifying', () => {
    it('the worst-case field set is small enough to reason about', () => {
        // Not a hand-wave: the three axes are enumerable, so their product is
        // too. The field cap is the backstop for a mistake in this reasoning.
        const clients = ['ios/1.0', 'web/3.70', 'other', 'unknown'];
        const devices = ['mobile', 'desktop', 'unknown'];
        const surfaces = ['journal', 'exchange', 'auth', 'other'];
        const methods = ['GET', 'POST'];
        const fields = new Set<string>();
        for (const c of clients) {
            for (const d of devices) {
                for (const s of surfaces) {
                    for (const m of methods) {
                        fields.add(usageField(c, d, m, s));
                    }
                }
            }
        }
        expect(fields.size).toBe(
            clients.length * devices.length * surfaces.length * methods.length,
        );
        for (const f of fields) {
            expect(f).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/); // no IPv4
            expect(f).not.toMatch(/[?&]/); // no query string
            expect(f).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i); // no uuid
        }
    });
});
