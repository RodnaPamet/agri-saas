/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Epic 53 — filter presets contract.
 *
 * Tests the localStorage-backed CRUD layer. Uses an inline
 * `MemoryStorage` stub so the pure-node jest project can exercise
 * the real module without a browser.
 */

import {
    listPresets,
    savePreset,
    deletePreset,
    renamePreset,
    clearPresets,
    PRESET_LIMITS,
} from '@/lib/filters/filter-presets';

class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length() { return this.store.size; }
    clear() { this.store.clear(); }
    getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
    key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
    removeItem(key: string) { this.store.delete(key); }
    setItem(key: string, value: string) { this.store.set(key, value); }
}

const TENANT = 'acme';
const PAGE = 'risks';

beforeEach(() => {
    const storage = new MemoryStorage();
    (globalThis as any).window = { localStorage: storage };
});

afterEach(() => {
    delete (globalThis as any).window;
});

describe('filter-presets — list/save/delete', () => {
    it('returns an empty array when nothing is stored', () => {
        expect(listPresets(TENANT, PAGE)).toEqual([]);
    });

    it('saves a preset and reads it back', () => {
        const saved = savePreset({
            tenantSlug: TENANT,
            page: PAGE,
            name: 'My open risks',
            state: { status: ['OPEN', 'MITIGATING'], owner: ['me'] },
        });
        expect(saved.id).toBeTruthy();
        expect(saved.name).toBe('My open risks');
        expect(saved.state).toEqual({
            status: ['OPEN', 'MITIGATING'],
            owner: ['me'],
        });
        expect(saved.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);

        const list = listPresets(TENANT, PAGE);
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(saved);
    });

    it('prepends new presets so the dropdown shows most-recent first', () => {
        const first = savePreset({ tenantSlug: TENANT, page: PAGE, name: 'First', state: {} });
        const second = savePreset({ tenantSlug: TENANT, page: PAGE, name: 'Second', state: {} });
        const list = listPresets(TENANT, PAGE);
        expect(list.map((p) => p.id)).toEqual([second.id, first.id]);
    });

    it('caps the stored list at MAX_PRESETS_PER_PAGE, dropping the oldest', () => {
        for (let i = 0; i < PRESET_LIMITS.MAX_PRESETS_PER_PAGE + 3; i++) {
            savePreset({ tenantSlug: TENANT, page: PAGE, name: `p${i}`, state: {} });
        }
        const list = listPresets(TENANT, PAGE);
        expect(list).toHaveLength(PRESET_LIMITS.MAX_PRESETS_PER_PAGE);
        // The three oldest (p0, p1, p2) must have been dropped.
        const names = list.map((p) => p.name);
        expect(names).not.toContain('p0');
        expect(names).not.toContain('p1');
        expect(names).not.toContain('p2');
    });

    it('isolates presets per tenant + page', () => {
        savePreset({ tenantSlug: 'acme', page: 'risks', name: 'A', state: {} });
        savePreset({ tenantSlug: 'beta', page: 'risks', name: 'B', state: {} });
        savePreset({ tenantSlug: 'acme', page: 'practices', name: 'C', state: {} });

        expect(listPresets('acme', 'risks').map((p) => p.name)).toEqual(['A']);
        expect(listPresets('beta', 'risks').map((p) => p.name)).toEqual(['B']);
        expect(listPresets('acme', 'practices').map((p) => p.name)).toEqual(['C']);
    });

    it('deletePreset is idempotent', () => {
        const saved = savePreset({ tenantSlug: TENANT, page: PAGE, name: 'X', state: {} });
        deletePreset(TENANT, PAGE, saved.id);
        deletePreset(TENANT, PAGE, saved.id);
        deletePreset(TENANT, PAGE, 'never-existed');
        expect(listPresets(TENANT, PAGE)).toEqual([]);
    });

    it('renamePreset updates the name in place and returns the record', () => {
        const saved = savePreset({ tenantSlug: TENANT, page: PAGE, name: 'Old', state: {} });
        const updated = renamePreset(TENANT, PAGE, saved.id, 'New');
        expect(updated?.name).toBe('New');
        const list = listPresets(TENANT, PAGE);
        expect(list[0].name).toBe('New');
        expect(list[0].id).toBe(saved.id);
    });

    it('renamePreset returns null when the id is missing', () => {
        expect(renamePreset(TENANT, PAGE, 'nope', 'Whatever')).toBeNull();
    });

    it('clearPresets removes every entry for the page', () => {
        savePreset({ tenantSlug: TENANT, page: PAGE, name: 'A', state: {} });
        savePreset({ tenantSlug: TENANT, page: PAGE, name: 'B', state: {} });
        clearPresets(TENANT, PAGE);
        expect(listPresets(TENANT, PAGE)).toEqual([]);
    });
});

describe('filter-presets — validation + sanitisation', () => {
    it('trims the name and truncates to MAX_NAME_LENGTH', () => {
        const long = 'x'.repeat(PRESET_LIMITS.MAX_NAME_LENGTH + 20);
        const saved = savePreset({ tenantSlug: TENANT, page: PAGE, name: `  ${long}  `, state: {} });
        expect(saved.name).toHaveLength(PRESET_LIMITS.MAX_NAME_LENGTH);
        expect(saved.name.startsWith('x')).toBe(true);
    });

    it('rejects empty / whitespace-only names', () => {
        expect(() =>
            savePreset({ tenantSlug: TENANT, page: PAGE, name: '   ', state: {} }),
        ).toThrow(/name is required/i);
        expect(() => renamePreset(TENANT, PAGE, 'any', '')).toThrow(
            /name is required/i,
        );
    });

    it('drops non-string and empty values when sanitising state', () => {
        const saved = savePreset({
            tenantSlug: TENANT,
            page: PAGE,
            name: 'Clean',

            state: { status: ['OPEN', '', null as any, 42 as any], foo: 'bar' as any },
        });
        expect(saved.state).toEqual({ status: ['OPEN'] });
    });

    it('survives corrupt localStorage payloads', () => {
        const storage = (globalThis as any).window.localStorage as Storage;
        storage.setItem(`inflect:filters:${TENANT}:${PAGE}`, '{not valid json');
        expect(listPresets(TENANT, PAGE)).toEqual([]);

        storage.setItem(`inflect:filters:${TENANT}:${PAGE}`, '"just a string"');
        expect(listPresets(TENANT, PAGE)).toEqual([]);

        storage.setItem(
            `inflect:filters:${TENANT}:${PAGE}`,
            JSON.stringify([{ id: '', name: 'X', state: {}, createdAt: '' }]),
        );
        expect(listPresets(TENANT, PAGE)).toEqual([]);
    });
});

describe('filter-presets — SSR / no-window safety', () => {
    beforeEach(() => {
        delete (globalThis as any).window;
    });

    it('listPresets returns empty when window is unavailable', () => {
        expect(listPresets(TENANT, PAGE)).toEqual([]);
    });

    it('savePreset does not throw in a non-browser context', () => {
        expect(() =>
            savePreset({ tenantSlug: TENANT, page: PAGE, name: 'n', state: {} }),
        ).not.toThrow();
    });

    it('clearPresets is a no-op when window is unavailable', () => {
        expect(() => clearPresets(TENANT, PAGE)).not.toThrow();
    });
});
