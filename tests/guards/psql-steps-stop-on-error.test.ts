/**
 * Every `psql` invocation in a workflow must stop on the first error — #2920.
 *
 * ## The defect
 *
 * `psql` exits **0** when a statement in a heredoc fails. It prints the error
 * on stderr, carries on to the next statement, and reports success — so the
 * step goes GREEN and the damage surfaces somewhere else entirely.
 *
 * It cost two load-test runs (42576945583, 42578066347): an `INSERT` named an
 * `id` column that does not exist, the statement errored, the step went green,
 * and the run failed 404 three steps later on a flag nobody had written — with
 * a whole dispatch spent diagnosing a Redis cache that was never involved.
 *
 * The one that would hurt most has not fired yet: four copies of the RLS role
 * bootstrap in `ci.yml` each `CREATE ROLE app_user` and `GRANT`. A failed
 * GRANT there exits 0, and the consequence is not a later migration error — it
 * is RLS policies attaching to nothing, so a suite passes **because** the
 * isolation it asserts was never installed. The green run is then the evidence
 * somebody would cite.
 *
 * ## Why a guard and not 13 edits
 *
 * Nothing distinguishes a step carrying the flag from one without it until a
 * statement fails, so the 14th invocation silently escapes a manual sweep.
 * This derives the population from the workflow files, so a new `psql` step is
 * covered the moment it exists.
 *
 * ## It must not count PROSE
 *
 * Measured the hard way while writing the fix: a regex over `psql ` rewrote
 * the sentence "psql exits 0 on a failed statement" into "psql
 * -v ON_ERROR_STOP=1 exits 0 on a failed statement", inverting a comment that
 * explains the very defect. So comment lines are dropped before matching, and
 * a case below proves a commented invocation is NOT counted — otherwise this
 * guard would be satisfied by a workflow that only *talks* about the flag.
 *
 * ## Why it does NOT route through the shared comment-blanking helper
 *
 * Registered in `SUBJECT_IS_NOT_BLANKABLE` (#1774), and the reason was found
 * by converting it and measuring rather than argued: the subject is YAML,
 * where a comment is `#`, and `tests/helpers/blank-non-code.ts` implements
 * JS/TS comment syntax only. Run over `load-test.yml` it leaves all 156 `#`
 * lines byte-identical. So routing through it would strip nothing while making
 * this guard LOOK like it had comment coverage — worse than handling `#` here,
 * which is what the line filter above does and what the detector cases below
 * prove.
 *
 * The helper is named by PATH rather than by symbol on purpose, and it is a
 * wart: `findSourceTextScanners` exempts any guard whose RAW text contains the
 * symbol, checked before it blanks anything, so merely explaining the helper
 * in a docblock makes a guard invisible to it. Five guards currently sit in
 * that position. Raised separately; writing the path keeps this one visible to
 * the detector that is supposed to police it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectTrackedFiles } from '../helpers/collect-files';

/**
 * `psql` invocations on CODE lines, with where they are.
 *
 * The population comes from `collectTrackedFiles`, not a hand-rolled
 * `readdirSync`: it refuses an empty result, so a renamed directory names
 * itself instead of contributing zero invocations and passing. That is the
 * same failure this guard's subject matter is about, which is why the floor is
 * structural rather than an assertion I remembered to write.
 */
function invocations(): { file: string; line: number; text: string }[] {
    const out: { file: string; line: number; text: string }[] = [];
    for (const abs of collectTrackedFiles({
        roots: ['.github/workflows'],
        extensions: ['.yml'],
        floor: 10,
    })) {
        const rel = path.basename(abs);
        fs.readFileSync(abs, 'utf8').split('\n').forEach((text, i) => {
            // A comment line is prose. See the docblock — a bare match here
            // once rewrote an explanation into its own opposite.
            if (text.trimStart().startsWith('#')) return;
            if (/\bpsql\s+[-\w]/.test(text)) out.push({ file: rel, line: i + 1, text });
        });
    }
    return out;
}

const ALL = invocations();

describe('psql steps stop on the first error (#2920)', () => {
    it('the derivation found invocations at all', () => {
        // The floor. An extraction that stopped matching would compare an
        // empty set against a rule and pass — which is the shape this guard's
        // own subject matter is about, one level up.
        expect(ALL.length).toBeGreaterThan(10);
        console.log(
            `[psql-on-error-stop] ${ALL.length} psql invocation(s) across `
            + `${new Set(ALL.map((i) => i.file)).size} workflow file(s)`,
        );
    });

    it('every invocation passes -v ON_ERROR_STOP=1', () => {
        const offenders = ALL.filter((i) => !i.text.includes('ON_ERROR_STOP=1'))
            .map((i) => `${i.file}:${i.line}`);
        expect(offenders).toEqual([]);
    });

    it('the flag is passed to psql, not merely present on the line', () => {
        // `PGPASSWORD=… psql -v ON_ERROR_STOP=1 -h …`: the flag has to be an
        // argument of psql. A value that happened to contain the string, or a
        // flag on a later pipeline stage, would satisfy a substring check
        // while psql still swallowed its errors.
        const misplaced = ALL
            .filter((i) => !/\bpsql\s+(?:[-\w=]+\s+)*?-v\s+ON_ERROR_STOP=1\b/.test(i.text))
            .map((i) => `${i.file}:${i.line}`);
        expect(misplaced).toEqual([]);
    });

    describe('the detector itself', () => {
        it('counts a real invocation', () => {
            const probe = ['          PGPASSWORD=x psql -h localhost -U ci -d db <<SQL'];
            expect(probe.filter((t) => /\bpsql\s+[-\w]/.test(t.trimStart()))).toHaveLength(1);
        });

        it('does NOT count a commented one', () => {
            // The control that makes the comment-stripping load-bearing: a
            // workflow discussing `psql -h …` in prose must not be read as an
            // invocation, or this guard passes on talk.
            const probe = '          # psql -h localhost would swallow the error here';
            const isCode = !probe.trimStart().startsWith('#') && /\bpsql\s+[-\w]/.test(probe);
            expect(isCode).toBe(false);
        });

        it('rejects a flag that is not psql’s own argument', () => {
            const sneaky = '          psql -h localhost -d db | grep ON_ERROR_STOP=1';
            expect(/\bpsql\s+(?:[-\w=]+\s+)*?-v\s+ON_ERROR_STOP=1\b/.test(sneaky)).toBe(false);
        });
    });
});
