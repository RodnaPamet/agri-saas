/**
 * The parcel-level cloud judgement is wired where it was decided, and nowhere
 * else — #2837, owner 2026-11-07.
 *
 * None of this is behaviourally testable: `adaptiveS2Collection` builds an
 * Earth Engine computation graph and nothing in this repo evaluates one. So
 * this guard pins the four decisions whose removal is SILENT — each of them
 * makes the product look better while being wrong, which is the worst
 * direction for a regression to point.
 *
 *   1. The SCL class list exists ONCE. The scene filter and the mask that
 *      reduces the scene must agree by construction: a filter admitting a pass
 *      as clear on one set of classes, over a mask that uses another, produces
 *      an empty reading for a pass it had just called clear.
 *   2. `unmask(0)` is in the clear-share reduction. SCL is masked outside the
 *      granule footprint and `reduceRegion`'s mean ignores masked pixels, so
 *      without it a scene clipping one corner of a parcel reports a clear
 *      share of 1.0 for the sliver it covers. The symptom is a FRESHER
 *      acquisition date, which is exactly what this change was asked for —
 *      so it would read as success.
 *   3. The parcel readers opt in and the TILE readers do not. The tile path
 *      takes a location bounding box, where a 0.5 clear share means something
 *      nobody has chosen, and it serves map tiles in bulk.
 *   4. `SCENE_SELECTION_VERSION` moved. It is what invalidates every stored
 *      coverage watermark written under the rules this change replaces; left
 *      at 1, every parcel keeps serving the old answer and no test fails.
 *
 * Asserted on source text, so it contributes no runtime coverage and proves
 * no behaviour. It is the right tool here only because the subject is an
 * un-evaluable graph; everything in `parcel-risk.ts` that CAN be executed is
 * executed by `tests/unit/parcel-risk-history.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const REL = 'src/lib/agro/earth-engine.ts';
const SRC = fs.readFileSync(path.resolve(__dirname, '../..', REL), 'utf8');
/**
 * Comments blanked. Load-bearing for the same reason as the sibling EE guard:
 * this file EXPLAINS the SCL class list in prose, and a count that read the
 * explanation would report two copies of a thing that exists once.
 *
 * `blankNonCode` preserves character POSITIONS rather than deleting, so every
 * offset below lines up with the real file.
 */
const CODE = blankNonCode(SRC);

/**
 * The body of a named function in `CODE`, by brace matching.
 *
 * The opening brace is found by PAREN-MATCHING the parameter list first, not
 * by taking the first `{` after the name. #2837 stage 2 gave
 * `getIndexMeansForPolygon` an `opts: { stressThreshold?: number } = {}`
 * parameter, and the naive version then extracted
 * `"{ stressThreshold?: number }"` as the whole function body.
 *
 * It failed loudly here because the assertions are `toMatch`, and an inline
 * type literal does not contain `scale: 20`. A guard written with
 * `not.toContain` would have passed on that slice — which is the shape to
 * watch for: an extractor that returns the WRONG non-empty thing is invisible
 * to a negated assertion.
 */
function bodyOf(name: string): string {
    const at = CODE.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`No \`function ${name}(\` in ${REL}`);
    // Walk the parameter list to its closing paren, so a brace inside a
    // parameter's type cannot be mistaken for the body.
    const paramsOpen = CODE.indexOf('(', at);
    let parens = 0;
    let paramsEnd = -1;
    for (let i = paramsOpen; i < CODE.length; i += 1) {
        if (CODE[i] === '(') parens += 1;
        else if (CODE[i] === ')') {
            parens -= 1;
            if (parens === 0) {
                paramsEnd = i;
                break;
            }
        }
    }
    if (paramsEnd < 0) throw new Error(`Unbalanced parens in \`${name}\`'s signature`);
    const open = CODE.indexOf('{', paramsEnd);
    let depth = 0;
    for (let i = open; i < CODE.length; i += 1) {
        if (CODE[i] === '{') depth += 1;
        else if (CODE[i] === '}') {
            depth -= 1;
            if (depth === 0) return CODE.slice(open, i + 1);
        }
    }
    throw new Error(`Unbalanced braces after \`function ${name}\` in ${REL}`);
}

describe('parcel-level cloud judgement — controls', () => {
    it('the file was read, is the one we mean, and the stripper ran', () => {
        // Without this every assertion below passes on an empty string.
        expect(SRC.length).toBeGreaterThan(5_000);
        expect(CODE).toContain('function adaptiveS2Collection');
        expect(CODE).toContain('function parcelClearShare');
        expect(CODE).toContain('function sclClearMask');
        // Prose is gone, positions are not.
        expect(CODE).not.toContain('load-bearing call');
        expect(CODE.length).toBe(SRC.length);
        expect(CODE).not.toBe(SRC);
    });

    it('brace matching finds a real body, not an empty slice', () => {
        // `bodyOf` is this guard's selector. An extraction that silently
        // returned '' would satisfy every `not.toContain` below.
        const body = bodyOf('sclClearMask');
        expect(body.length).toBeGreaterThan(40);
        expect(body).toContain('SCL');

        /*
         * And specifically the function with an inline TYPE LITERAL in its
         * parameter list, because that is what broke the first version:
         * `opts: { stressThreshold?: number } = {}` made the naive extractor
         * return the type literal as the body. A body is recognisable by
         * holding the reducer this guard is about.
         */
        const polygon = bodyOf('getIndexMeansForPolygon');
        expect(polygon.length).toBeGreaterThan(500);
        expect(polygon).toContain('reduceRegion');
        expect(polygon).not.toContain('stressThreshold?: number');
    });
});

describe('the SCL class list exists exactly once', () => {
    it('only `sclClearMask` spells the masked classes', () => {
        /*
         * Counted as occurrences of the chain's first term rather than the
         * whole chain, so a copy that reordered or reformatted the terms is
         * still caught. Four copies existed before #2837 and the scene filter
         * would have been a fifth.
         */
        const sites = CODE.match(/\.neq\(3\)/g) ?? [];
        if (sites.length !== 1) {
            throw new Error(
                `Expected exactly 1 spelling of the SCL class list in ${REL}, ` +
                    `found ${sites.length}.\n\n` +
                    'The scene FILTER decides which passes enter the collection and the ' +
                    'MASK decides which pixels are reduced. Keyed on different class ' +
                    'sets, a pass is admitted as clear over the parcel and then reduces ' +
                    'to nothing — a null reading for a pass the filter just called ' +
                    'usable. They have to be one answer by construction.\n\n' +
                    'Call `sclClearMask(img)` instead of re-spelling the chain.',
            );
        }
        expect(sites.length).toBe(1);
        expect(bodyOf('sclClearMask')).toContain('.neq(3)');
    });

    it('every masker goes through the helper', () => {
        // Four call sites plus the definition. A floor rather than an exact
        // count, because a fifth reader is fine; what is not fine is a reader
        // that spells the chain itself, which the test above catches.
        const calls = CODE.match(/sclClearMask\(/g) ?? [];
        // Denominator, read in the CI step summary via the `[tag]` reporter.
        // No `eslint-disable` here: `no-console` does not apply under `tests/`,
        // so the directive would be INERT and the lint ceiling counts those.
        console.log(`[parcel-cloud] sclClearMask call sites: ${calls.length - 1}`);
        expect(calls.length - 1).toBeGreaterThanOrEqual(4);
    });
});

describe('the clear share counts outside-the-footprint as NOT clear', () => {
    it('`parcelClearShare` unmasks to 0 before reducing', () => {
        const body = bodyOf('parcelClearShare');
        if (!/\.unmask\(0\)/.test(body)) {
            throw new Error(
                `\`parcelClearShare\` in ${REL} must \`.unmask(0)\` the clear mask ` +
                    'before reducing.\n\n' +
                    "SCL is MASKED outside the granule footprint and `reduceRegion`'s " +
                    'mean ignores masked pixels. Without the unmask, a scene clipping ' +
                    'one corner of a parcel reports a clear share of 1.0 for the sliver ' +
                    'it covers and is kept as a full reading of the field.\n\n' +
                    'The symptom is a FRESHER acquisition date, which is what this ' +
                    'change was asked to produce — so the regression reads as success.',
            );
        }
        expect(body).toMatch(/\.unmask\(0\)/);
    });

    it('…and reduces at the same scale as the reading it gates', () => {
        // A clear share measured at 100 m over a mask applied at 20 m would
        // admit passes whose clear pixels do not survive the reduction.
        const body = bodyOf('parcelClearShare');
        expect(body).toMatch(/scale:\s*20\b/);
        expect(bodyOf('getIndexMeansPerPass')).toMatch(/scale:\s*20\b/);
        expect(bodyOf('getIndexMeansForPolygon')).toMatch(/scale:\s*20\b/);
    });
});

describe('the judgement is opt-in, and opted in exactly where it was decided', () => {
    /** Which function each `adaptiveS2Collection(` call sits inside. */
    function callersOf(): Array<{ fn: string; perRegion: boolean }> {
        const fns = [...CODE.matchAll(/function (\w+)\s*\(/g)].map((m) => ({
            at: m.index ?? 0,
            name: m[1],
        }));
        const out: Array<{ fn: string; perRegion: boolean }> = [];
        for (const m of CODE.matchAll(/adaptiveS2Collection\(([^;]*?)\);/g)) {
            const at = m.index ?? 0;
            const owner = fns.filter((f) => f.at < at).pop();
            if (!owner || owner.name === 'adaptiveS2Collection') continue;
            out.push({ fn: owner.name, perRegion: /judgeCloudOverRegion:\s*true/.test(m[1]) });
        }
        return out;
    }

    it('finds every call site (scan sanity)', () => {
        const callers = callersOf();
        // Denominator, read in the CI step summary via the `[tag]` reporter.
        // No `eslint-disable` here: `no-console` does not apply under `tests/`,
        // so the directive would be INERT and the lint ceiling counts those.
        console.log(
            `[parcel-cloud] adaptiveS2Collection callers: ${callers
                .map((c) => `${c.fn}=${c.perRegion ? 'parcel' : 'tile'}`)
                .join(', ')}`,
        );
        // The four that exist today. A floor, so a new reader is not a failure
        // here — it is a failure in the two assertions below, which is where
        // the decision lives.
        expect(callers.length).toBeGreaterThanOrEqual(4);
    });

    it('the POLYGON readers judge cloud over the parcel', () => {
        const callers = callersOf();
        for (const fn of ['getIndexMeansForPolygon', 'getIndexMeansPerPass']) {
            const c = callers.find((x) => x.fn === fn);
            if (!c) throw new Error(`${fn} must call adaptiveS2Collection — this guard found no call site for it in ${REL}.`);
            if (!c?.perRegion) {
                throw new Error(
                    `${fn} must pass \`judgeCloudOverRegion: true\`.\n\n` +
                        'Owner decision 2026-11-07: a parcel reading is judged on cloud ' +
                        'over THAT PARCEL. `CLOUDY_PIXEL_PERCENTAGE` describes a ' +
                        '~100x100 km granule, so the tile-level filter discards passes ' +
                        'that are perfectly clear over one field — which is why parcel ' +
                        '15655-19 reported a ten-day-old acquisition.',
                );
            }
        }
    });

    it('the BOUNDING-BOX readers do NOT', () => {
        const callers = callersOf();
        for (const fn of ['getIndexTileUrl', 'getIndexMeansForBounds']) {
            const c = callers.find((x) => x.fn === fn);
            if (!c) throw new Error(`${fn} must call adaptiveS2Collection — this guard found no call site for it in ${REL}.`);
            if (c?.perRegion) {
                throw new Error(
                    `${fn} must NOT pass \`judgeCloudOverRegion: true\`.\n\n` +
                        'Its `region` is a location BOUNDING BOX, not a field. A clear ' +
                        'share over a bbox spanning a whole farm is a different quantity ' +
                        'from one over a parcel, so MIN_PARCEL_CLEAR_SHARE would mean ' +
                        'something nobody chose — and it costs a `reduceRegion` per image ' +
                        'on the path that serves map tiles in bulk.\n\n' +
                        'If this is a deliberate reversal, say so here and in the ' +
                        "function's docblock, and decide what the threshold means for a " +
                        'bbox first.',
                );
            }
        }
    });
});

describe('the scene-selection version moved with the rules', () => {
    it('SCENE_SELECTION_VERSION is declared exactly ONCE', () => {
        /*
         * This one is here because the guard missed it. Relocating the
         * constant's block upward in this branch, then merging a main that had
         * squashed the version-1 copy at its ORIGINAL site, made git's
         * three-way auto-merge keep both: two `export const` declarations in
         * one module, version 2 at the top and version 1 at the bottom.
         *
         * The version assertion below uses a non-global `.match`, so it read
         * the FIRST declaration, saw 2, and passed. CI's `Typecheck` caught it
         * — "Cannot redeclare block-scoped variable" — which is the right
         * backstop but says nothing about WHICH value wins, and the duplicate
         * sat in a file the merge reported as auto-merged cleanly.
         *
         * A count, not a `.match`: the failure mode is a second declaration,
         * and no assertion about one declaration's value can see it.
         */
        const decls = CODE.match(/export const SCENE_SELECTION_VERSION\b/g) ?? [];
        if (decls.length !== 1) {
            throw new Error(
                `Expected exactly 1 declaration of SCENE_SELECTION_VERSION in ${REL}, ` +
                    `found ${decls.length}.\n\n` +
                    'More than one is almost always a merge artefact: the block was moved ' +
                    'in one branch and squashed at its old site in another, so a clean ' +
                    'three-way auto-merge keeps both. Which value the module exports then ' +
                    'depends on declaration order, and a watermark comparison against the ' +
                    'wrong one silently stops re-searching.',
            );
        }
        expect(decls.length).toBe(1);
    });

    it('SCENE_SELECTION_VERSION is at least 2', () => {
        /*
         * The constant is what invalidates every stored coverage watermark
         * written under the rules this change replaces. Left at 1, each parcel
         * keeps claiming its window was searched — under rules that REJECTED
         * the passes now admitted — so nothing goes back for them, every chart
         * keeps the old answer, and no other test fails.
         *
         * A floor, not an equality: a later selection change bumps it again
         * and must not have to edit this line.
         */
        const m = CODE.match(/export const SCENE_SELECTION_VERSION = (\d+)/);
        if (!m) throw new Error(`SCENE_SELECTION_VERSION must be declared in ${REL}.`);
        const version = Number(m?.[1]);
        expect(version).toBeGreaterThanOrEqual(2);
    });

    it('the parcel-risk usecase compares the stored version to that constant', () => {
        // The guard above is worth nothing if nobody reads the constant.
        const usecase = fs.readFileSync(
            path.resolve(__dirname, '../..', 'src/app-layer/usecases/parcel-risk.ts'),
            'utf8',
        );
        expect(usecase).toContain('SCENE_SELECTION_VERSION');
        expect(blankNonCode(usecase)).toMatch(/coveredAlgo === SCENE_SELECTION_VERSION/);
    });
});
