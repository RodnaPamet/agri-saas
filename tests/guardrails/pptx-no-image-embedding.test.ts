/**
 * The PPTX report must not embed images.
 *
 * This guard exists to hold up a SECURITY EXEMPTION. Two HIGH advisories
 * (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) are open against
 * `image-size`, which reaches the production tree only via `pptxgenjs`.
 * There is no upstream fix — `image-size@1.2.1` is the latest published
 * version and is the vulnerable one — and npm's only proposed remedy is
 * a three-major downgrade of pptxgenjs.
 *
 * The exemption in `scripts/audit-exemptions.mjs` rests on ONE claim:
 * the vulnerable ICNS / JXL / HEIF parsers are unreachable, because the
 * sole consumer of pptxgenjs builds text and table slides and never
 * hands it an image. An unreachable parser cannot be attacked.
 *
 * That claim is only as good as the code, and code changes. So it is
 * enforced here rather than asserted in a comment: the day someone adds
 * image embedding to the PPTX report — a farm logo, an evidence photo,
 * a chart rendered to PNG — this fails, and the exemption has to be
 * re-argued instead of silently becoming false.
 *
 * If you are here because this test failed: do NOT delete the guard.
 * Either drop the image embedding, or remove the exemption entries and
 * accept that the audit gate now blocks until upstream ships a fix.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const RENDERER = join(ROOT, 'src/app-layer/reports/risk-report-render.ts');

/**
 * pptxgenjs' image entry points. `addImage` is the documented one;
 * `addMedia` covers video/audio, which pulls the same probing path.
 */
const IMAGE_APIS = [/\.addImage\s*\(/, /\.addMedia\s*\(/];

describe('PPTX report — no image embedding (security exemption premise)', () => {
    it('the renderer still exists where the exemption says it does', () => {
        // A moved/renamed file would make the grep below vacuously pass —
        // the classic way a structural guard rots into decoration.
        expect(existsSync(RENDERER)).toBe(true);
    });

    it('renderPptx does not call any pptxgenjs image API', () => {
        const src = readFileSync(RENDERER, 'utf8');
        const hits = IMAGE_APIS.filter((re) => re.test(src)).map(String);
        expect(hits).toEqual([]);
    });

    it('pptxgenjs is imported by exactly this one module', () => {
        // The exemption reasons about ONE consumer. A second one would
        // widen the reachable surface without anyone revisiting the
        // argument, so make adding one fail here.
        const { execSync } = require('child_process');
        const out = execSync(
            `grep -rl "pptxgenjs" ${JSON.stringify(join(ROOT, 'src'))} || true`,
            { encoding: 'utf8' },
        )
            .split('\n')
            .map((l: string) => l.trim())
            .filter(Boolean);
        expect(out).toEqual([RENDERER]);
    });

    it('detects an added image call (mutation proof)', () => {
        // Prove the detector fires, rather than trusting the regex by
        // inspection — a guard that cannot fail protects nothing.
        const mutated = "const s = pptx.addSlide();\n s.addImage({ path: logo });";
        expect(IMAGE_APIS.some((re) => re.test(mutated))).toBe(true);
    });
});
