/**
 * The denominator reporter is EXECUTED, not asserted about (#1879).
 *
 * It exists because jest's default reporter drops `console.log` entirely once
 * a run has more than one suite — measured: 1 suite prints, 2 suites print
 * nothing, `--verbose` restores it — and CI shards the whole tree with no
 * `--verbose`. So 34 guards printed their population to nobody.
 *
 * A guard asserting "jest.config.js names this reporter" would prove the
 * wiring and nothing about the extraction, which is the half that goes stale:
 * the matcher is pinned to a line format the guards happen to use today, and
 * `a-needle-loses-the-thread-at-a-rename` is exactly this shape — a collector
 * that stops matching reports a clean, empty result. So the extraction and the
 * formatting are driven here with real console buffers.
 *
 * The wiring half is two assertions at the end, because without them the
 * extraction is correct and never runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../../helpers/collect-files';

const reporter = require(join(REPO_ROOT, 'tests/reporters/denominator-summary.cjs')) as {
    extractDenominators: (buffer: unknown) => string[];
    formatSummary: (lines: string[], label?: string) => string;
};

const { extractDenominators, formatSummary } = reporter;

describe('extractDenominators', () => {
    it('collects the shape the guards actually emit', () => {
        // Copied verbatim from three live guards, so a format change in any of
        // them fails here rather than silently emptying the summary.
        const buffer = [
            { message: '[audit-details] 2189 src files, 220 logEvent calls scanned, 0 finding(s)' },
            { message: '[persisted-etag] 7 allowlisted path(s): /journal, /farm-tasks' },
            { message: '[guards-blank-comments] 750 guard files; 457 read src text without blanking' },
        ];
        expect(extractDenominators(buffer)).toEqual([
            '[audit-details] 2189 src files, 220 logEvent calls scanned, 0 finding(s)',
            '[persisted-etag] 7 allowlisted path(s): /journal, /farm-tasks',
            '[guards-blank-comments] 750 guard files; 457 read src text without blanking',
        ]);
    });

    it('splits a multi-line console.log, because guards write them', () => {
        // Several guards build a multi-line string and log it once. Treating a
        // buffer entry as one line would drop all but the first.
        const out = extractDenominators([
            { message: 'preamble\n[one] 1 thing\nmiddle\n[two] 2 things' },
        ]);
        expect(out).toEqual(['[one] 1 thing', '[two] 2 things']);
    });

    it('ignores prose, so the summary is not a second test log', () => {
        expect(extractDenominators([
            { message: 'Warning: something happened' },
            { message: 'see [the docs] for more' },
            { message: '[Not-Kebab] shouting' },
            { message: '[]' },
            { message: '[tag]' },
        ])).toEqual([]);
    });

    it('survives a malformed buffer rather than throwing', () => {
        // A reporter that throws fails the jest process, which would turn
        // instrumentation into a CI outage — the #1269 shape.
        for (const bad of [undefined, null, 'string', 42, {}, [null], [{}]]) {
            expect(() => extractDenominators(bad)).not.toThrow();
        }
        expect(extractDenominators([{ message: 7 }])).toEqual([]);
    });
});

describe('formatSummary', () => {
    it('says NOTHING when nothing was collected', () => {
        // Deliberately '' and not an empty heading. A "Guard denominators"
        // section with no rows reads as "the guards found nothing", which is
        // the opposite of what an empty collection means — nothing was
        // COLLECTED.
        expect(formatSummary([])).toBe('');
        expect(formatSummary([], 'shard 1/6')).toBe('');
    });

    it('de-duplicates and sorts, so repeats do not read as separate readings', () => {
        const out = formatSummary(['[b] two', '[a] one', '[a] one']);
        expect(out).toContain('2 reading(s)');
        expect(out.indexOf('[a] one')).toBeLessThan(out.indexOf('[b] two'));
        expect(out.match(/\[a\] one/g)).toHaveLength(1);
    });

    it('names the shard when given a label', () => {
        expect(formatSummary(['[a] 1'], 'shard 3/6')).toContain('### Guard denominators — shard 3/6');
        expect(formatSummary(['[a] 1'])).toContain('### Guard denominators');
    });

    it('fences the readings, so a reading containing markdown cannot reflow it', () => {
        const out = formatSummary(['[a] 5 * 3 _things_ | and | pipes']);
        expect(out).toContain('```');
        expect(out).toContain('[a] 5 * 3 _things_ | and | pipes');
    });
});

describe('the wiring', () => {
    it('jest names the reporter at the TOP level, alongside the default', () => {
        // Extraction that is never invoked is worth nothing, and this is the
        // only place that pairing is checked. Top-level because jest refuses
        // `reporters` in a `projects:` entry; 'default' explicitly because
        // naming any reporter REPLACES the default set, and losing the test
        // output to gain the denominators would be a worse #1879.
        const cfg = readFileSync(join(REPO_ROOT, 'jest.config.js'), 'utf8');
        expect(cfg).toMatch(
            /reporters:\s*\[\s*'default',\s*'<rootDir>\/tests\/reporters\/denominator-summary\.cjs'\s*\]/,
        );
    });

    it('CI labels the section with its shard', () => {
        // Six shards each write their own section into their own job summary.
        // Unlabelled, six partial populations invite being read as one.
        const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
        expect(ci).toContain('DENOMINATOR_SUMMARY_LABEL:');
    });
});
