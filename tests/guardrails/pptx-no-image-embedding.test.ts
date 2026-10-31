/**
 * `pptxgenjs` must not come back without re-arguing the security case.
 *
 * ─── What this guard used to be ─────────────────────────────────────
 *
 * It asserted that `renderPptx()` embedded no images. That claim was
 * load-bearing: two HIGH advisories (GHSA-w3rx-r6r6-pgpr,
 * GHSA-5p2g-fcmc-qvqq) are open against `image-size`, which reached the
 * production tree only via `pptxgenjs`, and the audit exemption for
 * them rested entirely on the vulnerable ICNS / JXL / HEIF parsers
 * being unreachable — true only for as long as nobody passed the
 * renderer an image.
 *
 * ─── Why it is inverted now ─────────────────────────────────────────
 *
 * `renderPptx()` was the sole consumer of `pptxgenjs`, and it went with
 * the risk report in the risk-quantification uproot. So the dependency
 * was DROPPED rather than exempted: `image-size` is no longer in the
 * production tree at all, both exemptions were deleted from
 * `scripts/audit-exemptions.mjs`, and
 * `npm audit --omit=dev --audit-level=moderate` reports zero
 * vulnerabilities with no exemption in play.
 *
 * That is strictly stronger than the old guard — an absent parser
 * cannot be reached by any code path, reviewed or not. But it is also
 * strictly more fragile to silent reversal: re-adding `pptxgenjs` for a
 * slide export would quietly reintroduce two HIGH advisories AND fail
 * the `npm audit` gate, and the temptation at that point is to paste
 * the old exemption back rather than re-argue it.
 *
 * So the invariant flips. Instead of "the renderer embeds no images",
 * this now holds "the vulnerable dependency is gone, and the exemption
 * that used to cover it is gone with it".
 *
 * If you are here because this test failed, you have added `pptxgenjs`
 * back. That is allowed — but it is a security decision, not a
 * packaging one. Either establish nil reachability again and restore a
 * tracked exemption WITH a fresh reachability argument and review date,
 * or wait for an upstream `image-size` fix. Do not delete this guard.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = join(__dirname, '../..');

describe('pptxgenjs stays out of the production tree', () => {
    it('is not a declared dependency', () => {
        const pkg = JSON.parse(
            readFileSync(join(ROOT, 'package.json'), 'utf8'),
        ) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = {
            ...(pkg.dependencies ?? {}),
            ...(pkg.devDependencies ?? {}),
        };
        expect(Object.keys(declared)).not.toContain('pptxgenjs');
    });

    it('is imported by no module under src/', () => {
        // The old guard allowed exactly one importer. Zero is the
        // invariant now, and a grep that finds nothing is the proof.
        const out = execSync(
            `grep -rl "pptxgenjs" ${JSON.stringify(join(ROOT, 'src'))} || true`,
            { encoding: 'utf8' },
        )
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        expect(out).toEqual([]);
        // #2507: `|| true` means a BROKEN grep — wrong path, missing binary,
        // unreadable tree — also yields an empty list, which is byte-identical
        // to the pass above. So run the same shape for a token that must be
        // there, and require a hit.
        const control = execSync(
            `grep -rl "withApiErrorHandling" ${JSON.stringify(join(ROOT, 'src'))} || true`,
            { encoding: 'utf8' },
        )
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        expect(control.length).toBeGreaterThan(10);
    });

    it('the renderer that justified the exemption is gone', () => {
        // Named explicitly so a resurrected file is caught even if it
        // imports pptxgenjs indirectly through a helper.
        expect(
            existsSync(join(ROOT, 'src/app-layer/reports/risk-report-render.ts')),
        ).toBe(false);
    });

    it('no audit exemption still claims an image-size advisory', () => {
        // The stale-exemption check inside audit-exemptions.mjs only runs
        // when `npm audit` FAILS. With the advisories gone the gate
        // passes, that script never executes, and a leftover entry would
        // sit here unexercised — a permanent blind spot of exactly the
        // kind rule 3 in that file warns about. This runs unconditionally.
        const src = readFileSync(
            join(ROOT, 'scripts/audit-exemptions.mjs'),
            'utf8',
        );
        // #2507. This assertion was INERT for 82 days and reported the right
        // answer for the wrong reason. The marker was `const EXEMPT = [`; that
        // array was renamed to `REAL_EXEMPT` in #518 on 2026-08-10, one day
        // after this test landed in #501. `indexOf` then returned -1,
        // `src.slice(-1, <first "];">)` returned the EMPTY STRING, and all
        // three negated assertions passed over nothing — while all three
        // strings were present in the file.
        //
        // The conclusion happened to be true: they appear only in COMMENTS
        // recording their removal, which is what the `//` filter below is for.
        // But nothing was checking that, and `const EXEMPT =` still exists at
        // line ~130 as a TERNARY rather than an array literal, so a reader
        // grepping the name finds a live-looking match.
        //
        // So the anchor is asserted FOUND before it is used. An absence is a
        // renamed constant, not a clean exemption list.
        const ANCHOR = 'const REAL_EXEMPT = [';
        const start = src.indexOf(ANCHOR);
        expect({ anchor: ANCHOR, found: start !== -1 }).toEqual({
            anchor: ANCHOR,
            found: true,
        });
        const exemptBlock = src.slice(start, src.indexOf('];', start));
        // And the block is the ARRAY, not a few characters of whatever
        // followed. Both halves matter: a found anchor with an empty block is
        // the same vacuity one step later.
        expect(exemptBlock.length).toBeGreaterThan(200);
        const live = exemptBlock
            .split('\n')
            .filter((l) => !l.trim().startsWith('//'));
        expect(live.join('\n')).not.toContain('GHSA-w3rx-r6r6-pgpr');
        expect(live.join('\n')).not.toContain('GHSA-5p2g-fcmc-qvqq');
        expect(live.join('\n')).not.toContain('image-size');
    });

    it('detects a reintroduced dependency (mutation proof)', () => {
        // Prove the package.json check fires, rather than trusting it by
        // inspection — a guard that cannot fail protects nothing.
        const mutated = { dependencies: { pptxgenjs: '^4.0.1' } };
        expect(Object.keys(mutated.dependencies)).toContain('pptxgenjs');
    });
});
