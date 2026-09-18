/**
 * Which self-hosted font faces to `<link rel="preload">`, derived from the lock.
 *
 * ## Why derive rather than hardcode
 *
 * `scripts/fonts/vendor-fonts.mjs` names each file from the css2 response
 * (`${slug(family)}-${subset}-${weight}.woff2`), so a change in the upstream
 * subset set RENAMES files. A hardcoded href would then preload a 404 — and a
 * preload that 404s is worse than no preload: it costs a request, warms
 * nothing, and is invisible on screen because `font-display: swap` shows the
 * fallback either way.
 *
 * `src/styles/fonts.lock.json` is the only machine-readable inventory of what
 * is actually on disk (`public/fonts/` is a directory listing with no
 * family/subset/weight semantics), and `npm run fonts:vendor` verifies
 * lock↔disk parity.
 *
 * ## Why only the body face
 *
 * All 72 faces total 1,950,912 bytes; preloading them would be strictly worse
 * than preloading none. `Inter` is the BODY face (`globals.css`: `body {
 * font-family: 'Inter', … }`), so it is the one blocking first TEXT paint.
 * `Onest` (headings) and `Bricolage Grotesque` (dashboard numbers) both fall
 * back to Inter, which is preloaded — so no surface is left without a face.
 *
 * ## Why locale-conditional
 *
 * The subsets are `unicode-range`-split, so a Latin page never downloads the
 * Cyrillic file and vice versa. The product ships in Bulgarian (`uiLanguage`
 * defaults to `bg`), so a `bg` render needs the Cyrillic cut for its text and
 * the Latin cut for digits and punctuation.
 *
 *   en   inter-latin-400                    48,256 B
 *   bg   inter-latin-400 + inter-cyrillic-400  67,004 B
 */
import lock from '@/styles/fonts.lock.json';

/** The face the body text is set in. */
const BODY_FAMILY = 'Inter';
const BODY_WEIGHT = '400';

export interface PreloadFace {
    href: string;
    /** Bytes, from the lock — exposed so a test can assert the budget. */
    bytes: number;
}

/**
 * Faces to preload for `locale`.
 *
 * THROWS when a face cannot be resolved. A silent empty result would render a
 * page with zero preload links, which looks completely correct: the fallback
 * shows, the text is readable, and nothing reports a problem. That is the
 * empty-selection defect in a form with no symptom, so it is made loud here.
 *
 * `weight` in the lock is a STRING (`"400"`), not a number — matching on a
 * number silently selects nothing.
 */
export function preloadFaces(locale: string): PreloadFace[] {
    const subsets = locale.startsWith('bg') ? ['latin', 'cyrillic'] : ['latin'];

    return subsets.map((subset) => {
        const face = lock.faces.find(
            (f) =>
                f.family === BODY_FAMILY &&
                f.subset === subset &&
                f.weight === BODY_WEIGHT &&
                f.style === 'normal',
        );
        if (!face) {
            throw new Error(
                `font preload: no ${BODY_FAMILY} ${subset} ${BODY_WEIGHT} in fonts.lock.json. ` +
                    `Re-vendor with \`npm run fonts:vendor -- --write-lock\`, or update ` +
                    `BODY_FAMILY/BODY_WEIGHT here if the body face changed.`,
            );
        }
        return { href: `/fonts/${face.file}`, bytes: face.bytes };
    });
}
