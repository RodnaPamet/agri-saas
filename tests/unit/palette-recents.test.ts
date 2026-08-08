/**
 * Pure tests for the command-palette recents model.
 *
 * Covers FIFO + dedupe + cap + per-tenant key + load-defence
 * (older blob versions, garbage data, missing fields). The
 * palette wires these via `useLocalStorage`; the React layer
 * isn't tested here.
 */

import {
    MAX_RECENTS,
    RECENTS_STORAGE_PREFIX,
    addRecent,
    loadRecents,
    recentFromHit,
    recentsStorageKey,
    serializeRecents,
    type RecentItem,
} from '@/lib/palette/recents';
import type { SearchHit } from '@/lib/search/types';

function makeItem(
    id: string,
    type: RecentItem['type'] = 'control',
    overrides: Partial<RecentItem> = {},
): RecentItem {
    return {
        type,
        id,
        title: `Item ${id}`,
        href: `/x/${id}`,
        iconKey: 'shield-check',
        lastVisitedAt: 0,
        ...overrides,
    };
}

describe('recentsStorageKey', () => {
    it('uses the documented prefix and the tenant slug', () => {
        const key = recentsStorageKey('acme-corp');
        expect(key.startsWith(RECENTS_STORAGE_PREFIX)).toBe(true);
        expect(key).toContain('acme-corp');
    });

    it('produces distinct keys for distinct slugs', () => {
        expect(recentsStorageKey('a')).not.toBe(recentsStorageKey('b'));
    });
});

describe('addRecent — FIFO + dedupe + cap', () => {
    it('prepends a new item to the head', () => {
        const list = [makeItem('a')];
        const out = addRecent(list, makeItem('b'), 1234);
        expect(out.map((r) => r.id)).toEqual(['b', 'a']);
        expect(out[0].lastVisitedAt).toBe(1234);
    });

    it('moves an existing (type, id) pair to the head and updates timestamp', () => {
        const list = [
            makeItem('a', 'control', { lastVisitedAt: 100 }),
            makeItem('b', 'control', { lastVisitedAt: 200 }),
        ];
        const out = addRecent(list, makeItem('a'), 999);
        expect(out.map((r) => r.id)).toEqual(['a', 'b']);
        expect(out[0].lastVisitedAt).toBe(999);
        expect(out).toHaveLength(2); // dedupe — no duplicate "a"
    });

    it('treats a different type with the same id as a separate entry', () => {
        const list = [makeItem('a', 'control')];
        const out = addRecent(list, makeItem('a', 'policy'));
        expect(out).toHaveLength(2);
    });

    it('caps at MAX_RECENTS and drops the oldest', () => {
        const list = Array.from({ length: MAX_RECENTS }, (_, i) =>
            makeItem(`r-${i}`, 'control', { lastVisitedAt: i }),
        );
        const out = addRecent(list, makeItem('new'));
        expect(out).toHaveLength(MAX_RECENTS);
        expect(out[0].id).toBe('new');
        expect(out[out.length - 1].id).toBe(`r-${MAX_RECENTS - 2}`);
    });

    it('does not mutate the input array', () => {
        const list = [makeItem('a')];
        const before = JSON.stringify(list);
        addRecent(list, makeItem('b'));
        expect(JSON.stringify(list)).toBe(before);
    });
});

describe('recentFromHit — adapter shape', () => {
    it('lifts the bare-essentials shape from a SearchHit', () => {
        const hit: SearchHit = {
            type: 'asset',
            id: 'r1',
            title: 'Phishing exposure',
            subtitle: 'tech',
            badge: 'OPEN',
            href: '/t/x/risks/r1',
            score: 99,
            iconKey: 'alert-triangle',
            category: 'Assets',
        };
        expect(recentFromHit(hit)).toEqual({
            type: 'asset',
            id: 'r1',
            title: 'Phishing exposure',
            href: '/t/x/risks/r1',
            iconKey: 'alert-triangle',
        });
    });
});

describe('loadRecents — defensive load', () => {
    function blob(items: RecentItem[]) {
        return { version: 1, items };
    }

    it('returns [] for null / undefined / non-objects', () => {
        expect(loadRecents(null)).toEqual([]);
        expect(loadRecents(undefined)).toEqual([]);
        expect(loadRecents('oops')).toEqual([]);
        expect(loadRecents(42)).toEqual([]);
    });

    it('returns [] when the version is missing or not 1', () => {
        expect(loadRecents({ items: [makeItem('a')] })).toEqual([]);
        expect(loadRecents({ version: 2, items: [makeItem('a')] })).toEqual([]);
    });

    it('returns [] when items is not an array', () => {
        expect(loadRecents({ version: 1, items: 'oops' })).toEqual([]);
    });

    it('drops items missing required fields', () => {
        const out = loadRecents({
            version: 1,
            items: [
                makeItem('a'),
                { type: 'control', id: 'b' }, // missing title/href/iconKey/lastVisitedAt
                makeItem('c'),
            ],
        });
        expect(out.map((r) => r.id)).toEqual(['a', 'c']);
    });

    it('drops items with unknown type or iconKey', () => {
        const out = loadRecents({
            version: 1,
            items: [
                { ...makeItem('bad'), type: 'unknown-kind' as 'control' },
                makeItem('good'),
            ],
        });
        expect(out.map((r) => r.id)).toEqual(['good']);
    });

    it('rejects non-tenant-scoped href shapes (must start with /)', () => {
        const out = loadRecents({
            version: 1,
            items: [
                { ...makeItem('absolute'), href: 'https://evil.example/' },
                makeItem('good'),
            ],
        });
        expect(out.map((r) => r.id)).toEqual(['good']);
    });

    it('caps load at MAX_RECENTS even when blob has more', () => {
        const items = Array.from({ length: MAX_RECENTS + 5 }, (_, i) => makeItem(`r-${i}`));
        const out = loadRecents(blob(items));
        expect(out).toHaveLength(MAX_RECENTS);
    });
});

describe('serializeRecents — wire shape', () => {
    it('emits a versioned blob with the items', () => {
        const items = [makeItem('a'), makeItem('b')];
        const out = serializeRecents(items);
        expect(out).toEqual({ version: 1, items });
    });

    it('caps the serialised payload to MAX_RECENTS', () => {
        const items = Array.from({ length: MAX_RECENTS + 3 }, (_, i) => makeItem(`r-${i}`));
        const out = serializeRecents(items);
        expect(out.items).toHaveLength(MAX_RECENTS);
    });

    it('round-trips through loadRecents', () => {
        const items = [makeItem('a'), makeItem('b', 'policy')];
        const restored = loadRecents(serializeRecents(items));
        expect(restored).toEqual(items);
    });
});
