/**
 * A unit suite that reaches Postgres is a unit suite whose timing belongs to
 * the machine — #2803.
 *
 * `runToolLoop` AWAITS `recordStageTiming`, which INSERTS a row. Awaited
 * deliberately: an un-awaited rejection is an unhandled rejection that kills a
 * jest worker. The consequence nobody accounted for is that a unit suite's
 * context names a tenant that exists in no database, so the insert is a real
 * round trip that violates an FK — and the store is best-effort by design, so
 * it logs and SWALLOWS. Nothing fails. That is why it stayed invisible until
 * the suite started flaking.
 *
 * Measured before the fix: 27 FK-failure log lines from the tool-loop suite
 * alone, one of its tests taking 659ms, and 12 more from two further suites
 * #2803 never named. The suite's own assertions are about time — "two tools in
 * one round OVERLAP", "the reported stages add up to the total" — against
 * budgets in tens of milliseconds, so a 541ms excursion is enough to invert
 * them. It failed roughly one run in two under full-root parallelism and
 * passed alone, which is the signature of exactly this.
 *
 * ## What this guard checks, and what it cannot
 *
 * It asserts that every unit suite reaching the tool loop or the assistant
 * stream route MOCKS the stage-timing store. It is a source-text check and
 * contributes no runtime coverage, so it cannot tell you the mock APPLIED —
 * `assistant-tool-loop.test.ts` carries an executing control for that, which
 * asserts the double was called and fails if jest ever hands back the real
 * module.
 *
 * The population is DERIVED from the filesystem rather than listed, so a
 * fourth suite that exercises the loop is covered the moment it exists. It
 * prints its denominator, because a guard whose population silently shrinks to
 * zero passes forever.
 */

import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** The store whose write is the defect. */
const STORE = '@/app-layer/ai/assistant/stage-timing-store';

/**
 * Anything that reaches `runToolLoop`, directly or through the stream route
 * that calls it. Spelled as several needles because a suite may exercise the
 * loop without naming it — the route is the indirect path.
 */
const REACHES_THE_LOOP = [/\brunToolLoop\b/, /assistant\/stream/, /\bstreamAssistant\b/];

/**
 * A suite that reaches the loop but must NOT mock the store — e.g. one whose
 * subject IS the store's write behaviour. Empty today; an entry needs a
 * written reason, and the no-stale test below removes its cover once the file
 * stops reaching the loop.
 */
const MUST_NOT_MOCK: Readonly<Record<string, string>> = {};

const rel = (p: string) => path.relative(REPO_ROOT, p);

/**
 * `collectSourceFiles` rather than a hand-rolled walk, deliberately: it THROWS
 * on an empty result, and #865 measured 47 of 58 auditable guards dead on
 * exactly that defect — 37 of them the same hand-rolled `walk`, gutable to
 * `return []` with every assertion still green. The register in
 * `file-collection-is-not-silently-empty.test.ts` may only SHRINK, so a new
 * collector uses the helper instead of being listed.
 */
const ALL_UNIT_SUITES = collectSourceFiles({
    roots: ['tests/unit'],
    exclude: (r) => !(r.endsWith('.test.ts') || r.endsWith('.test.tsx')),
    floor: 200,
});

describe('unit suites do not write stage timings to the database', () => {
    const all = ALL_UNIT_SUITES;
    const reaching = all.filter((p) => {
        const src = fs.readFileSync(p, 'utf8');
        return REACHES_THE_LOOP.some((re) => re.test(src));
    });

    it('[stage-timing-unit-mocks] prints the denominator', () => {
        // A floor, not just a print: an extraction that stopped matching would
        // select zero files and satisfy every assertion below over nothing.
        expect(all.length).toBeGreaterThan(200);
        expect(reaching.length).toBeGreaterThanOrEqual(3);
        // No eslint-disable: `no-console` does not apply under tests/, so a
        // directive here is UNUSED — and an unused directive is itself a lint
        // finding. `no-untyped-rls-bypass` and `social-routes-flag-gated` both
        // record this, and I added the directive anyway before checking; that
        // makes three.
        console.log(
            `[stage-timing-unit-mocks] ${all.length} unit suite(s) scanned; `
                + `${reaching.length} reach the tool loop; `
                + `${Object.keys(MUST_NOT_MOCK).length} exempt`,
        );
    });

    /**
     * The control for `rel()`, demanded by `scripts/selector-teeth.mjs` and
     * right to demand it.
     *
     * `rel()` is only reached when there IS a violation or an exemption, and
     * today there is neither — so gutting it to `''` / `[]` / `null` left this
     * whole guard green. That is the #1454 shape: a dead selector merged with
     * the required set passing. The harness found it on the first run.
     *
     * So this exercises the selector against the population the guard actually
     * scans, which is the only thing that can tell a working selector from one
     * that happens never to be called.
     */
    it('rel() maps the real population to repo-relative paths', () => {
        const rels = reaching.map(rel);
        expect(rels).toContain('tests/unit/ai/assistant-tool-loop.test.ts');
        expect(rels).toContain('tests/unit/ai/assistant-stream-route.test.ts');
        // Repo-relative, not absolute: the exemption map is keyed on these, so
        // an absolute path would make every key miss and every exemption
        // silently inert.
        for (const r of rels) {
            expect(path.isAbsolute(r)).toBe(false);
            expect(r.startsWith('tests/unit/')).toBe(true);
        }
    });

    it('every unit suite reaching the tool loop mocks the stage-timing store', () => {
        const unmocked = reaching
            .filter((p) => !(rel(p) in MUST_NOT_MOCK))
            .filter((p) => !fs.readFileSync(p, 'utf8').includes(STORE));
        expect(unmocked.map(rel)).toEqual([]);
    });

    it('no stale exemption', () => {
        const stale = Object.keys(MUST_NOT_MOCK).filter(
            (k) => !reaching.some((p) => rel(p) === k),
        );
        expect(stale).toEqual([]);
    });

    /**
     * The detector's own proof. Both populations are compliant today, so
     * without this the suite above would pass whether or not it can see
     * anything — the `a-gate-narrow-enough-to-always-pass` shape.
     */
    it('detects a suite that reaches the loop and does NOT mock the store', () => {
        const compliant = 'await runToolLoop(x);\njest.mock(\'' + STORE + '\', () => ({}));';
        const violating = 'await runToolLoop(x);\n// no mock here';
        const reaches = (s: string) => REACHES_THE_LOOP.some((re) => re.test(s));
        const mocks = (s: string) => s.includes(STORE);

        expect(reaches(compliant) && !mocks(compliant)).toBe(false);
        expect(reaches(violating) && !mocks(violating)).toBe(true);
        // and a suite that touches neither is simply out of the population
        expect(reaches('expect(1).toBe(1);')).toBe(false);
    });
});
