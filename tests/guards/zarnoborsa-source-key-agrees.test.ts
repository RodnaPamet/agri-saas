/**
 * #3081 — the two spellings of the ZarnoBorsa source key must agree.
 *
 * `trends.ts` is a usecase and declares the key as a LITERAL beside
 * `SOURCE_EC_AGRIFOOD`, rather than importing it from the job that writes it —
 * importing would pull a job's module graph into the request path for one
 * string, and the file next door sets that precedent.
 *
 * The cost of the duplication is that the two can drift, and the drift would
 * be SILENT in the worst direction: the ingest would keep writing series under
 * `zarnoborsa` while the reference resolver looked for something else, so the
 * prices would appear in «Тенденции» and the calculator would quietly go on
 * using the EC average. Nothing would fail; the owner's ruling would simply
 * stop holding.
 *
 * Also pins the marker duplication in the extractor, which exists for a
 * harder reason: that function is stringified into a browser page, so a
 * module-scope reference is a `ReferenceError` there — and when that happened,
 * a fail-safe dressed it as a paywall and discarded 110 good rows.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { ZARNOBORSA_SOURCE } from '@/app-layer/jobs/zarnoborsa-ingest';
import { ZARNOBORSA_LOCKED_MARKER } from '@/lib/market/zarnoborsa-extract';
import { MZH_SOURCE } from '@/app-layer/jobs/mzh-prices-pull';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('#3081 — duplicated constants stay in step', () => {
    it('the reference resolver looks for the key the ingest WRITES', () => {
        const trends = read('src/app-layer/usecases/trends.ts');
        const m = /const SOURCE_ZARNOBORSA = '([^']+)';/.exec(trends);
        // EXTRACTION CONTROL: without this the assertion below passes over a
        // null match if the declaration is renamed.
        expect(m).not.toBeNull();
        expect(m?.[1]).toBe(ZARNOBORSA_SOURCE);
    });

    it('the resolver looks for the МЗХ key the ingest WRITES too (#3136)', () => {
        // Second key, identical exposure: the ingest would keep writing under
        // one spelling while the resolver looked for another, the prices would
        // still show in «Тенденции», and the reference would quietly stay on
        // the EC average.
        const trends = read('src/app-layer/usecases/trends.ts');
        const m = /const SOURCE_MZH = '([^']+)';/.exec(trends);
        expect(m).not.toBeNull();
        expect(m?.[1]).toBe(MZH_SOURCE);
    });

    it('both are actually USED in the benchmark query and the rank', () => {
        // A constant that agrees and is unreferenced would satisfy the checks
        // above while the resolver still ignored the feed.
        //
        // The FILTER is asserted separately from the RANK because they fail
        // differently, and the filter is the half that hides: a source absent
        // from `in: [...]` is never SELECTED, so it is invisible to the
        // resolver rather than merely outranked — and #3136 shipped its first
        // version with the rank and without the filter.
        const trends = read('src/app-layer/usecases/trends.ts');
        const filter = /source:\s*\{\s*\n?\s*in:\s*\[([^\]]+)\]/.exec(trends);
        expect(filter).not.toBeNull();
        // Matched against the extracted list rather than a formatted literal:
        // the previous needle was `'source: { in: [SOURCE_ZARNOBORSA,'`, which
        // a line wrap broke while the code stayed correct.
        expect(filter?.[1]).toContain('SOURCE_ZARNOBORSA');
        expect(filter?.[1]).toContain('SOURCE_MZH');
        expect(trends).toMatch(/if \(source === SOURCE_ZARNOBORSA\) return 0;/);
        expect(trends).toMatch(/if \(source === SOURCE_MZH\) return 1;/);
        // The ORDER the owner ruled: ZarnoBorsa, then МЗХ, then EC. Asserted
        // as the numbers rather than as text, so a renumbering that put EC
        // above МЗХ fails here.
        expect(trends).toMatch(/if \(source === SOURCE_EC_AGRIFOOD\) return 2;/);
    });

    it('the extractor inlines the SAME paywall marker it exports', () => {
        const extract = read('src/lib/market/zarnoborsa-extract.ts');
        // The inlined copy inside `isZarnoBorsaLocked`, which must equal the
        // exported constant the fixtures assert against.
        const m = /const marker = '([^']+)';/.exec(extract);
        expect(m).not.toBeNull();
        expect(m?.[1]).toBe(ZARNOBORSA_LOCKED_MARKER);
    });

    it('`isZarnoBorsaLocked` references NO module-scope binding', () => {
        // The rule the module docblock states and that function once broke.
        // It is stringified into the page, so any module-scope name is a
        // ReferenceError there — and the caller's fail-safe turned that into a
        // false paywall for a whole run.
        /*
         * COMMENTS STRIPPED FIRST, and the first version of this test failed
         * on its own docblock: the function explains that it *used* to
         * reference the constant, and a raw match reads that explanation as
         * the defect. A comment hit almost always means the pattern was
         * REMOVED — which is exactly backwards from what the guard is for.
         */
        const extract = blankNonCode(read('src/lib/market/zarnoborsa-extract.ts'));
        const start = extract.indexOf('export function isZarnoBorsaLocked');
        expect(start).toBeGreaterThan(-1);
        const body = extract.slice(start, extract.indexOf('\n}', start));
        // The control: the body must still contain the inlined literal, or
        // this is passing over an empty extraction.
        expect(body).toContain('const marker =');
        expect(body).not.toContain('ZARNOBORSA_LOCKED_MARKER');
    });
});
