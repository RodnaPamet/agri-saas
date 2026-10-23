/**
 * No two `@font-face` rules in a family claim the same codepoint — #1969.
 *
 * ## What this protects
 *
 * #1969 added `onest-bg-punct.woff2`, a shared cut carrying the space, digits,
 * sentence punctuation and Bulgarian quote marks that Onest's `cyrillic` cut
 * does not have — measured against that file's own cmap: 104 codepoints, of
 * which the only non-letters are `U+0020` and `U+2116`. Before it, a Bulgarian
 * heading downloaded `onest-latin.woff2` (33,760 B) to render its SPACE.
 *
 * All 33 of those codepoints already lived in the `latin` cut, so the new face
 * is only safe because `latin`'s declared range was NARROWED by exactly the
 * same set. If the two overlap, which file serves a comma depends on
 * `@font-face` declaration precedence — and the whole point of subtracting
 * rather than layering was to depend on no such rule. An overlap would not
 * show on screen either: both files have the glyph, so the symptom is a
 * silently re-added 33,760 B download on every Bulgarian page, which is the
 * defect #1969 fixed.
 *
 * ## What this does NOT assert, and why the first version of it was wrong
 *
 * It does not assert that a family's ranges are disjoint. Written that way, it
 * failed on all three families including the two #1969 never touched: Google's
 * own cuts overlap heavily and ON PURPOSE. Combining marks are carried in
 * several cuts so each is usable alone (`U+0304`, `U+0308`, `U+0329` sit in
 * latin, latin-ext AND vietnamese), the Vietnamese letters are repeated in
 * latin-ext, and `onest-math` ∩ `onest-symbols` is 185 codepoints.
 *
 * So the real property is narrower: **the cut this repo authored overlaps
 * nothing**, and Google's overlaps are a recorded BASELINE rather than a
 * verdict. The baseline is what makes the narrow claim non-vacuous — a future
 * widening that put a comma back into `latin` would show up as a new pair.
 *
 * `U+2116` (№) is the deliberate exception to "take it from latin": it is in
 * the `cyrillic` cut, where a Bulgarian page already has it, so the generator
 * drops it from the cut instead. That is asserted here too, because a future
 * cut that stopped doing it would move № out of a file the page already loads.
 *
 * ## Why this parses CSS rather than importing the generator's helpers
 *
 * `scripts/fonts/vendor-fonts.mjs` exports `parseRange`/`subtractRange`, and
 * jest's `node` project is CJS: it cannot load an `.mjs` at all. So this
 * carries its own parser — and pays for the second copy with a POSITIVE
 * CONTROL below, proving it detects a deliberately overlapped pair before
 * anything it says about the real ranges is worth reading.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CSS = readFileSync(path.join(ROOT, 'src/styles/fonts.css'), 'utf8');

type Pair = readonly [number, number];
interface Face {
    family: string;
    weight: string;
    file: string;
    range: Pair[];
}

/** THROWS on an unparsed clause: a skipped one reads as a narrower range. */
function parseRange(spec: string): Pair[] {
    const out: Pair[] = [];
    for (const raw of spec.split(',')) {
        const part = raw.trim();
        if (!part) continue;
        const span = /^U\+([0-9A-Fa-f]+)-([0-9A-Fa-f]+)$/.exec(part);
        if (span) {
            out.push([parseInt(span[1], 16), parseInt(span[2], 16)]);
            continue;
        }
        const one = /^U\+([0-9A-Fa-f]+)$/.exec(part);
        if (one) {
            const v = parseInt(one[1], 16);
            out.push([v, v]);
            continue;
        }
        throw new Error(`unicode-range clause not understood: ${part}`);
    }
    return out;
}

function parseFaces(css: string): Face[] {
    const out: Face[] = [];
    for (const [, body] of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
        const pick = (k: string) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) ?? [])[1]?.trim();
        const spec = pick('unicode-range');
        if (!spec) continue;
        out.push({
            family: (pick('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
            weight: pick('font-weight') ?? '',
            file: (body.match(/url\('\/fonts\/([^']+)'\)/) ?? [])[1] ?? '',
            range: parseRange(spec),
        });
    }
    return out;
}

/** Codepoints claimed by both, capped so a bug cannot hang the run. */
function overlap(a: Pair[], b: Pair[]): number[] {
    const hits: number[] = [];
    for (const [alo, ahi] of a) {
        for (const [blo, bhi] of b) {
            const lo = Math.max(alo, blo);
            const hi = Math.min(ahi, bhi);
            for (let c = lo; c <= hi && hits.length < 16; c += 1) hits.push(c);
        }
    }
    return hits;
}

const hex = (c: number) => (null);
const faces = parseFaces(CSS);

describe('font subset ranges are disjoint within a family (#1969)', () => {
    it('CONTROL: the overlap detector finds a deliberately overlapped pair', () => {
        // Without this, every assertion below is satisfied by a detector that
        // returns nothing — and "no overlaps" is exactly what a broken one
        // reports. Three shapes: a straddle, a containment, a single point.
        expect(overlap(parseRange('U+0000-00FF'), parseRange('U+20-22'))).toEqual([32, 33, 34]);
        expect(overlap(parseRange('U+2116'), parseRange('U+2100-2120'))).toEqual([0x2116]);
        expect(overlap(parseRange('U+0-1F'), parseRange('U+20-22'))).toEqual([]);
    });

    it('CONTROL: a reported clash is legible — the codepoints are named', () => {
        // `hex` builds the ONLY part of this guard a human reads when it
        // fails, and it is reached from nowhere else: both call sites are
        // inside a failure message, so a green run never executes it. The
        // `Selector teeth` gate caught exactly that on #2206 — neutering
        // `hex` to return '' left every test here green, which means a
        // failure could have printed `both claim , , ` and nobody would have
        // learned it until the day it mattered.
        //
        // Asserted in the SHAPE the messages use (`cps.map(hex).join(', ')`)
        // rather than as a standalone formatter trivia test, so the control
        // covers the detector and the rendering together.
        const cps = overlap(parseRange('U+0000-00FF'), parseRange('U+20-22'));
        expect(cps.map(hex).join(', ')).toBe('U+20, U+21, U+22');
        // Four hex digits and a codepoint above the BMP's low range, since a
        // `toString(16)` that lost its radix would still be right for 0-9.
        expect(hex(0x2116)).toBe('U+2116');
        expect(hex(0x1F300)).toBe('U+1F300');
    });

    it('CONTROL: the parser refuses a clause it does not understand', () => {
        // A permissive parser would read a malformed range as an empty one,
        // and an empty range overlaps nothing.
        expect(() => parseRange('U+0020, garbage')).toThrow(/not understood/);
        expect(() => parseRange('0020-00FF')).toThrow(/not understood/);
    });

    it('[fonts] ranges over every declared face', () => {
        console.log(
            `[fonts] disjointness: ${faces.length} face(s), `
                + `${new Set(faces.map((f) => f.family)).size} family(ies), `
                + `${new Set(faces.map((f) => f.file)).size} file(s)`,
        );
        expect(faces.length).toBeGreaterThan(70);
        expect(new Set(faces.map((f) => f.family)).size).toBeGreaterThanOrEqual(3);
    });

    /**
     * Google's OWN overlapping pairs, measured 2026-10-23. Not defects — a
     * combining mark lives in every cut that might need it so each is usable
     * alone, and `math`/`symbols` share their arrows and geometric shapes.
     *
     * Recorded so the narrow claim below is not vacuous: an overlap that is
     * NOT on this list is either a widened upstream range or a cut this repo
     * authored colliding with one, and the second is the #1969 regression.
     */
    const UPSTREAM_OVERLAPS = new Set([
        'bricolage-grotesque-latin-ext.woff2|bricolage-grotesque-vietnamese.woff2',
        'bricolage-grotesque-latin.woff2|bricolage-grotesque-vietnamese.woff2',
        'bricolage-grotesque-latin-ext.woff2|bricolage-grotesque-latin.woff2',
        'inter-cyrillic-ext.woff2|inter-cyrillic.woff2',
        'inter-cyrillic-ext.woff2|inter-latin-ext.woff2',
        'inter-cyrillic.woff2|inter-vietnamese.woff2',
        'inter-latin-ext.woff2|inter-vietnamese.woff2',
        'inter-latin.woff2|inter-vietnamese.woff2',
        'inter-latin-ext.woff2|inter-latin.woff2',
        'onest-cyrillic-ext.woff2|onest-cyrillic.woff2',
        'onest-cyrillic-ext.woff2|onest-latin-ext.woff2',
        'onest-cyrillic.woff2|onest-vietnamese.woff2',
        'onest-math.woff2|onest-symbols.woff2',
        'onest-math.woff2|onest-vietnamese.woff2',
        'onest-latin-ext.woff2|onest-math.woff2',
        'onest-latin.woff2|onest-math.woff2',
        'onest-latin.woff2|onest-symbols.woff2',
        'onest-latin-ext.woff2|onest-vietnamese.woff2',
        'onest-latin.woff2|onest-vietnamese.woff2',
        'onest-latin-ext.woff2|onest-latin.woff2',
    ]);

    /** Overlapping file pairs at one weight, as sorted `a|b` keys. */
    function overlappingPairs(family: string, weight: string) {
        const group = faces.filter((f) => f.family === family && f.weight === weight);
        const found = new Map<string, number[]>();
        for (let i = 0; i < group.length; i += 1) {
            for (let j = i + 1; j < group.length; j += 1) {
                const both = overlap(group[i].range, group[j].range);
                if (!both.length) continue;
                found.set([group[i].file, group[j].file].sort().join('|'), both);
            }
        }
        return found;
    }

    const groups = [...new Set(faces.map((f) => `${f.family}|${f.weight}`))].sort();

    it.each(groups.map((k) => [k] as const))('%s introduces no NEW overlapping pair', (key) => {
        // Per (family, weight): two faces at DIFFERENT weights legitimately
        // cover the same codepoints — that is how a weight is chosen. Only
        // faces competing at one weight can be ambiguous.
        const [family, weight] = key.split('|');
        const unexpected = [...overlappingPairs(family, weight)]
            .filter(([pair]) => !UPSTREAM_OVERLAPS.has(pair))
            .map(([pair, cps]) => `${pair} both claim ${cps.map(hex).join(', ')}`);
        expect(unexpected).toEqual([]);
    });

    it('[fonts] the upstream-overlap baseline still describes something', () => {
        // A baseline listing pairs that no longer exist would excuse a real
        // overlap elsewhere. Every entry must still be observed, and the
        // observed count is printed so a shrinking population is visible.
        const observed = new Set<string>();
        for (const key of groups) {
            const [family, weight] = key.split('|');
            for (const pair of overlappingPairs(family, weight).keys()) observed.add(pair);
        }
        console.log(
            `[fonts] overlapping pairs: ${observed.size} observed, `
                + `${UPSTREAM_OVERLAPS.size} in the baseline`,
        );
        const stale = [...UPSTREAM_OVERLAPS].filter((p) => !observed.has(p));
        expect(stale).toEqual([]);
    });

    it('the cut this repo authored overlaps NOTHING', () => {
        // The claim #1969 actually owns. Separate from the baseline sweep so a
        // failure says which half broke.
        const culprits: string[] = [];
        for (const key of groups) {
            const [family, weight] = key.split('|');
            for (const [pair, cps] of overlappingPairs(family, weight)) {
                if (pair.includes('onest-bg-punct.woff2')) {
                    culprits.push(`${pair} both claim ${cps.map(hex).join(', ')}`);
                }
            }
        }
        expect(culprits).toEqual([]);
        // Not vacuous: the cut must be declared for this to range over it.
        expect(faces.some((f) => f.file === 'onest-bg-punct.woff2')).toBe(true);
    });
});

describe('the Bulgarian punctuation cut is wired as designed (#1969)', () => {
    const cut = faces.filter((f) => f.file === 'onest-bg-punct.woff2');
    const latin = faces.filter((f) => f.file === 'onest-latin.woff2');
    const cyrillic = faces.filter((f) => f.file === 'onest-cyrillic.woff2');

    it('exists, at every weight Onest declares', () => {
        const onestWeights = new Set(faces.filter((f) => f.family === 'Onest').map((f) => f.weight));
        expect(cut.length).toBeGreaterThan(0);
        expect(new Set(cut.map((f) => f.weight))).toEqual(onestWeights);
    });

    it('carries the space — the codepoint the whole issue was about', () => {
        // `onest-cyrillic.woff2` HAS a space glyph but does not CLAIM U+0020,
        // so before #1969 a Cyrillic heading fetched 33,760 B of latin for it.
        expect(cut.some((f) => overlap(f.range, parseRange('U+0020')).length === 1)).toBe(true);
        expect(cyrillic.every((f) => overlap(f.range, parseRange('U+0020')).length === 0)).toBe(true);
    });

    it('carries digits, hyphen and both Bulgarian quote marks', () => {
        // The farm-name cases that made widening the cyrillic range a trap:
        // `Победа 2024`, `Победа-Добрич`, and „…“ in a tagline.
        for (const cp of ['U+0030', 'U+0039', 'U+002D', 'U+201E', 'U+201C']) {
            expect({ cp, claimed: cut.some((f) => overlap(f.range, parseRange(cp)).length === 1) })
                .toEqual({ cp, claimed: true });
        }
    });

    it('latin no longer claims what the cut took', () => {
        // The other half of disjointness, asserted directly rather than only
        // via the pairwise sweep, so a failure names the cause.
        for (const cp of ['U+0020', 'U+0030', 'U+002D', 'U+00AB']) {
            expect({ cp, latinClaims: latin.some((f) => overlap(f.range, parseRange(cp)).length === 1) })
                .toEqual({ cp, latinClaims: false });
        }
    });

    it('latin still claims its letters — the subtraction did not gut it', () => {
        // A subtraction that emptied the donor would satisfy every assertion
        // above and silently stop serving Latin text.
        for (const cp of ['U+0041', 'U+007A', 'U+00E9']) {
            expect({ cp, latinClaims: latin.some((f) => overlap(f.range, parseRange(cp)).length === 1) })
                .toEqual({ cp, latinClaims: true });
        }
    });

    it('№ stays with the Cyrillic cut, not the punctuation cut', () => {
        // Deliberate: a Bulgarian page already has onest-cyrillic.woff2, so
        // moving U+2116 into the shared cut would add a fetch, not remove one.
        expect(cyrillic.some((f) => overlap(f.range, parseRange('U+2116')).length === 1)).toBe(true);
        expect(cut.every((f) => overlap(f.range, parseRange('U+2116')).length === 0)).toBe(true);
    });
});
