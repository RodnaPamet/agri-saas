/**
 * Guard — the pure-re-export barrel exclusion stays honest.
 *
 * `jest.config.js` drops a small list of barrel files from
 * `collectCoverageFrom`. The justification is narrow: TypeScript compiles
 * `export { X } from './m'` into
 *
 *     Object.defineProperty(exports, 'X', { get: function () { return m_1.X; } })
 *
 * and istanbul counts each getter as a FUNCTION. A barrel with no logic
 * therefore contributes permanently-uncovered "functions" that exist only
 * in emitted JavaScript — there is nothing in the source to test.
 *
 * That justification evaporates the moment a barrel grows real code. This
 * guard fails CI if any excluded file contains an executable construct, so
 * the exclusion cannot quietly become a place to hide untested logic.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** The exclusion list as Jest actually sees it — not a re-typed copy. */
function excludedBarrels(): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(path.join(ROOT, 'jest.config.js'));
    const projects: Array<{ collectCoverageFrom?: string[] }> =
        config.projects ?? [];
    const patterns = new Set<string>();
    for (const p of projects) {
        for (const entry of p.collectCoverageFrom ?? []) {
            if (entry.startsWith('!') && entry.endsWith('index.ts')) {
                patterns.add(entry.slice(1));
            }
        }
    }
    return [...patterns].sort();
}

/**
 * Strip comments before scanning. Without this, prose in a barrel's
 * docblock ("...return the typed facade...") would read as executable
 * code and the guard would fire on its own documentation.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const EXECUTABLE = /(^|\s)(const|let|var|function|class|if|return|switch|for|while)\s|=>/;

function executableLines(src: string): string[] {
    return stripComments(src)
        .split('\n')
        .filter((l) => EXECUTABLE.test(l));
}

describe('Guard: pure-re-export barrel coverage exclusion', () => {
    const barrels = excludedBarrels();

    it('excludes at least one barrel (the list did not silently empty)', () => {
        expect(barrels.length).toBeGreaterThan(0);
    });

    it.each(barrels)('%s exists on disk', (rel) => {
        // A stale path excludes nothing and hides a rename.
        expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    });

    it.each(barrels)('%s contains no executable code', (rel) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const offenders = executableLines(src);
        expect(offenders).toEqual([]);
    });

    it('detects a barrel that grows real logic', () => {
        // Regression proof for the detector itself: without this, a
        // broken regex would pass every file above and the guard would
        // be decorative.
        const withLogic = `
            export { Foo } from './foo';
            export const helper = (n: number) => n + 1;
        `;
        expect(executableLines(withLogic)).not.toEqual([]);
    });

    it('does not mistake documentation prose for code', () => {
        // The failure this actually prevents: a docblock containing a
        // word like "return" tripping the scan.
        const proseOnly = `
            /**
             * Module entry. Consumers should return to the typed facade
             * rather than importing internals. For each widget, if you
             * need the class, import it directly.
             */
            export { Foo } from './foo';
            export type { Bar } from './bar';
        `;
        expect(executableLines(proseOnly)).toEqual([]);
    });
});
