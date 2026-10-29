/**
 * The cache key fingerprints the PROJECTION when one is given (#2406).
 *
 * The key carries the tenant, the filters and a version counter. The counter
 * is INCR'd by writes; a DEPLOY bumps nothing. So a changed `select` was
 * previously indistinguishable from an unchanged one, and a payload built by
 * the old shape was served to new code for the rest of the TTL — which is how
 * `mayDelete` came to deny everyone for a minute after #2395 shipped.
 *
 * Two properties, and the second is what makes this adoptable:
 *
 *   - a DIFFERENT projection is a different key, including a change nested
 *     inside a relation's own `select`;
 *   - NO projection leaves the key byte-identical to what it was, so the six
 *     call sites that have not adopted this are not invalidated and need no
 *     coordinated deploy.
 */
const store = new Map<string, string>();
const seenKeys: string[] = [];

const redisDouble = {
    get: jest.fn(async (k: string) => {
        seenKeys.push(k);
        return store.get(k) ?? null;
    }),
    set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
    }),
    incr: jest.fn(async () => 1),
    del: jest.fn(async () => 1),
};

jest.mock('@/lib/redis', () => ({
    __esModule: true,
    getRedis: () => redisDouble,
}));

import { cachedListRead } from '@/lib/cache/list-cache';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 't1', userId: 'u1' } as unknown as RequestContext;

/** The data key this call read — the version key is the other `get`. */
async function keyFor(projection?: unknown): Promise<string> {
    seenKeys.length = 0;
    await cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        params: { status: 'OPEN' },
        ...(projection === undefined ? {} : { projection }),
        loader: async () => [{ id: 'x' }],
    });
    const data = seenKeys.filter((k) => !k.includes(':ver:'));
    expect(data).toHaveLength(1);
    return data[0];
}

beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    seenKeys.length = 0;
});

describe('the projection fingerprint (#2406)', () => {
    it('no projection → no suffix, so existing entries stay reachable', async () => {
        // The backward-compatibility property. If this changed, adopting the
        // option anywhere would invalidate every cached list everywhere.
        const k = await keyFor();
        expect(k).toBe('inflect:cache:v1:task:list:t1:v0:' + k.split(':').pop());
        expect(k).not.toMatch(/:p[0-9a-f]+$/);
    });

    it('a projection adds a suffix', async () => {
        const k = await keyFor({ id: true, title: true });
        expect(k).toMatch(/:p[0-9a-f]{12}$/);
    });

    it('a DIFFERENT projection is a different key', async () => {
        // The whole point: the old shape's payload is unreachable from the new
        // shape's key.
        const before = await keyFor({ id: true, title: true });
        const after = await keyFor({ id: true, title: true, createdByUserId: true });
        expect(after).not.toBe(before);
    });

    it('the same projection written in a different ORDER is the same key', async () => {
        // Otherwise a harmless reformat of the select would invalidate the
        // cache, and the fingerprint would be about typing rather than shape.
        const a = await keyFor({ id: true, title: true, status: true });
        const b = await keyFor({ status: true, id: true, title: true });
        expect(b).toBe(a);
    });

    it('a change NESTED inside a relation select changes the key', async () => {
        // The case a shallow `Object.keys` hash would miss, and the reason
        // this reuses `stableStringify` rather than listing top-level keys:
        // `assignee: { select: { id } }` → `{ id, name }` is a real shape
        // change that a client can see.
        const a = await keyFor({ id: true, assignee: { select: { id: true } } });
        const b = await keyFor({ id: true, assignee: { select: { id: true, name: true } } });
        expect(b).not.toBe(a);
    });

    it('removing a field changes the key too, not just adding one', async () => {
        // Both directions. A projection that SHRANK is just as unservable
        // from an older payload — the new code may read fewer fields, but a
        // decorator computing from a removed one is the same defect.
        const wide = await keyFor({ id: true, title: true, status: true });
        const narrow = await keyFor({ id: true, title: true });
        expect(narrow).not.toBe(wide);
    });

    it('the suffix is the only thing that differs — the rest of the key is intact', async () => {
        const plain = await keyFor();
        const fingerprinted = await keyFor({ id: true });
        expect(fingerprinted.startsWith(plain)).toBe(true);
        expect(fingerprinted.slice(plain.length)).toMatch(/^:p[0-9a-f]{12}$/);
    });
});
