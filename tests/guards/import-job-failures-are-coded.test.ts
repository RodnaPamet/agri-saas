/**
 * An import job's refusals NAME THEMSELVES (#1447).
 *
 * ## What this covers, and why it is a guard rather than a unit test
 *
 * `agrent-ios` renders an import failure from the poll response. Until this
 * change the poll carried exactly one thing about a failure — `failedReason`,
 * which is `err.message`, which is English — so «Import is too complex (812340
 * vertices across all parcels; limit is 500000)» appeared verbatim on a
 * Bulgarian screen. Nothing about that was detectable: the type system is
 * perfectly happy with `throw new Error('a sentence')`, and the five coded
 * refusals the HTTP layer got in #1633 are BACKSTOPS the phone pre-checks
 * before uploading. The English a farmer actually reads comes from here.
 *
 * So the rule is structural: in the two import jobs, every throw carries a
 * code. A unit test can prove one throw does; only a scan can prove the
 * eighth one someone adds next year does.
 *
 * The scan deliberately covers the JOB files and not the whole tree. These
 * two are the ones whose throws reach a polled client verbatim — the rest of
 * the executor registry fails into logs, where English is correct.
 */
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

/**
 * The files whose throws reach a POLLING client verbatim.
 *
 * `limits.ts` is in the set and not only the two job files: four of the
 * refusals a farmer sees — the three complexity caps and the per-format byte
 * cap — are thrown there and propagate out through the job untouched. Scoping
 * this to `app-layer/jobs` would have covered 8 of the 12 codes while reading
 * as though it covered the surface.
 */
const POLLED_SOURCES = [
    'src/app-layer/jobs/spatial-import.ts',
    'src/app-layer/jobs/cadastre-import.ts',
    'src/lib/spatial/limits.ts',
] as const;

/** The spec, for the "documented" half of the rule. */
const SPEC = path.join(REPO_ROOT, 'src/generated/openapi.json');

/**
 * Code read with COMMENTS blanked (string bodies are left alone — that is
 * what `blankNonCode` does by default, confirmed by its output being the
 * same length as the input).
 *
 * Comments in these files quote the `throw new Error(...)` shape they
 * replaced, in order to explain why. A scan counting those would report a
 * scar as a wound — it happened on #1629 and the fix is the same: strip
 * first. Strings staying intact is what makes the no-identifiers assertion
 * below able to see an interpolation in a message.
 */
function codeOf(rel: string): string {
    return blankNonCode(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

/** A bare `throw new Error(` — the shape with nothing for a client to switch on. */
const BARE_THROW = /\bthrow\s+new\s+Error\s*\(/g;

/** Every UPPER_SNAKE literal passed to one of our coded throwers. */
const CODED_THROW =
    /new\s+(?:SpatialLimitError|CodedFailureError)\s*\([\s\S]{0,600}?['"]([A-Z][A-Z0-9_]{2,})['"]/g;

describe('an import job failure carries a code, not just English (#1447)', () => {
    it('control: the scanned files exist and are non-trivial', () => {
        for (const rel of POLLED_SOURCES) {
            const src = codeOf(rel);
            expect(src.length).toBeGreaterThan(2_000);
            // Both files must still contain throws at all — a file that stopped
            // throwing would satisfy the next test by having nothing to find.
            expect(src).toMatch(/\bthrow\b/);
        }
    });

    it('no polled import job throws a bare Error', () => {
        const offenders: string[] = [];
        for (const rel of POLLED_SOURCES) {
            const src = codeOf(rel);
            for (const m of src.matchAll(BARE_THROW)) {
                const line = src.slice(0, m.index).split('\n').length;
                offenders.push(`${rel}:${line}`);
            }
        }
        // `throw new Error(...)` reaches a farmer as `failedReason` and gives a
        // client nothing to translate by. Throw a `SpatialLimitError` (for a
        // refusal the uploader can act on) or a `CodedFailureError`.
        expect(offenders).toEqual([]);
    });

    it('control: the bare-throw scan DETECTS one when it is there', () => {
        // Teeth. The assertion above passes trivially on an empty selection,
        // so prove the pattern fires on the exact shape it forbids — with the
        // surrounding file as context, not a bare string, so a change to
        // `BARE_THROW` that stops matching real code fails here.
        const mutated = codeOf(POLLED_SOURCES[0]).replace(
            'throw internalImportFailure();',
            "throw new Error('spatial-import: regressed to English');",
        );
        expect(mutated).not.toBe(codeOf(POLLED_SOURCES[0]));
        expect([...mutated.matchAll(BARE_THROW)]).toHaveLength(1);
    });

    it('every code these jobs throw is named in the spec', () => {
        const spec = fs.readFileSync(SPEC, 'utf8');
        const codes = new Set<string>();
        for (const rel of POLLED_SOURCES) {
            for (const m of codeOf(rel).matchAll(CODED_THROW)) codes.add(m[1]);
        }
        // Twelve today: five from the upload job, five from cadastre, four
        // from `limits.ts` (two of which the upload job re-throws). A floor
        // rather than an equality so adding a refusal does not fail this
        // line — the documentation requirement below is what must hold.
        expect(codes.size).toBeGreaterThanOrEqual(12);
        // `\b…\b` and NOT `spec.includes(c)`. This is #1632's defect and it
        // bit here first: a mutation that renamed `SPATIAL_PARCEL_TOO_COMPLEX`
        // to `…COMPLEXX` in the spec SURVIVED, because the longer string
        // contains the shorter one, so a code deleted from the spec went on
        // reading as documented. `_` is a word character, so the boundary
        // rejects both a longer prefix and a longer suffix.
        const undocumented = [...codes]
            .filter((c) => !new RegExp(`\\b${c}\\b`).test(spec))
            .sort();
        expect(undocumented).toEqual([]);

        // Control: the boundary check REJECTS a near-miss that `includes`
        // would have accepted. Without this line the paragraph above is a
        // claim rather than a measurement.
        const nearMiss = spec.replace(/SPATIAL_PARCEL_TOO_COMPLEX/g, 'SPATIAL_PARCEL_TOO_COMPLEXX');
        expect(nearMiss.includes('SPATIAL_PARCEL_TOO_COMPLEX')).toBe(true);
        expect(/\bSPATIAL_PARCEL_TOO_COMPLEX\b/.test(nearMiss)).toBe(false);
    });

    it('no code CONTAINS another — the substring trap (#1632)', () => {
        // `documented()` in `error-codes-are-documented` is
        // `specText.includes(code)`, so documenting `SPATIAL_FILE_TOO_LARGE`
        // would have made the genuinely-undocumented `FILE_TOO_LARGE` read as
        // covered and the guard would then have demanded its baseline entry be
        // deleted — hiding a live gap on three upload paths. The defence is to
        // never nest one code inside another.
        const codes = new Set<string>();
        for (const rel of POLLED_SOURCES) {
            for (const m of codeOf(rel).matchAll(CODED_THROW)) codes.add(m[1]);
        }
        const all = [...codes];
        const nested = all.flatMap((a) =>
            all.filter((b) => b !== a && a.includes(b)).map((b) => `${b} ⊂ ${a}`),
        );
        expect(nested).toEqual([]);

        // Control: the check sees nesting when it exists.
        const withTrap = [...all, `SPATIAL_${all[0]}`];
        expect(
            withTrap.flatMap((a) => withTrap.filter((b) => b !== a && a.includes(b))),
        ).not.toEqual([]);
    });

    it.each([
        ['src/app-layer/jobs/spatial-import.ts', 'internalImportFailure', 'SPATIAL_IMPORT_INTERNAL'],
        ['src/app-layer/jobs/cadastre-import.ts', 'internalCadastreFailure', 'CADASTRE_IMPORT_INTERNAL'],
    ])('%s: the internal invariant publishes NO identifiers', (rel, fn, code) => {
        // Three conditions in each import job are broken invariants, and their
        // messages used to carry two raw cuids each — on a farmer's screen, in
        // English, for something they cannot fix. One code, no params, and the
        // ids go to the logger instead.
        const internal = codeOf(rel).match(
            new RegExp(`function ${fn}[\\s\\S]{0,600}?\\n}`),
        )?.[0];
        expect(internal).toBeTruthy();
        expect(internal).toContain(code);
        // No interpolation anywhere in it — message included. Strings are NOT
        // blanked by `codeOf`, so a `${payload.tenantId}` creeping back into
        // the sentence fails here, which is the regression that matters.
        expect(internal).not.toMatch(/\$\{/);
        // And no params object: `{` would open one, and `params` is the other
        // place an identifier could travel.
        const args = internal!.slice(internal!.indexOf('CodedFailureError('));
        expect(args).not.toContain('{');
    });
});
