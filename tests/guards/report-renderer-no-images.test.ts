/**
 * Guard: the report renderer must never embed images.
 *
 * This is the enforcement half of a tracked security exemption.
 *
 * `scripts/audit-gate.mjs` exempts two `image-size` advisories
 * (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) — DoS through infinite
 * loops in the ICNS / JXL / HEIF parsers. Neither has a fixed version:
 * both advisories report `<= 2.0.2` vulnerable with `first_patched:
 * none`, and `npm audit fix --force` would downgrade pptxgenjs 4.x to
 * 1.1.5, breaking PPTX export.
 *
 * The exemption rests on ONE fact: `image-size` is unreachable from our
 * code. pptxgenjs only calls it from its image-sizing path, which runs
 * exclusively from `addImage` / `addMedia`, and our only pptxgenjs
 * caller builds slides from `addText` + `addTable` alone. No image
 * reaches the parser, so no malformed image can.
 *
 * That premise is exactly the kind that rots silently: somebody adds a
 * chart image or a tenant logo to the risk report in six months, the
 * exemption's justification quietly becomes false, and nothing says so.
 * This test is what says so. If it fails, the exemption is void — either
 * drop the image work, or re-assess whether the advisory is now
 * reachable and remove the exemption from `audit-gate.mjs`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER = 'src/app-layer/reports/risk-report-render.ts';

/**
 * pptxgenjs entry points that reach the image-sizing path. `addMedia`
 * (video/audio posters) goes through the same sizing code as `addImage`,
 * so both are banned — omitting it would leave a hole the size of the
 * thing this guard exists to close.
 */
const IMAGE_APIS = ['addImage', 'addMedia'] as const;

describe('report renderer never embeds images (image-size exemption premise)', () => {
    const source = readFileSync(path.join(REPO_ROOT, RENDERER), 'utf8');

    it.each(IMAGE_APIS)('does not call %s', (api) => {
        // Word-bounded so a comment mentioning the name in prose (this
        // guard's own rationale, for instance) is not a false positive,
        // while a real `.addImage(` call is caught.
        const called = new RegExp(`\\.\\s*${api}\\s*\\(`).test(source);
        expect(called).toBe(false);
    });

    it('detects a reintroduced image call (mutation proof)', () => {
        // An assertion that cannot fail is worse than none. Prove the
        // detector actually fires on the pattern it claims to catch.
        const mutated = source.replace(
            'const out = await pptx.write(',
            'slide.addImage({ path: userSuppliedPath });\n    const out = await pptx.write(',
        );
        expect(mutated).not.toBe(source);
        expect(/\.\s*addImage\s*\(/.test(mutated)).toBe(true);
    });

    it('still routes PPTX through pptxgenjs, so this guard is not vacuous', () => {
        // If the renderer stopped using pptxgenjs entirely, the two
        // assertions above would pass for the wrong reason and the
        // exemption would need removing, not enforcing.
        expect(source).toMatch(/from ['"]pptxgenjs['"]/);
    });
});
