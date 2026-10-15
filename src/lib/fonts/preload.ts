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
 *   en   onest-latin-600 + inter-latin-400                      82,016 B
 *   bg   + onest-cyrillic-600 + inter-cyrillic-400              116,624 B
 *
 * ## Why the HEADING face is preloaded too (#1814)
 *
 * It was not, and that cost about a second of LCP on the public farm page.
 * Measured on #1874, three runs: FCP 1668 ms, LCP 2730 ms — a one-second gap
 * with CLS at 0.000, so nothing was moving on screen. The page's LCP element
 * is a `<Heading>`, which renders `font-heading font-semibold`: Onest 600.
 * Only Inter 400 was preloaded, so the heading painted in the fallback at FCP
 * and re-painted when Onest arrived, and the re-paint is what LCP measures.
 *
 * This does NOT add bytes to the page. Every heading on every surface renders
 * Onest 600 already, so the face was always fetched — just after CSS had been
 * parsed and the fallback had already painted. Preloading moves the request
 * earlier; it does not create one.
 *
 * Which is the distinction the budget check below is about. Preloading all 72
 * faces (1,950,912 B) would be strictly worse than preloading none, because
 * most are glyphs no page renders. These four are the two families every page
 * actually sets text in.
 */
import lock from '@/styles/fonts.lock.json';

/** The face the body text is set in. */
const BODY_FAMILY = 'Inter';
const BODY_WEIGHT = '400';

/**
 * The face HEADINGS are set in — `font-heading` in `tailwind.config.js`, at
 * the weight `<Heading>` renders (`font-semibold`).
 *
 * Onest carries a `cyrillic` subset, which is why a Bulgarian heading renders
 * in it rather than falling back to another family. `Bricolage Grotesque`, the
 * other display face in the lock, does NOT — so it must never become the
 * heading face without re-vendoring a Cyrillic cut.
 */
const HEADING_FAMILY = 'Onest';
const HEADING_WEIGHT = '600';

/**
 * Heading FIRST, deliberately.
 *
 * Preload order is request priority, and the heading is the LCP element on
 * every page that has one — the public farm page measurably so. Body text is
 * more of the page by volume and is not what the metric watches.
 */
const PRELOAD_FACES: ReadonlyArray<{ family: string; weight: string }> = [
    { family: HEADING_FAMILY, weight: HEADING_WEIGHT },
    { family: BODY_FAMILY, weight: BODY_WEIGHT },
];

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

    // Subset-major, so the Cyrillic pair does not jump ahead of the Latin one
    // a `bg` page also needs for digits and punctuation.
    return subsets.flatMap((subset) =>
        PRELOAD_FACES.map(({ family, weight }) => {
            const face = lock.faces.find(
                (f) =>
                    f.family === family &&
                    f.subset === subset &&
                    f.weight === weight &&
                    f.style === 'normal',
            );
            if (!face) {
                throw new Error(
                    `font preload: no ${family} ${subset} ${weight} in fonts.lock.json. ` +
                        `Re-vendor with \`npm run fonts:vendor -- --write-lock\`, or update ` +
                        `PRELOAD_FACES here if a face changed.`,
                );
            }
            return { href: `/fonts/${face.file}`, bytes: face.bytes };
        }),
    );
}
