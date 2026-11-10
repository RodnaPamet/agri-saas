/**
 * Nothing that MEASURES may read the simplified track — #2948 stage 3.
 *
 * ## The defect this exists for
 *
 * `simplifyTrack` returns a PICTURE of a path: points along a straight run are
 * dropped because a screen cannot show them. Measuring a picture produces a
 * confident wrong number — a worked area or a duration short by however much
 * was simplified away — and that is worse than a crash, because somebody puts
 * it in a subsidy return. The iOS session asked for the rule explicitly:
 * "the worked-parcel derivation and anything else that measures must use RAW
 * positions, never the simplified track."
 *
 * A rule in a docblock is held by nobody, which is why this file exists.
 *
 * ## ITS POPULATION IS ZERO TODAY, and it is built for that
 *
 * The derivation and the retention sweep are stage 4; the paths below do not
 * exist yet. So this guard is in the same position as
 * `social-routes-flag-gated`, whose population is empty until P2 — and it
 * takes the same three precautions:
 *
 *   1. it PRINTS its denominator, so "0 violations" can be told apart from
 *      "0 files examined";
 *   2. it proves its detector against SYNTHETIC sources, which is the only
 *      mutation proof available before a real consumer exists;
 *   3. it asserts the measuring roots are DECLARED, so a derivation landing
 *      at an undeclared path costs a visible line here rather than a silent
 *      exclusion from the population.
 *
 * ## Why the matcher is coarse, deliberately
 *
 * It bans the MODULE, not a particular call. `notice-score-is-shadow-only`
 * makes the same choice for the same reason: a rule about one function passes
 * a wrapper, and a rule about wrappers passes a re-export. Importing this
 * module from a measuring path is never right, so there is nothing to permit.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = join(__dirname, '..', '..');

/** The module no measuring code may reach. */
const FORBIDDEN = /from\s+['"](?:@\/lib\/machines\/track-simplify|\.{1,2}\/[^'"]*track-simplify)['"]/;

/**
 * Paths whose job is to MEASURE. Declared rather than inferred: a guard that
 * guessed which files measure would be wrong in both directions, and the
 * declaration is the auditable record of what is covered.
 *
 * Each entry is a path PREFIX, relative to the repo root. Entries are allowed
 * not to exist yet — stage 4 creates them — and the test below says how many
 * of each so an empty population is visible rather than silent.
 */
const MEASURING_ROOTS = [
    // The nightly worked-parcel derivation and the 30-day retention sweep.
    'src/app-layer/jobs/worked-parcel-derivation.ts',
    'src/app-layer/jobs/machine-position-sweep.ts',
    // Anything computing a figure about machines.
    'src/app-layer/usecases/worked-parcels.ts',
    'src/lib/machines/worked-parcel-match.ts',
] as const;

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(full)) out.push(full);
    }
    return out;
}

/** Every declared measuring file that currently EXISTS. */
function measuringFiles(): string[] {
    const out: string[] = [];
    for (const rel of MEASURING_ROOTS) {
        const full = join(ROOT, rel);
        if (!existsSync(full)) continue;
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

describe('the simplified track is DISPLAY ONLY (#2948)', () => {
    const files = measuringFiles();

    it('prints the denominator, so an empty population is visible', () => {
        // Deliberately NOT a floor. The population is zero until stage 4 and
        // failing on zero would make this guard red on the day it is written —
        // which is how a guard gets deleted. The reading is what makes the
        // zero legible, and §3 below is what keeps the roots honest.
        console.log(
            `[track-display-only] ${MEASURING_ROOTS.length} declared measuring root(s); ` +
                `${files.length} file(s) present and scanned; ` +
                `${files.length === 0 ? 'population EMPTY — stage 4 has not landed' : 'population live'}`,
        );
        expect(MEASURING_ROOTS.length).toBeGreaterThan(0);
    });

    it('no measuring file imports the simplifier', () => {
        const offenders = files.filter((f) =>
            FORBIDDEN.test(blankNonCode(readFileSync(f, 'utf8'))),
        );
        expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
    });

    describe('the detector works — the only proof available before a consumer exists', () => {
        it('catches an alias import', () => {
            expect(FORBIDDEN.test("import { simplifyTrack } from '@/lib/machines/track-simplify';")).toBe(true);
        });

        it('catches a relative import', () => {
            expect(FORBIDDEN.test("import { simplifyTrack } from './track-simplify';")).toBe(true);
            expect(FORBIDDEN.test("import x from '../machines/track-simplify';")).toBe(true);
        });

        it('catches a type-only import, which still couples the measurement to the picture', () => {
            expect(FORBIDDEN.test("import type { SimplifyResult } from '@/lib/machines/track-simplify';")).toBe(true);
        });

        it('does NOT fire on an unrelated module with a similar name', () => {
            expect(FORBIDDEN.test("import { x } from '@/lib/machines/track-reader';")).toBe(false);
            expect(FORBIDDEN.test("import { x } from '@/lib/machines/codec8';")).toBe(false);
        });

        it('does NOT fire on a COMMENT explaining why it is not imported', () => {
            // A measuring file should be able to say "deliberately not using
            // track-simplify" without being reported for it.
            const src = `
                // Reads RAW positions. Deliberately does not import
                // @/lib/machines/track-simplify — see that module's docblock.
                import { listPositions } from '@/app-layer/repositories/machines';
            `;
            expect(FORBIDDEN.test(blankNonCode(src))).toBe(false);
        });
    });

    it('every declared root is either a real path or a path stage 4 will create', () => {
        // The weak half, stated as weak: nothing can verify a path that does
        // not exist yet. What it DOES check is shape — an entry that is not a
        // repo-relative `.ts` path under `src/` is a typo that would silently
        // never match anything.
        for (const rel of MEASURING_ROOTS) {
            expect(rel).toMatch(/^src\/[\w\-/]+\.ts$/);
        }
    });
});
