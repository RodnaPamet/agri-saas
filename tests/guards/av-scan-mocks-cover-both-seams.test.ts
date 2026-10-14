/**
 * A suite that mocks the scanner must mock the seam the code actually reads.
 *
 * `jest.mock('@/lib/storage/av-scan', …)` in this repo spreads
 * `jest.requireActual` and overrides one or two functions. That spread is
 * what makes a missing override DANGEROUS rather than merely wrong: the
 * module still exports a working function, so nothing throws, nothing is
 * undefined, and the suite quietly exercises the REAL scanner while every
 * `mockScanVerdict.mockResolvedValue(...)` in it has no effect.
 *
 * Measured when #1811 pointed `scanOrRefuse` at `scanUploadedBufferDetailed`:
 * `account-avatar.test.ts` kept passing four assertions that had stopped
 * testing anything, and only failed because the real function returned a
 * different verdict than the one the test had set. Had the real verdict
 * happened to agree, they would have passed while proving nothing — which is
 * the usual shape of this class and the reason for a guard rather than a
 * fixed-once edit.
 *
 * There are two shapes and they fail differently. A factory that spreads
 * `requireActual` and misses one override is SILENT — the real function is
 * still exported. A factory that replaces the module outright leaves the
 * missing seam `undefined`, which throws "is not a function" the moment
 * anything reads it: wrong, but loud. This guard covers both, because the
 * cheap fix is the same and the silent shape is the one worth preventing.
 *
 * So: override one of the pair, override both.
 */
import fs from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const AV_MODULE = '@/lib/storage/av-scan';
const SEAMS = ['scanUploadedBuffer', 'scanUploadedBufferDetailed'] as const;

/**
 * Which seams a file overrides inside its `av-scan` mock factory.
 *
 * Takes source text so the controls below can hand it a synthetic factory.
 * Comments are blanked first: several of these files DISCUSS the pair in
 * prose, and this guard exists because of a quiet miss, so reporting a
 * comment as an override would be the same bug pointed the other way.
 */
export function overriddenSeams(source: string): string[] {
    const code = blankNonCode(source);
    if (!code.includes(AV_MODULE)) return [];
    const factory = code.slice(code.indexOf(AV_MODULE));
    // `scanUploadedBufferDetailed:` also contains `scanUploadedBuffer`, so the
    // key must be matched up to its colon or the shorter name always "matches".
    return SEAMS.filter((seam) => new RegExp(`\\b${seam}\\s*:`).test(factory));
}

describe('av-scan mocks cover both seams', () => {
    const files = collectSourceFiles({ roots: ['tests'], floor: 500 });

    it('every suite mocking the scanner overrides both functions', () => {
        const partial = files
            .map((file) => ({ file, seams: overriddenSeams(fs.readFileSync(file, 'utf8')) }))
            .filter((row) => row.seams.length > 0 && row.seams.length < SEAMS.length)
            .map((row) => `${row.file.split('/tests/')[1]} overrides only ${row.seams.join(', ')}`);

        expect(partial).toEqual([]);
    });

    it('found the suites that DO mock it, so the sweep is not empty', () => {
        // Without this, the assertion above passes for free the day the mock
        // factories are rewritten into a shape this detector cannot see.
        const mockers = files.filter(
            (file) => overriddenSeams(fs.readFileSync(file, 'utf8')).length > 0,
        );
        expect(mockers.length).toBeGreaterThanOrEqual(2);
    });

    it('detects a partial override, and is not fooled by the shared prefix', () => {
        const both = `jest.mock('${AV_MODULE}', () => ({
            scanUploadedBuffer: a, scanUploadedBufferDetailed: b,
        }));`;
        const onlyShort = `jest.mock('${AV_MODULE}', () => ({ scanUploadedBuffer: a }));`;
        const onlyLong = `jest.mock('${AV_MODULE}', () => ({ scanUploadedBufferDetailed: b }));`;

        expect(overriddenSeams(both)).toEqual([...SEAMS]);
        expect(overriddenSeams(onlyShort)).toEqual(['scanUploadedBuffer']);
        // The shared prefix is the trap: a naive `includes` reports the short
        // name here too, and the partial case would look complete.
        expect(overriddenSeams(onlyLong)).toEqual(['scanUploadedBufferDetailed']);
    });

    it('ignores prose, which is why comments are blanked', () => {
        expect(overriddenSeams('// scanUploadedBuffer: see av-scan.ts')).toEqual([]);
        expect(overriddenSeams('const x = 1;')).toEqual([]);
    });
});
