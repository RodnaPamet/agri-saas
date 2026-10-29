/**
 * `assertAllowlistIsLive` separates the two ways an exemption dies — #2414.
 *
 * The helper is shared infrastructure: once guards delete their own existence
 * checks in favour of it, a hole here is a hole in every adopter at once. So
 * its classification is pinned against a real temporary tree rather than
 * mocks, including the two cases that make it more than an existence check.
 *
 * Written because an extracted helper is a new seam
 * (`a-seam-is-a-new-collector`): the first adopter proves it runs, not that it
 * discriminates.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { assertAllowlistIsLive } from '../helpers/assert-allowlist-is-live';

const NEEDLE = 'BannedThing';
const violates = (code: string) => code.includes(NEEDLE);

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'allowlist-liveness-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
};

describe('assertAllowlistIsLive (#2414)', () => {
    it('passes when every entry still matches the ban', () => {
        write('a.ts', `const x = '${NEEDLE}';\n`);
        write('b.ts', `function f() { return ${NEEDLE}; }\n`);
        const report = assertAllowlistIsLive({
            label: 'test',
            entries: ['a.ts', 'b.ts'],
            violates,
            repoRoot: root,
        });
        expect(report.live).toEqual(['a.ts', 'b.ts']);
        expect(report.irrelevant).toEqual([]);
        expect(report.missing).toEqual([]);
    });

    it('fails an IRRELEVANT entry — present, but no longer matching', () => {
        // THE CASE AN EXISTENCE CHECK CANNOT SEE. The file is right there.
        write('live.ts', `const x = '${NEEDLE}';\n`);
        write('clean.ts', 'const y = 1;\n');
        expect(() =>
            assertAllowlistIsLive({
                label: 'test',
                entries: ['live.ts', 'clean.ts'],
                violates,
                repoRoot: root,
            }),
        ).toThrow(/IRRELEVANT \(1\): clean\.ts/);
    });

    it('fails a GONE entry, so it subsumes the existence check', () => {
        // Stated in the helper's docblock as the reason an adopter need not
        // keep both. If this ever stopped holding, guards would delete their
        // existence check and lose the class.
        expect(() =>
            assertAllowlistIsLive({
                label: 'test',
                entries: ['nope.ts'],
                violates,
                repoRoot: root,
            }),
        ).toThrow(/GONE \(1\): nope\.ts/);
    });

    it('refuses to judge a directory rather than guessing', () => {
        mkdirSync(join(root, 'somedir'), { recursive: true });
        expect(() =>
            assertAllowlistIsLive({
                label: 'test',
                entries: ['somedir'],
                violates,
                repoRoot: root,
            }),
        ).toThrow(/NOT A FILE \(1\): somedir/);
    });

    it('a comment-only occurrence is IRRELEVANT, because comments are blanked', () => {
        // The measured shape from the first adopter: both dead entries there
        // had their single occurrence inside a docblock. This is the unit-level
        // statement of it.
        write('doc.ts', `/** mentions ${NEEDLE} in prose only */\nconst z = 1;\n`);
        expect(() =>
            assertAllowlistIsLive({
                label: 'test',
                entries: ['doc.ts'],
                violates,
                repoRoot: root,
            }),
        ).toThrow(/IRRELEVANT/);
    });

    it('honours blankOptions, so the caller decides about string literals', () => {
        // Load-bearing. With `strings` off (the default, and what
        // no-compact-filter-bar uses) a banned name inside a test title is a
        // LIVE match. Turn it on and the same file is reclassified irrelevant
        // and invites deletion — after which the guard silently stops covering
        // it. The helper must not choose this for the guard.
        write('title.ts', `it('does not import ${NEEDLE}', () => {});\n`);

        const withStrings = assertAllowlistIsLive({
            label: 'test',
            entries: ['title.ts'],
            violates,
            repoRoot: root,
        });
        expect(withStrings.live).toEqual(['title.ts']);

        expect(() =>
            assertAllowlistIsLive({
                label: 'test',
                entries: ['title.ts'],
                violates,
                blankOptions: { strings: true },
                repoRoot: root,
            }),
        ).toThrow(/IRRELEVANT/);
    });

    it('the failure names the guard and the live/total counts', () => {
        // A shared helper's throw must say WHOSE list, or the adopter's
        // failure arrives with no owner.
        write('clean.ts', 'const y = 1;\n');
        expect(() =>
            assertAllowlistIsLive({
                label: 'my-guard ALLOWLIST',
                entries: ['clean.ts'],
                violates,
                repoRoot: root,
            }),
        ).toThrow(/my-guard ALLOWLIST: 0 of 1 exemption\(s\) are live/);
    });

    it('an empty list passes vacuously, and says so by returning zeroes', () => {
        // Deliberate: a fully-cleaned allowlist is the goal state, not a
        // failure. The adopter is what asserts a non-empty population if it
        // expects one — `no-compact-filter-bar` compares live against its own
        // length, so an emptied ALLOWLIST there fails its own assertion rather
        // than passing here.
        const report = assertAllowlistIsLive({
            label: 'test',
            entries: [],
            violates,
            repoRoot: root,
        });
        expect(report).toEqual({ live: [], irrelevant: [], missing: [], notAFile: [] });
    });
});
