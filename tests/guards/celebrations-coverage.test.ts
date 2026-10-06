/**
 * Celebrations registry integrity (feat/delight-celebrations).
 *
 * Locks the contract between the MilestoneKey union, the MILESTONES registry,
 * the ag achievements order, and — since P2.6 — the `celebrations.*` copy in
 * BOTH message catalogues, so a renamed/missing milestone fails CI instead of
 * silently shipping a celebration with no copy.
 *
 * The copy half is the one that needs saying. `MILESTONE_COPY` in the hook is
 * an exhaustive `Record<MilestoneKey, …>`, so TypeScript catches a milestone
 * with no RESOLVER — but it cannot see whether the key that resolver names
 * exists in `messages/*.json`. next-intl has no `getMessageFallback`
 * configured here, so a missing key renders its own path as the toast title.
 * `tests/guards/i18n-key-exists.test.ts` would catch that too; this test
 * states the direction that matters locally (every milestone has copy in
 * BOTH locales) and is where you land when you add one.
 */
import * as fs from 'fs';
import * as path from 'path';

import { MILESTONES, AG_MILESTONE_ORDER, type MilestoneKey } from '@/lib/celebrations';
import { MILESTONE_COPY } from '@/components/ui/hooks/use-celebration';

const VALID_PRESETS = ['burst', 'rain', 'fireworks'];
const ROOT = path.resolve(__dirname, '../..');

function loadCelebrationCopy(locale: string): Record<string, { message?: string; description?: string }> {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'));
    return json.celebrations ?? {};
}

describe('celebrations registry coverage', () => {
    it('every MILESTONES record key matches its definition.key', () => {
        for (const [k, def] of Object.entries(MILESTONES)) {
            expect(def.key).toBe(k);
        }
    });

    it('every milestone has a glyph + a valid preset', () => {
        for (const def of Object.values(MILESTONES)) {
            expect(def.glyph.trim().length).toBeGreaterThan(0);
            expect(VALID_PRESETS).toContain(def.preset);
        }
    });

    it('the four ag milestones are registered + ordered', () => {
        expect(AG_MILESTONE_ORDER).toHaveLength(4);
        for (const key of AG_MILESTONE_ORDER) {
            expect(MILESTONES[key as MilestoneKey]).toBeDefined();
        }
        // No duplicates in the order list.
        expect(new Set(AG_MILESTONE_ORDER).size).toBe(AG_MILESTONE_ORDER.length);
    });

    it('every milestone has a copy resolver', () => {
        expect(Object.keys(MILESTONE_COPY).sort()).toEqual(Object.keys(MILESTONES).sort());
    });

    describe.each(['bg', 'en'])('messages/%s.json carries the copy', (locale) => {
        const copy = loadCelebrationCopy(locale);

        it('has a non-empty message + description for every milestone', () => {
            // The resolvers name keys relative to the `celebrations` namespace
            // ("firstHarvest.message"), so the namespace segment is what this
            // asserts against. A resolver reaching for a key the catalogue
            // lacks would render `celebrations.firstHarvest.message` verbatim.
            const resolved = Object.values(MILESTONE_COPY).map((r) =>
                r((k) => k).message.replace(/\.message$/, ''),
            );
            expect(resolved).toHaveLength(Object.keys(MILESTONES).length);
            for (const ns of resolved) {
                expect(copy[ns]).toBeDefined();
                expect((copy[ns]?.message ?? '').trim().length).toBeGreaterThan(0);
                expect((copy[ns]?.description ?? '').trim().length).toBeGreaterThan(0);
            }
        });

        it('carries no copy for a milestone that no longer exists', () => {
            // GRC teardown phase 2 and P2.6 each deleted milestones. An
            // orphaned `celebrations.auditPackComplete` would be invisible to
            // the parity guards (both locales would have it) and to
            // i18n-key-exists (nothing calls it), so it is asserted here.
            const expected = new Set(
                Object.values(MILESTONE_COPY).map((r) => r((k) => k).message.replace(/\.message$/, '')),
            );
            expect(Object.keys(copy).filter((k) => !expected.has(k))).toEqual([]);
        });
    });

    it('no milestone definition carries inline copy', () => {
        // The shape P2.6 replaced. Re-adding `message:` to a record would
        // ship an English toast to a Bulgarian farmer, and `src/lib` is
        // outside the hard-coded-string ratchet's scan roots, so nothing
        // else would say so.
        for (const def of Object.values(MILESTONES)) {
            expect(Object.keys(def).sort()).toEqual(['glyph', 'key', 'preset']);
        }
    });
});
