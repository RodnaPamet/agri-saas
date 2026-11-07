/**
 * The declared extension set is non-empty and the drill reads it — #2661.
 *
 * `deploy/postgres/Dockerfile`'s package list is a CLAIM about what a restore
 * needs, and nothing checked it. #974 moved off expired bullseye and installed
 * the two packages the product uses explicitly — correctly — and with that
 * silently stopped supplying `postgis_tiger_geocoder`, which the old
 * `postgis/postgis` base had bundled. The repo's database image then could not
 * restore the production backup for FIVE WEEKS with every check green, because
 * the only thing reading the package set against production's real catalogue is
 * the monthly drill.
 *
 * `deploy/postgres/required-extensions` is now that expectation, measured from
 * production rather than inferred from the Dockerfile — the Dockerfile installs
 * two packages and the cluster carries seven extensions, and that gap IS the
 * defect.
 *
 * This guard holds the two things a source-text check can hold: the declaration
 * is non-empty, and the drill still reads it. It deliberately does NOT assert
 * the set's CONTENTS — the drill compares against the restored cluster, which
 * is the only place the package list and the catalogue meet, and duplicating
 * the expected names here would be a second copy to drift.
 */

import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from '../helpers/collect-files';

const DECL = path.join(REPO_ROOT, 'deploy', 'postgres', 'required-extensions');
const DRILL = path.join(REPO_ROOT, 'infra', 'scripts', 'restore-test-dump.sh');

/** The same stripping the drill does, so the two cannot disagree. */
function declared(text: string): string[] {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('the required-extensions declaration is usable', () => {
    const text = fs.readFileSync(DECL, 'utf8');
    const names = declared(text);

    it('[required-extensions] prints the denominator', () => {
        // A floor rather than a print alone: an empty declaration would make
        // the drill's comparison assert nothing, which is the shape this whole
        // issue is about.
        expect(names.length).toBeGreaterThanOrEqual(5);
        console.log(`[required-extensions] ${names.length} declared: ${names.join(', ')}`);
    });

    it('every line is a plausible extension name', () => {
        // Catches a stray comment marker, a version suffix, or a pasted psql
        // table border — any of which would make the drill look for an
        // extension that cannot exist and fail a good restore.
        for (const n of names) {
            expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
        }
    });

    it('carries postgis_tiger_geocoder, the one that went missing', () => {
        // Pinned by NAME because #2652 is the reason this file exists, and a
        // future tidy-up that drops it must be a deliberate act with #2662's
        // production change behind it — not a silent edit.
        expect(names).toContain('postgis_tiger_geocoder');
    });

    it('the drill reads this file and dies when it cannot', () => {
        const drill = fs.readFileSync(DRILL, 'utf8');
        expect(drill).toContain('required-extensions');
        // The unreadable branch must FAIL, not warn: a missing expectation
        // reading as a pass is the defect one level up.
        expect(drill).toMatch(/is unreadable; the extension assertion cannot run/);
        // And the missing-extension branch must die rather than say.
        expect(drill).toMatch(/MISSING declared extension/);
    });

    it('detects a declaration that strips to nothing', () => {
        // The detector's own proof: the real file is fine, so without this the
        // floor above would pass whether or not the stripper works.
        expect(declared('# only a comment\n\n   \n')).toEqual([]);
        expect(declared('postgis\n# comment\n  vector  \n')).toEqual(['postgis', 'vector']);
    });
});
