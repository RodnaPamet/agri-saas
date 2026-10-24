/**
 * `vendor-fonts.mjs` names the axis that moved — #2200.
 *
 * ## The defect this covers
 *
 * The verify arm compared `JSON.stringify(lock.faces)` against the whole
 * computed array and, on any difference, printed:
 *
 *     That is a FONT PROGRAM change, not a formatting one. Re-run with
 *     --write-lock ONLY after re-running the metric capture in …
 *
 * Measured on main: that verdict was printed for **18 `unicode-range`
 * descriptor diffs and ZERO byte diffs**, every vendored file byte-identical
 * to what was locked and metric-captured. The failure was not the exit code —
 * it was a verdict asserting a cause it had never checked, sending the reader
 * to re-run an expensive metric capture for a change that cannot move a
 * metric, while being the only thing standing between the next person and a
 * `--write-lock` that would quietly adopt those ranges.
 *
 * So the thing worth testing is the MAPPING from diff to verdict, not just the
 * diff. `verdictFor` exists as a pure function for that reason: a test cannot
 * reach a message that lives inside a function which fetches from Google
 * first.
 *
 * ## Spawned, because jest's `node` project is CJS
 *
 * It cannot import an `.mjs` at all. Each case runs a one-line ESM program in
 * a child process, hands it fixtures as JSON on argv, and reads a JSON result
 * back. The same reason `tests/guards/verify-changed-rules-resolve.test.ts`
 * reads its rules as data.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/fonts/vendor-fonts.mjs');

type Face = {
    file: string;
    family: string;
    subset: string;
    style: string;
    weight: number;
    unicodeRange: string;
    bytes: number;
    sha256: string;
};

/** Run one exported function in a child, with JSON in and JSON out. */
function callExport(fn: string, args: unknown[]): any {
    const program = `
        const m = await import(${JSON.stringify(SCRIPT)});
        const args = JSON.parse(process.argv[1]);
        process.stdout.write(JSON.stringify(m[${JSON.stringify(fn)}](...args)));
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', program, JSON.stringify(args)], {
        encoding: 'utf8',
    });
    if (r.status !== 0) {
        throw new Error(`child exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
}

const classify = (locked: Face[], computed: Face[]) => callExport('classifyLockDiff', [locked, computed]);
const verdict = (locked: Face[], computed: Face[]) =>
    callExport('verdictFor', [classify(locked, computed)]);

function face(over: Partial<Face> = {}): Face {
    return {
        file: 'inter-latin.woff2',
        family: 'Inter',
        subset: 'latin',
        style: 'normal',
        weight: 400,
        unicodeRange: 'U+0000-00FF, U+20AD-20C0, U+2113',
        bytes: 20156,
        sha256: 'a'.repeat(64),
        ...over,
    };
}

/**
 * SIX faces sharing ONE file, which is the real shape: 72 faces resolve to 17
 * files because a group whose weights all point at one URL is one variable
 * file.
 */
const variableGroup = (): Face[] =>
    [300, 400, 500, 600, 700, 800].map((weight) => face({ weight }));

describe('vendor-fonts verdict (#2200)', () => {
    it('identical lists are clean, and the verdict is ok', () => {
        // The positive control. If this failed, every "only X moved"
        // assertion below would be meaningless.
        const d = classify([face()], [face()]);
        expect(d.clean).toBe(true);
        expect(verdict([face()], [face()]).kind).toBe('ok');
    });

    it('SIX faces sharing one file, unchanged, are clean', () => {
        // The bug my first implementation had, and the reason this fixture
        // exists: keying the join on `file` compared each face against an
        // arbitrary sibling with the same filename and reported
        // `weight 700 -> 500` across sixteen faces that had not changed. A
        // fixture with one face per file cannot express it.
        const g = variableGroup();
        const d = classify(g, g.map((f) => ({ ...f })));
        expect(d).toMatchObject({ clean: true, identity: [], program: [], descriptor: [] });
    });

    it('a widened unicode-range is DESCRIPTORS ONLY, never a program change', () => {
        // The exact case from the issue: U+20AD-20C0 -> U+20AD-20C4, same
        // bytes, same hash.
        const locked = variableGroup();
        const computed = locked.map((f) => ({
            ...f,
            unicodeRange: f.unicodeRange.replace('U+20AD-20C0', 'U+20AD-20C4'),
        }));
        const d = classify(locked, computed);
        expect(d.program).toEqual([]);
        expect(d.identity).toEqual([]);
        expect(d.descriptor).toHaveLength(6);

        const v = verdict(locked, computed);
        expect(v.kind).toBe('descriptor');
        expect(v.message).toContain('DESCRIPTORS ONLY');
        expect(v.message).toContain('byte-identical');
        // The sentence the old arm got wrong must NOT appear.
        expect(v.message).not.toContain('FONT PROGRAM');
        // And it must tell the reader to skip the expensive thing.
        expect(v.message).toContain('do NOT re-run the metric capture');
        expect(v.message).toContain('--accept-descriptors');
    });

    it('changed bytes ARE a program change, and that message owes the capture', () => {
        const locked = [face()];
        const computed = [face({ sha256: 'b'.repeat(64), bytes: 20200 })];
        const d = classify(locked, computed);
        expect(d.program).toHaveLength(2); // sha256 and bytes
        expect(d.descriptor).toEqual([]);

        const v = verdict(locked, computed);
        expect(v.kind).toBe('program');
        expect(v.message).toContain('FONT PROGRAM');
        expect(v.message).toContain('metric capture');
        expect(v.message).toContain('--write-lock');
    });

    it('when BOTH moved, the program headlines and the descriptors are counted', () => {
        // A program change must never be hidden behind a descriptor story, and
        // the descriptors must not vanish from the report either.
        const locked = [face()];
        const computed = [face({ sha256: 'c'.repeat(64), unicodeRange: 'U+0000-00FF' })];
        const v = verdict(locked, computed);
        expect(v.kind).toBe('program');
        expect(v.message).toContain('FONT PROGRAM');
        expect(v.message).toContain('descriptor diff(s) are also present');
    });

    it('a face that appeared or vanished is an IDENTITY change', () => {
        const locked = [face()];
        const computed = [face(), face({ weight: 900 })];
        const v = verdict(locked, computed);
        expect(v.kind).toBe('identity');
        expect(v.message).toContain('Inter latin normal 900');
        expect(v.message).toContain('metric capture cannot answer this');
    });

    it('the same face moved to a different FILE is an identity change', () => {
        // A variable group split into per-weight files, or the reverse. The
        // face is the same; what it is served from is not.
        const locked = [face()];
        const computed = [face({ file: 'inter-latin-400.woff2' })];
        const d = classify(locked, computed);
        expect(d.identity).toEqual([
            {
                file: 'Inter latin normal 400',
                field: 'file',
                was: 'inter-latin.woff2',
                now: 'inter-latin-400.woff2',
            },
        ]);
        expect(verdict(locked, computed).kind).toBe('identity');
    });

    it('a pure reordering is reported as ORDER, not as clean', () => {
        // The lock's sort is part of what --write-lock freezes, so the same
        // faces in a different sequence is a real difference — and one that
        // would otherwise hide inside "nothing else moved".
        const a = face({ file: 'a.woff2', subset: 'latin' });
        const b = face({ file: 'b.woff2', subset: 'cyrillic' });
        const d = classify([a, b], [b, a]);
        expect(d.orderChanged).toBe(true);
        expect(d.clean).toBe(false);
        expect(d.program).toEqual([]);
        expect(verdict([a, b], [b, a]).kind).toBe('order');
    });

    it('the diff window shows the change, not the first 88 characters', () => {
        // Measured: a unicode-range descriptor is ~400 characters and Google's
        // widening sits at the end, so a head-truncated `was:`/`now:` pair
        // printed identical text and the reader learned nothing.
        const long = `${'U+0100-02BA, '.repeat(20)}U+20AD-20C0, U+2113`;
        const out = callExport('windowDiff', [long, long.replace('20C0', '20C4'), 12]);
        expect(out.was).not.toBe(out.now);
        expect(out.was).toContain('20C0');
        expect(out.now).toContain('20C4');
        // And it is a window, not the whole string.
        expect(out.was.length).toBeLessThan(long.length);
    });

    it('importing the module does NOT run the vendoring', () => {
        // The guard that makes everything above possible. Measured while
        // adding it: a bare `await import()` of this file ran `main()`, hit
        // Google's css2 endpoint and printed a mismatch — which makes the pure
        // functions untestable and an accidental import expensive and
        // network-dependent.
        const r = spawnSync(
            'node',
            [
                '--input-type=module',
                '-e',
                `const m = await import(${JSON.stringify(SCRIPT)});
                 process.stdout.write(Object.keys(m).sort().join(','));`,
            ],
            { encoding: 'utf8' },
        );
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('classifyLockDiff');
        expect(r.stdout).toContain('verdictFor');
        // No vendoring output, and no verdict, because main() never ran.
        expect(r.stdout).not.toContain('[fonts]');
        expect(`${r.stdout}${r.stderr}`).not.toContain('MISMATCH');
    });
});
