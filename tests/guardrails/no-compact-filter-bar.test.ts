/**
 * Epic 53 — legacy CompactFilterBar removal ratchet.
 *
 * The `CompactFilterBar` component was deleted in the Epic 53
 * finishing pass. This guardrail keeps it gone by forbidding the
 * string from reappearing in any `.ts/.tsx` file under `src/` and
 * `tests/`, with a small allowlist for the compat-bridge utility
 * docstrings in `filter-state.ts` and the "compat bridge" test
 * describe blocks that document the historical shape of the stored
 * URL params.
 *
 * If you need to re-introduce CompactFilterBar for a legitimate
 * reason, extend the allowlist with a recorded justification.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOTS = [
    path.resolve(__dirname, '../../src'),
    path.resolve(__dirname, '../../tests'),
];

// Files / paths that are allowed to reference the string
// "CompactFilterBar" in comments or docstrings. No runtime code
// should import from a deleted module — this allowlist is for
// historical notes only.
const ALLOWLIST = [
    // Compat-bridge utility docs — describe the legacy flat-state shape.
    'src/components/ui/filter/filter-state.ts',
    // Filter-defs tests include historical "compat bridge" describe blocks
    // asserting the `fromCompactFilterState` / `toCompactFilterState`
    // round-trip still works. The utility function names (and therefore
    // the string) are kept for backwards-compat with stored URL params.
    'tests/unit/practices-filter-defs.test.ts',
    'tests/unit/filter-foundation.test.ts',
    // This guard file itself.
    'tests/guardrails/no-compact-filter-bar.test.ts',
    // Standardisation test documents the removed legacy stack.
    'tests/unit/filter-standardization.test.ts',
    // E2E specs keep historical references in docstrings / explanatory
    // comments about the pre-Epic 53 filter bar and its DOM ids.
    'tests/e2e/filters.spec.ts',
    'tests/e2e/data-table-platform.spec.ts',
];

function walk(dir: string, out: string[]): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, out);
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function relFromRepo(abs: string): string {
    return path.relative(path.resolve(__dirname, '../..'), abs);
}

describe('Epic 53 — no CompactFilterBar references', () => {
    it('no source or test file mentions CompactFilterBar outside the allowlist', () => {
        const offenders: string[] = [];
        for (const root of ROOTS) {
            for (const file of walk(root, [])) {
                const rel = relFromRepo(file);
                if (ALLOWLIST.includes(rel)) continue;
                const src = fs.readFileSync(file, 'utf-8');
                if (src.includes('CompactFilterBar')) {
                    offenders.push(rel);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the deleted component file is actually gone', () => {
        const deleted = path.resolve(
            __dirname,
            '../../src/components/filters/CompactFilterBar.tsx',
        );
        expect(fs.existsSync(deleted)).toBe(false);
    });

    it('the deleted configs file is actually gone', () => {
        const deleted = path.resolve(
            __dirname,
            '../../src/components/filters/configs.ts',
        );
        expect(fs.existsSync(deleted)).toBe(false);
    });
});
