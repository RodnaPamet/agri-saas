/**
 * A guard whose only claims about a file's text are NEGATIONS — #2558.
 *
 * Such a guard passes when the read returns nothing. #2507 fixed six, one
 * inert on main for 82 days, and nothing stopped a seventh arriving. This is
 * the seventh's gate.
 *
 * ## A CEILING, not a presence check
 *
 * "N files carry a negated read with no presence claim; the cap is N." A
 * presence check would be satisfied by adding an unrelated `toContain`, which
 * is `a-gate-narrow-enough-to-always-pass` one level up. The cap starts at
 * ZERO because #2507 cleared the population — the strongest starting point,
 * and the one that most needs the control below, since an absence asserted
 * over a clean tree is satisfied perfectly by a detector that has stopped
 * matching.
 *
 * ## Why the detector is an AST walk
 *
 * The pattern version was not gate-worthy and #2558 records why: its control
 * matcher `/expect\([^)]*\)\.toMatch\(/` could not cross a nested paren, so
 * `expect(fn(x)).toMatch(…)` never matched and three SOUND guards were
 * reported as broken. Fixing that one character class moved the count from 6
 * to 0. The failure direction is the bad one for a ratchet — healthy guards
 * accused — which is how a cap gets baselined or deleted instead of obeyed.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { assessSource, isAtRisk } from '../helpers/vacuous-negation';

const ROOT = path.resolve(__dirname, '../..');
const CONTROL = 'tests/fixtures/vacuous-negation-control.ts.fixture';

/**
 * The cap. ZERO, and it may only go DOWN.
 *
 * Raising it means a new guard asserts only absences about a file it reads,
 * which is the defect. The remedy set is settled by #2507: a presence claim on
 * the same read, a denominator where the read feeds a loop, or nothing where a
 * sibling already fails on empty.
 */
const AT_RISK_CAP = 0;

/**
 * Guards the detector reports that are SOUND, with the reason each is sound.
 *
 * Not a baseline. #2558 is explicit that a detector which falsely accuses gets
 * "baselined or deleted rather than obeyed", so an entry here is a statement
 * about why the detector cannot see a control that exists — and each was found
 * by reading the guard, not by watching the count.
 *
 * It is a SET and the cap above is separate, so a genuinely at-risk file
 * cannot be hidden by adding its name here: it would still have to be removed
 * from the reported set by hand, in a diff a reviewer sees.
 */
const SOUND_DESPITE_REPORT: ReadonlyArray<{ file: string; why: string }> = [
    {
        file: 'tests/guards/i18n-coverage.test.ts',
        why:
            'its `baseline` IS read-derived and `expect(baseline.length)'
            + '.toBeLessThanOrEqual(CEILING)` is a ceiling rather than a '
            + 'denominator, so an emptied baseline satisfies both of its own '
            + 'assertions. A SIBLING catches it: `added = offenders.filter((f) '
            + '=> !baselineSet.has(f))` fails when the baseline empties, '
            + 'because `offenders` comes from a floored scan and every offender '
            + 'then reads as NEW. That is #2507\'s third remedy — "nothing '
            + 'where a sibling already fails on empty" — and this detector '
            + 'cannot see it, because the protecting assertion is itself a '
            + 'negation over a DIFFERENT population. Reasoning about which '
            + 'population a negation protects is beyond an AST walk over one '
            + 'file and is not attempted.',
    },
];

const guardFiles = (): string[] =>
    collectSourceFiles({
        roots: ['tests/guards', 'tests/guardrails'],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('.test.ts'),
        floor: 300,
    });

describe('a negated claim about a file read needs a control (#2558)', () => {
    describe('the detector, proved in BOTH directions against a fixture', () => {
        // Read off disk rather than inlined: a detector proved against a
        // string literal in its own test is proved against the test author's
        // idea of the shape, not against a file the walker had to parse.
        const text = readFileSync(path.join(ROOT, CONTROL), 'utf8');

        it('reports the shapes that are vacuity-capable', () => {
            // Scoped per exported function so one fixture carries both
            // verdicts — the file as a whole has presence claims in it.
            for (const name of ['reportMe_allNegated', 'reportMe_viaLocals']) {
                const block = extract(text, name);
                const v = assessSource(`${name}.ts`, block);
                expect({ name, negated: v.negated > 0, presence: v.presence }).toEqual({
                    name,
                    negated: true,
                    presence: 0,
                });
                expect({ name, atRisk: isAtRisk(v) }).toEqual({ name, atRisk: true });
            }
        });

        it('does NOT report a sound guard — the half that makes the cap usable', () => {
            // Every one of these is a shape the pattern version falsely
            // accused, or a remedy #2507 prescribes.
            for (const name of [
                'passMe_hasPresenceClaim',
                'passMe_presenceThroughNestedCall',
                'passMe_positivePatternIsTrue',
                'passMe_predicateOverSuppliedInput',
                'passMe_hasDenominator',
            ]) {
                const block = extract(text, name);
                const v = assessSource(`${name}.ts`, block);
                expect({ name, atRisk: isAtRisk(v) }).toEqual({ name, atRisk: false });
            }
        });

        it('the fixture still carries every named block — the extraction control', () => {
            // `extract` returning '' would make every assertion above pass
            // over nothing: an empty source has no assertions, so `negated` is
            // 0 and `isAtRisk` is false. That satisfies the PASS cases
            // perfectly, which is why this is asserted rather than assumed.
            for (const name of [
                'reportMe_allNegated',
                'reportMe_viaLocals',
                'passMe_hasPresenceClaim',
                'passMe_presenceThroughNestedCall',
                'passMe_positivePatternIsTrue',
                'passMe_predicateOverSuppliedInput',
                'passMe_hasDenominator',
            ]) {
                expect({ name, found: extract(text, name).includes('expect(') }).toEqual({
                    name,
                    found: true,
                });
            }
        });
    });

    it('no guard asserts only absences about a file it reads', () => {
        const files = guardFiles();
        const atRisk = files
            .map((abs) => assessSource(path.relative(ROOT, abs), readFileSync(abs, 'utf8')))
            .filter(isAtRisk)
            .map((v) => v.scope)
            .sort();

        const exempt = new Set(SOUND_DESPITE_REPORT.map((e) => e.file));
        const unexplained = atRisk.filter((f) => !exempt.has(f));

        console.log(
            `[negated-reads] ${files.length} guard file(s) walked; `
            + `${atRisk.length} report, ${exempt.size} explained as sound, `
            + `${unexplained.length} unexplained (cap ${AT_RISK_CAP})`,
        );
        // Named, so a breach says WHICH file rather than a count.
        expect(unexplained).toEqual([]);
        expect(unexplained.length).toBeLessThanOrEqual(AT_RISK_CAP);

        // No STALE exemption: an entry whose file the detector no longer
        // reports is an excuse that outlived its target, and would otherwise
        // sit here making the set look considered.
        const reported = new Set(atRisk);
        expect(
            SOUND_DESPITE_REPORT.filter((e) => !reported.has(e.file)).map((e) => e.file),
        ).toEqual([]);
        // And every reason must actually say something.
        for (const e of SOUND_DESPITE_REPORT) {
            expect({ file: e.file, long: e.why.length > 80 }).toEqual({
                file: e.file,
                long: true,
            });
        }
    });
});

/**
 * One exported function's body, by name.
 *
 * Brace-counted from the signature rather than regex-sliced: the bodies
 * contain `}` inside regex literals and object arguments, and a non-greedy
 * match to the first `}` would truncate them into something with no
 * assertions — which every PASS case above would then satisfy.
 */
function extract(text: string, name: string): string {
    const start = text.indexOf(`export function ${name}(`);
    if (start < 0) return '';
    let depth = 0;
    let seen = false;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') {
            depth += 1;
            seen = true;
        } else if (text[i] === '}') {
            depth -= 1;
            if (seen && depth === 0) return text.slice(start, i + 1);
        }
    }
    return '';
}
