/**
 * The per-person stream cap — P7.2 (#1991), hardened against P7.10 (#1999).
 *
 * #1999's criterion for this is "10k connect/abort cycles leave 0
 * subscribers". That is a statement about RELEASE, and the cycle case below
 * asserts the same property at a size a unit test can run — the number is not
 * the point, a slot surviving its stream is.
 */
const store = new Map<string, number>();
const mockRedis = {
    set: jest.fn(async (k: string) => {
        store.set(k, 1);
        return 'OK';
    }),
    del: jest.fn(async (k: string) => {
        store.delete(k);
        return 1;
    }),
    expire: jest.fn(async () => 1),
    scan: jest.fn(async (_c: string, _m: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return ['0', [...store.keys()].filter((k) => re.test(k))] as [string, string[]];
    }),
};
let redisAvailable = true;
jest.mock('@/lib/redis', () => ({ getRedis: () => (redisAvailable ? mockRedis : null) }));

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) },
}));

import {
    acquireStreamSlot,
    MAX_STREAMS_PER_USER,
    SLOT_TTL_SECONDS,
} from '@/lib/realtime/stream-slots';

beforeEach(() => {
    store.clear();
    redisAvailable = true;
    for (const m of Object.values(mockRedis)) (m as jest.Mock).mockClear();
    warn.mockClear();
    info.mockClear();
});

describe('the cap', () => {
    it('admits up to the maximum', async () => {
        for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
            const r = await acquireStreamSlot('u1', `s${i}`);
            expect(r.ok).toBe(true);
        }
        expect(store.size).toBe(MAX_STREAMS_PER_USER);
    });

    it('REFUSES the one after, rather than evicting', async () => {
        for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
            await acquireStreamSlot('u1', `s${i}`);
        }
        const r = await acquireStreamSlot('u1', 's-extra');

        expect(r.ok).toBe(false);
        // Eviction would have made room. The existing slots must survive —
        // `EventSource` reconnects on close, so evicting would make the
        // closed tab reconnect and evict another.
        expect(store.size).toBe(MAX_STREAMS_PER_USER);
        expect(info).toHaveBeenCalledWith('sse.at_capacity', expect.objectContaining({ held: 3 }));
    });

    it('counts per PERSON, not globally', async () => {
        // The control: one person at capacity must not refuse a different
        // person, and the cap must not be a deployment-wide limit of three.
        for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
            await acquireStreamSlot('u1', `s${i}`);
        }
        expect((await acquireStreamSlot('u2', 'x')).ok).toBe(true);
    });

    it('the KEY carries the person and nothing else — which is what makes the cap per person', async () => {
        // This case exists because the previous one CANNOT fail for the defect
        // it most needs to catch. The first version of this module keyed slots
        // on `(tenantId, userId)`, so three streams were allowed per
        // MEMBERSHIP and somebody in three farms held nine. Having removed the
        // tenant from the signature, no argument this test can pass expresses
        // "same person, other farm" — so the per-person property is no longer
        // observable through the interface, and asserting it through the
        // interface would be a control that cannot produce the failing input.
        //
        // The key is where the property now lives, so the key is what is
        // asserted. If a tenant term ever returns, the pattern stops matching
        // one person's slots wherever they came from and this fails.
        await acquireStreamSlot('user-abc', 'stream-1');

        const keys = [...store.keys()];
        expect(keys).toEqual(['sse:slot:user-abc:stream-1']);
        // Specifically: the person and the stream, in that order, with no
        // third segment between the prefix and the user.
        expect(keys[0].split(':').slice(0, 3)).toEqual(['sse', 'slot', 'user-abc']);
    });

    it('frees a slot on release, so the next stream is admitted', async () => {
        const first = await acquireStreamSlot('u1', 's0');
        await acquireStreamSlot('u1', 's1');
        await acquireStreamSlot('u1', 's2');
        expect((await acquireStreamSlot('u1', 's3')).ok).toBe(false);

        if (first.ok) await first.slot.release();

        expect((await acquireStreamSlot('u1', 's3')).ok).toBe(true);
    });

    it('leaves ZERO slots after many connect/abort cycles — #1999', async () => {
        // The hardening criterion, scaled to a unit test. A slot that outlived
        // its stream would accumulate here and the count would climb.
        for (let i = 0; i < 500; i++) {
            const r = await acquireStreamSlot('u1', `cycle-${i}`);
            expect(r.ok).toBe(true);
            if (r.ok) await r.slot.release();
        }
        expect(store.size).toBe(0);
    });

    it('sets a TTL, which is what survives a process that cannot clean up', async () => {
        await acquireStreamSlot('u1', 's0');
        // The TTL is the only mechanism that releases a slot held by a crashed
        // pod. Asserted on the call, because nothing else in the system can
        // recover that state.
        expect(mockRedis.set).toHaveBeenCalledWith(
            expect.stringContaining('sse:slot:u1:s0'),
            '1',
            'EX',
            SLOT_TTL_SECONDS,
        );
    });

    it('refreshes the TTL rather than rewriting the key', async () => {
        const r = await acquireStreamSlot('u1', 's0');
        if (r.ok) await r.slot.refresh();
        expect(mockRedis.expire).toHaveBeenCalledWith(
            expect.stringContaining('sse:slot:u1:s0'),
            SLOT_TTL_SECONDS,
        );
    });

    it('uses SCAN, never KEYS', () => {
        // KEYS is O(n) over the whole keyspace and blocks the server, and this
        // runs on every stream open. Asserted structurally because the mock
        // would answer either.
        const src = require('node:fs').readFileSync('src/lib/realtime/stream-slots.ts', 'utf8');
        expect(src).toContain('scan');
        expect(src).not.toMatch(/\.keys\s*\(/);
    });
});

describe('without Redis', () => {
    it('admits everyone rather than refusing what it cannot count', async () => {
        // The cap is a resource bound, not a security control. A developer's
        // machine or a self-hosted install with no Redis should get working
        // streams, not a refusal it cannot diagnose.
        redisAvailable = false;
        for (let i = 0; i < MAX_STREAMS_PER_USER + 5; i++) {
            expect((await acquireStreamSlot('u1', `s${i}`)).ok).toBe(true);
        }
    });

    it('survives Redis throwing, and says so once', async () => {
        redisAvailable = true;
        mockRedis.scan.mockRejectedValueOnce(new Error('ECONNRESET'));
        const r = await acquireStreamSlot('u1', 's0');
        expect(r.ok).toBe(true);
        expect(warn).toHaveBeenCalledWith(
            'sse.slot_acquire_failed',
            expect.objectContaining({ component: 'realtime' }),
        );
    });
});
