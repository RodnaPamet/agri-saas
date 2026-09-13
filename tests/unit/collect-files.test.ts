/**
 * The collection helper must REFUSE an empty result (#865).
 *
 * This is the guarantee 37 hand-rolled `walk` copies did not have. It is
 * asserted by EXECUTING the helper rather than by mutating a guard, because
 * once a guard delegates here there is no module-level collector left in it for
 * `scripts/selector-teeth.mjs` to gut — the proof moves to this file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectSourceFiles, collectTrackedFiles, REPO_ROOT } from '../helpers/collect-files';

describe('collectSourceFiles', () => {
    it('collects the real tree and returns a non-trivial population', () => {
        // The control. Every refusal below is only meaningful if the happy path
        // genuinely finds files on the tree the guards actually scan.
        const files = collectSourceFiles({ roots: ['src/lib/offline'] });
        expect(files.length).toBeGreaterThan(5);
        expect(files.every((f) => path.isAbsolute(f))).toBe(true);
    });

    it('THROWS when the walk returns nothing, even though the root exists', () => {
        // The defect #875's pass did not close: 35 of the 47 dead guards already
        // threw on a MISSING root and stayed dead, because a root that resolves
        // says nothing about whether the walk found anything.
        expect(() =>
            collectSourceFiles({ roots: ['src/lib/offline'], extensions: ['.no-such-extension'] }),
        ).toThrow(/collected 0 file\(s\), expected at least 1/);
    });

    it('THROWS when an exclude predicate eats the whole population', () => {
        expect(() =>
            collectSourceFiles({ roots: ['src/lib/offline'], exclude: () => true }),
        ).toThrow(/expected at least 1/);
    });

    it('THROWS when a root does not resolve, naming it', () => {
        expect(() => collectSourceFiles({ roots: ['src/no-such-dir'] })).toThrow(
            /scan root does not exist: src\/no-such-dir/,
        );
    });

    it('enforces a floor above 1 when the caller knows its population', () => {
        expect(() => collectSourceFiles({ roots: ['src/lib/offline'], floor: 100000 })).toThrow(
            /expected at least 100000/,
        );
    });

    it('allows an intentionally empty result ONLY with a stated reason', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-files-'));
        try {
            expect(
                collectSourceFiles({
                    roots: [dir],
                    floor: 0,
                    expectEmptyBecause: 'the fixture directory is deliberately empty',
                }),
            ).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('REFUSES floor 0 without a reason, so a silent selector cannot hide behind it', () => {
        // Without this, `floor: 0` would be the escape hatch that reintroduces
        // the whole defect — an empty selection passing, one indirection away.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-files-'));
        try {
            expect(() => collectSourceFiles({ roots: [dir], floor: 0 })).toThrow(
                /floor 0 needs expectEmptyBecause/,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips node_modules by default', () => {
        const files = collectSourceFiles({ roots: ['src'] });
        expect(files.some((f) => f.includes(`${path.sep}node_modules${path.sep}`))).toBe(false);
    });
});

describe('collectTrackedFiles', () => {
    it('collects from the index and returns a non-trivial population', () => {
        const files = collectTrackedFiles({ roots: ['src/lib/offline'], extensions: ['.ts'] });
        expect(files.length).toBeGreaterThan(5);
    });

    it('THROWS on a path git does not know, which it reports as empty with exit 0', () => {
        // The sharper half: `git ls-files <missing>` succeeds and prints nothing,
        // so there is no error to notice — only the floor catches it.
        expect(() => collectTrackedFiles({ roots: ['src/no-such-dir'] })).toThrow(
            /collected 0 file\(s\)/,
        );
    });

    it('CONTROL: git ls-files really does exit 0 on a missing path', () => {
        // Otherwise the assertion above could be passing because the command
        // failed, which is a different fact with a different fix.
        const { execFileSync } = require('child_process') as typeof import('child_process');
        const out = execFileSync('git', ['ls-files', '-z', '--', 'src/no-such-dir'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        expect(out).toBe('');
    });
});
