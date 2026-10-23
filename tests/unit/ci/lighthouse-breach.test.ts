/**
 * Executes `scripts/ci/lighthouse-breach.mjs` against real lhci log text — #2207.
 *
 * Spawned rather than imported, following `lighthouse-median.test.ts`: the CLI
 * surface is part of what is being tested — argv handling, the exit code, and
 * the `::error::`/`::warning::` annotations GitHub actually renders. An import
 * exercises none of it, and the exit code is the property that matters most
 * here (see "never decides the job" below).
 *
 * ## The fixtures carry real ANSI escapes
 *
 * lhci colourises its assertion table, and the escape codes sit BETWEEN the
 * words the parser matches — `ESC[1mlargest-contentful-paint ESC[0m failure
 * for`. A fixture written in plain text would test a parser against input that
 * never occurs and pass while the real thing found nothing. That is not
 * hypothetical: the first version of this script was tried against a real
 * downloaded log and printed its "format may have changed" warning, because
 * `gh api .../logs` also prefixes every line with a timestamp.
 *
 * So `ESC` below is a real escape character, and one test asserts the fixture
 * contains it — a positive control over the fixture itself.
 *
 * ## Never decides the job
 *
 * This runs INSIDE the gate's failure branch, after the budget has already
 * failed. The gate's own `exit "$status"` is what reddens the job. A reporter
 * that could exit non-zero would be able to turn an unrelated outcome red, and
 * one that could crash would mask the failure it exists to explain — which is
 * why every path is asserted to exit 0, including the missing-log path.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/ci/lighthouse-breach.mjs');

/**
 * A real ANSI escape, as lhci emits — written as the `\u001b` ESCAPE
 * SEQUENCE and never as a literal byte. A control character in a source
 * file is invisible in every diff, review and grep that would otherwise
 * catch it, and one landed in this script's own strip regex while it was
 * being written: the regex then matched nothing and the parse failed on
 * the first real log it was given.
 */
const ESC = '\u001b';
const c = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;

const files: string[] = [];
afterAll(() => files.forEach((f) => fs.rmSync(f, { force: true })));

function writeLog(body: string): string {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lhbreach-')), 'lhci.log');
    files.push(f);
    fs.writeFileSync(f, body);
    return f;
}

function run(logPath?: string) {
    const r = spawnSync('node', logPath === undefined ? [SCRIPT] : [SCRIPT, logPath], {
        encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * The real failing block from run 40032647592 — `/f/lighthouse` on
 * 2026-10-23 — colourised the way lhci colourises it.
 */
function lcpBlock(values: number[], found: number, bound = 3800): string {
    return [
        'Checking assertions against 1 URL(s), 5 total run(s)',
        '',
        '1 result(s) for http://localhost:3006/f/lighthouse :',
        '',
        `  ${c('31', 'X')}  ${c('1', 'largest-contentful-paint')} failure for ${c('1', 'maxNumericValue')} assertion`,
        '       Largest Contentful Paint',
        '       https://developer.chrome.com/docs/lighthouse/performance/',
        '',
        `        expected: ${c('32', `<=${bound}`)}`,
        `           found: ${c('31', String(found))}`,
        `      ${c('2', `all values: ${values.join(', ')}`)}`,
        '',
        'Assertion failed. Exiting with status code 1.',
    ].join('\n');
}

const REAL_VALUES = [2066.278, 4105.168, 4121.923, 4124.123, 4281.702];

describe('lighthouse-breach (#2207)', () => {
    it('the fixture really is colourised — the positive control', () => {
        // Without this, every assertion below could be passing against plain
        // text that the script will never be handed. The parser's whole job is
        // to see through the escapes.
        const body = lcpBlock(REAL_VALUES, 4121.923);
        expect(body).toContain(ESC);
        expect(body).toContain(`${ESC}[1mlargest-contentful-paint${ESC}[0m`);
        // And the metric name is NOT matchable without stripping them.
        expect(body).not.toContain(' largest-contentful-paint failure for');
    });

    it('names the metric, the measurement, the bound and the breach', () => {
        const { code, out } = run(writeLog(lcpBlock(REAL_VALUES, 4121.923)));
        expect(code).toBe(0);
        expect(out).toContain('::error::');
        expect(out).toContain('largest-contentful-paint');
        expect(out).toContain('4122 ms');
        expect(out).toContain('bound <=3800 ms');
        expect(out).toContain('over by 322 ms');
    });

    it('reports the run-to-run spread and the range it came from', () => {
        const { out } = run(writeLog(lcpBlock(REAL_VALUES, 4121.923)));
        // 4281.702 - 2066.278 = 2215.424
        expect(out).toContain('5-run spread 2215 ms');
        expect(out).toContain('(2066-4282 ms)');
    });

    it('says the run cannot separate a regression when the spread dominates', () => {
        // The sentence the whole issue is about. 2215 / 322 = 6.9.
        const { out } = run(writeLog(lcpBlock(REAL_VALUES, 4121.923)));
        expect(out).toContain('6.9x the breach');
        expect(out).toContain('cannot separate a regression from instrument noise');
    });

    it('says the opposite when the breach is larger than the spread', () => {
        // A real regression must NOT be excused by this script. Tight values,
        // far over the bound: 5050 vs 3800 with a 40 ms spread.
        const tight = [5030, 5040, 5050, 5060, 5070];
        const { out } = run(writeLog(lcpBlock(tight, 5050)));
        expect(out).toContain('over by 1250 ms');
        expect(out).toContain("larger than this page's measured run-to-run variation");
        expect(out).not.toContain('instrument noise');
    });

    it('makes no spread claim from a single sample', () => {
        // `0 ms` here would read as "the runs agreed", which one run cannot say.
        const { out } = run(writeLog(lcpBlock([4121.923], 4121.923)));
        expect(out).toContain('over by 322 ms');
        expect(out).not.toContain('spread');
    });

    it('formats a unitless metric as a ratio, not as milliseconds', () => {
        const body = [
            'Checking assertions against 1 URL(s), 5 total run(s)',
            `  ${c('31', 'X')}  ${c('1', 'cumulative-layout-shift')} failure for ${c('1', 'maxNumericValue')} assertion`,
            `        expected: ${c('32', '<=0.1')}`,
            `           found: ${c('31', '0.254')}`,
            `      ${c('2', 'all values: 0.25, 0.252, 0.254, 0.255, 0.256')}`,
        ].join('\n');
        const { out } = run(writeLog(body));
        expect(out).toContain('0.254 vs bound <=0.100');
        expect(out).toContain('over by 0.154');
        expect(out).not.toContain('0.254 ms');
    });

    it('reads a log downloaded from the API, timestamps and all', () => {
        // `gh api .../actions/jobs/<id>/logs` prefixes every line with an
        // ISO-8601 timestamp. That is how a human re-runs this against a past
        // failure, and it is the input the first version silently failed on.
        const stamped = lcpBlock(REAL_VALUES, 4121.923)
            .split('\n')
            .map((l, i) => `2026-10-23T22:23:${String(10 + i).padStart(2, '0')}.2531386Z ${l}`)
            .join('\n');
        const { out } = run(writeLog(stamped));
        expect(out).toContain('::error::');
        expect(out).toContain('5-run spread 2215 ms');
    });

    it('reports EVERY breached metric, not just the first', () => {
        const body = [
            lcpBlock(REAL_VALUES, 4121.923),
            `  ${c('31', 'X')}  ${c('1', 'total-blocking-time')} failure for ${c('1', 'maxNumericValue')} assertion`,
            `        expected: ${c('32', '<=2000')}`,
            `           found: ${c('31', '2600')}`,
            `      ${c('2', 'all values: 2400, 2500, 2600, 2700, 2800')}`,
        ].join('\n');
        const { out } = run(writeLog(body));
        expect(out).toContain('largest-contentful-paint');
        expect(out).toContain('total-blocking-time');
        expect((out.match(/::error::/g) ?? []).length).toBe(2);
    });

    it('warns, and exits 0, when the log holds a table it cannot parse', () => {
        // Format drift must be loud. A reporter that printed nothing here
        // would leave the gate's bare verdict standing and look like it had
        // nothing to add — the silence-reads-as-success shape.
        const { code, out } = run(
            writeLog('Checking assertions against 1 URL(s), 5 total run(s)\nall fine here\n'),
        );
        expect(code).toBe(0);
        expect(out).toContain('::warning::');
        expect(out).toContain('the format may have changed');
        expect(out).not.toContain('::error::');
    });

    it('warns, and exits 0, when there is no log at all', () => {
        const { code, out } = run('/nonexistent/lhci.log');
        expect(code).toBe(0);
        expect(out).toContain('::warning::');
        expect(out).toContain('reported without its numbers');
    });

    it('exits 0 with no argument rather than throwing', () => {
        // The gate passes "$log" unquoted-safe, but a future edit that drops
        // the argument must not crash the step it was added to explain.
        const { code, out } = run();
        expect(code).toBe(0);
        expect(out).toContain('::warning::');
    });
});
