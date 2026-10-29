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

import { blankNonCode } from '../helpers/blank-non-code';
import { assertAllowlistIsLive } from '../helpers/assert-allowlist-is-live';

const ROOTS = [
    path.resolve(__dirname, '../../src'),
    path.resolve(__dirname, '../../tests'),
];

// Files / paths that are allowed to reference the string
// "CompactFilterBar" in comments or docstrings. No runtime code
// should import from a deleted module — this allowlist is for
// historical notes only.
const ALLOWLIST = [
    // Filter-foundation tests include historical "compat bridge" describe
    // blocks asserting the `fromCompactFilterState` / `toCompactFilterState`
    // round-trip still works. The utility function names (and therefore
    // the string) are kept for backwards-compat with stored URL params.
    //
    // `tests/unit/practices-filter-defs.test.ts` stood here too until #2377.
    // It was deleted in eba5cf890 (#547, the GRC teardown), so the exemption
    // had been exempting nothing for months.
    'tests/unit/filter-foundation.test.ts',
    // This guard file itself.
    'tests/guardrails/no-compact-filter-bar.test.ts',
    // Standardisation test documents the removed legacy stack — `it.each`
    // titles like '%s does not import CompactFilterBar' put the string in a
    // STRING LITERAL, which survives `blankNonCode`. That is why it is live
    // and the two removed below were not.
    'tests/unit/filter-standardization.test.ts',
];

/**
 * TWO ENTRIES WERE REMOVED HERE, AND THEY WERE DEAD THE SECOND WAY — #2414.
 *
 *     'src/components/ui/filter/filter-state.ts'   // 1 occurrence, in a docblock
 *     'tests/e2e/filters.spec.ts'                  // 1 occurrence, in a docblock
 *
 * Both files exist, so #2377's existence check passed them. Neither matches
 * the ban below, because the ban reads `blankNonCode(src)` and their only
 * occurrence is inside a comment. They exempted nothing, and read as
 * "known, accepted violation" over clean files.
 *
 * The rationale is what gives the class away: the comment above this list
 * said these files were allowed to reference the string **"in comments or
 * docstrings"**. For a guard that blanks comments before matching, that
 * sentence describes a file which cannot violate — so the exemption was
 * never needed. Any guard blanking comments can be screened the same way, by
 * grepping its own reasons for "comment"/"docstring"/"historical", before
 * reading a single file.
 */

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
    // ── Controls (#971) ──────────────────────────────────────────────
    // `walk` survived being gutted: no files means no CompactFilterBar
    // references means a pass. `relFromRepo` survived `undefined` — it only
    // shapes the violation message, so it is not a hole, but the message IS
    // the remedy instruction, so it earns a cheap assertion rather than a
    // baseline entry.
    it('control: walk finds the trees this guard scans, and relFromRepo names them', () => {
        const files = walk(path.resolve(__dirname, '../../src'), []);
        expect(files.length).toBeGreaterThan(200);
        expect(files.every((f) => path.isAbsolute(f))).toBe(true);
        const rel = relFromRepo(files[0]);
        expect(typeof rel).toBe('string');
        expect(rel.length).toBeGreaterThan(0);
        expect(path.isAbsolute(rel)).toBe(false);
    });

    it('no source or test file mentions CompactFilterBar outside the allowlist', () => {
        const offenders: string[] = [];
        for (const root of ROOTS) {
            for (const file of walk(root, [])) {
                const rel = relFromRepo(file);
                if (ALLOWLIST.includes(rel)) continue;
                const src = blankNonCode(fs.readFileSync(file, 'utf-8'));
                if (src.includes('CompactFilterBar')) {
                    offenders.push(rel);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every exemption is LIVE — present and still matching the ban (#2414)', () => {
        // Strictly stronger than "the file exists", which is what #2377's
        // generic scan can ask. The helper applies THIS guard's own ban —
        // supplied below, not inferred — so it separates the two ways an
        // exemption dies: gone, and irrelevant.
        //
        // `blankOptions` is deliberately `{}`, matching the ban above:
        // comments blanked, STRING LITERALS KEPT. Turning `strings` on would
        // reclassify `filter-standardization.test.ts` as irrelevant and invite
        // its deletion, after which the guard would stop covering a file that
        // really does name the banned component in its `it.each` titles.
        const report = assertAllowlistIsLive({
            label: 'no-compact-filter-bar ALLOWLIST',
            entries: ALLOWLIST,
            blankOptions: {},
            violates: (code) => code.includes('CompactFilterBar'),
        });
        // The denominator, printed: a gate that cannot say how many entries it
        // checked cannot say what it covers.
        console.log(
            `[no-compact-filter-bar] ${report.live.length} of ${ALLOWLIST.length} exemption(s) live`,
        );
        expect(report.live).toHaveLength(ALLOWLIST.length);
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
