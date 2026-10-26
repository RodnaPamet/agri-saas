/**
 * The restore drill targets every stack that HAS a backup, and any stack it
 * does not target is documented as unbacked — #2332.
 *
 * ## The assertion this replaces, and why it could not stay
 *
 * `oi-3-backup-restore` asserted the drill matrix contained both `agrent` and
 * `inflect-compliance`, with the reason: *"Both stacks sat with zero backups
 * until 2026-08-01, and only one of them is built from this repo. Dropping a
 * target here leaves a live database whose backup nobody ever restores."*
 *
 * That reason is still right. The assertion stopped being satisfiable:
 * `inflect-compliance` has had **no backup at all** since 2026-10-12 — zero
 * snapshots, no bucket, no timer (measured 2026-10-25, #2329). A matrix entry
 * for it could only report its own impossibility, monthly, in red, for
 * something this repository cannot fix. And a monthly job that is red for a
 * reason nobody here can act on teaches everyone to ignore it, which costs
 * more than the entry buys.
 *
 * ## So the property is kept in a form that admits the truth
 *
 * Every production stack must be in exactly one of two states, and must not
 * fall out of both:
 *
 *   - **drilled** — the workflow restores its backup and validates it, or
 *   - **declared unbacked** — `docs/backup-restore.md` says so, in prose, so
 *     the absence is a recorded fact rather than a gap in a matrix.
 *
 * A stack in neither is the case the old assertion existed to prevent: a live
 * database silently dropped from the drill. A stack in BOTH is a stale
 * document claiming something is unbacked when it is being drilled.
 *
 * ## The population is DERIVED from the runbook
 *
 * From the stacks table rather than a list here, because a hand-listed set
 * would miss the next stack — which is exactly how the original would have
 * failed, had a third product arrived instead of a second losing its backup.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const RUNBOOK = read('docs/backup-restore.md');
const WORKFLOW = read('.github/workflows/restore-test.yml');
const DRILL = read('infra/scripts/restore-test-dump.sh');

/**
 * Comment lines removed. Every assertion about a script's BEHAVIOUR below
 * reads this, never the raw text — because the script documents each of those
 * behaviours at length, and three mutations survived the first version of this
 * guard by leaving the prose that explains the thing they had deleted.
 *
 * `--exit-on-error` is the clearest case: the flag appears in the code once
 * and in a paragraph about why it is load-bearing once, so removing it from
 * the code left the guard green.
 */
const code = (src: string) =>
    src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');

/**
 * Comment-stripped AND line-continuations joined. A shell invocation routinely
 * spans a `\`-continued line, so a per-line search for two tokens of the same
 * command finds neither together: reformatting the globals restore onto two
 * lines broke the ordering assertion below while the script was correct.
 */
const DRILL_CODE = code(DRILL).replace(/\\\n\s*/g, ' ');

/**
 * The production stacks, read out of the runbook's own "What production
 * actually is" table. Its header row names them as columns:
 *
 *     | | `agrent` | `inflect-compliance` |
 */
function productionStacks(): string[] {
    const header = RUNBOOK.split('\n').find((l) => /^\|\s*\|\s*`/.test(l));
    if (!header) {
        throw new Error(
            'could not find the stacks table in docs/backup-restore.md — its header row '
                + 'starts `| | `name` |`. A renamed table would make this guard range over '
                + 'nothing, which is the same defect it exists to catch.',
        );
    }
    return [...header.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]);
}

const STACKS = productionStacks();

/**
 * Both predicates take their TEXT as a parameter.
 *
 * They used to close over `WORKFLOW` and `RUNBOOK`, which made them impossible
 * to exercise on anything but the repo's current state — and that is how
 * `isDeclaredUnbacked` became a DEAD selector. Since #2367 both stacks are
 * drilled, so no stack is in the unbacked state, and
 * `drilled !== unbacked` evaluates `true !== false` whatever the second
 * predicate returns. `scripts/selector-teeth` reported it gutted to
 * `return false` and SURVIVING; verified before fixing.
 *
 * It would also have stayed quiet: the Selector teeth job audits guard files
 * changed against the PR's base, and a PR cut from current main does not
 * include this file. Found only because a peer's PR was cut from an older base
 * and pulled it into their audit set — which is luck, not process.
 *
 * Taking the text as a parameter lets the controls below feed each predicate
 * the inputs the repo does not currently contain, so both are graded on their
 * own behaviour rather than on today's state.
 */
export const declaresUnbacked = (runbook: string, stack: string): boolean =>
    new RegExp(`^>?\\s*#{0,4}\\s*\`?${stack}\`?\\s+is\\s+(STILL\\s+)?unbacked`, 'im').test(runbook);

export const namesAsTarget = (workflow: string, stack: string): boolean =>
    new RegExp(`Restore Test \\(${stack}\\)|target:\\s*${stack}\\b`).test(workflow);

/** A stack is drilled when the workflow names it as a target. */
const isDrilled = (s: string) => namesAsTarget(WORKFLOW, s);

/**
 * A stack is declared unbacked when the runbook says so about it by name.
 * Matched on a heading rather than anywhere in the file, so a passing mention
 * in the history section cannot be read as the declaration.
 */
const isDeclaredUnbacked = (s: string) => declaresUnbacked(RUNBOOK, s);

describe('both predicates can actually select — the controls (#2365-adjacent)', () => {
    // Synthetic input only. These must keep their teeth when the repo has no
    // unbacked stack left, which is precisely the state that killed the
    // original selector.

    it('declaresUnbacked FIRES on the heading it is written for', () => {
        expect(declaresUnbacked('### `foo` is unbacked', 'foo')).toBe(true);
        // The STILL variant — the exact wording this runbook used for a year.
        expect(declaresUnbacked('> ### `inflect-compliance` is STILL unbacked', 'inflect-compliance')).toBe(true);
        // Backticks optional, blockquote optional, any heading depth.
        expect(declaresUnbacked('#### foo is unbacked', 'foo')).toBe(true);
    });

    it('declaresUnbacked does NOT fire on a passing mention', () => {
        // The whole reason it matches a HEADING. A history section that says
        // the stack WAS unbacked must not read as a live declaration — which
        // is not hypothetical: the runbook now contains exactly such prose.
        expect(declaresUnbacked('It used to be the case that `foo` is unbacked, but no longer.', 'foo')).toBe(false);
        expect(declaresUnbacked('a warning that the sibling stack had no backup at all', 'foo')).toBe(false);
        // And it must be about THIS stack.
        expect(declaresUnbacked('### `bar` is unbacked', 'foo')).toBe(false);
    });

    it('declaresUnbacked reads the real runbook as NOT declaring either stack unbacked', () => {
        // The live assertion, stated positively so the current state is a
        // recorded fact rather than an inference from a passing negation.
        for (const stack of STACKS) {
            expect({ stack, declaredUnbacked: declaresUnbacked(RUNBOOK, stack) })
                .toEqual({ stack, declaredUnbacked: false });
        }
    });

    it('namesAsTarget FIRES on both forms, and not on a near miss', () => {
        expect(namesAsTarget('  - target: agrent', 'agrent')).toBe(true);
        expect(namesAsTarget('name: "Restore Test (agrent)"', 'agrent')).toBe(true);
        expect(namesAsTarget('  - target: inflect-compliance', 'inflect-compliance')).toBe(true);
        // A workflow that mentions the stack in prose but targets nothing.
        expect(namesAsTarget('# agrent is drilled elsewhere', 'agrent')).toBe(false);
        expect(namesAsTarget('', 'agrent')).toBe(false);
    });

    it('a stack in NEITHER state is detectable — the case the pair exists for', () => {
        // The guard's real subject, exercised on synthetic text because the
        // repo cannot currently produce it. Without this, the pair's whole
        // purpose is untested whenever every stack happens to be drilled.
        const workflow = '  - target: agrent';
        const runbook = '### `agrent` is unbacked';
        const orphan = 'ghost-stack';
        expect(namesAsTarget(workflow, orphan)).toBe(false);
        expect(declaresUnbacked(runbook, orphan)).toBe(false);
        // Both false === in neither state === what must fail the live assertion.
        expect(namesAsTarget(workflow, orphan) !== declaresUnbacked(runbook, orphan)).toBe(false);
        // And a stack in BOTH states is equally a failure.
        expect(namesAsTarget('  - target: agrent', 'agrent')).toBe(true);
        expect(declaresUnbacked('### `agrent` is unbacked', 'agrent')).toBe(true);
        expect(namesAsTarget('  - target: agrent', 'agrent') !== declaresUnbacked('### `agrent` is unbacked', 'agrent')).toBe(false);
    });
});

describe('the restore drill targets what exists (#2332)', () => {
    it('[drill-targets] ranges over the real set of stacks', () => {
        console.log(
            `[drill-targets] ${STACKS.length} production stack(s) in docs/backup-restore.md: ${STACKS.join(', ')}`,
        );
        // Two is what the runbook has described throughout. A parse that
        // started matching nothing would make every assertion below pass over
        // an empty set — the shape this guard exists to prevent, one level up.
        expect(STACKS.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * Both predicates were DEAD and `scripts/selector-teeth.mjs` said so —
     * gutted to `return []` they survived every assertion here. Three
     * separate mistakes, worth naming because each is reusable:
     *
     *  1. **The expected side CALLED the selector.**
     *     `drilled: isDrilled(stack)` appeared on both sides of `toEqual`, so
     *     it compared the function to itself and could not fail whatever it
     *     returned. A guard grading its own output grades nothing.
     *
     *  2. **`!==` on values that might be objects is reference inequality.**
     *     With both predicates gutted to `return []`, `[] !== []` is TRUE —
     *     two distinct arrays — so "in exactly one state" passed with both
     *     states meaningless.
     *
     *  3. **`[]` is truthy**, so `STACKS.filter(isDrilled)` kept every stack
     *     and "at least one is drilled" passed over nonsense.
     *
     * The repair is to demand a strict boolean. That one assertion kills every
     * gut the tool tries — `[]`, `''`, `0`, `null`, `undefined`, `new Set()`,
     * `new Map()`, `{}` — because none of them is of type boolean.
     */
    const asState = (v: unknown, what: string): boolean => {
        // Not a cast and not a coercion: a predicate that stopped returning a
        // boolean has stopped being a predicate, and silently treating its
        // return as truthy is how both guts survived.
        expect({ what, type: typeof v }).toEqual({ what, type: 'boolean' });
        return v as boolean;
    };

    it.each(STACKS.map((s) => [s] as const))(
        '%s is either drilled or declared unbacked, never neither',
        (stack) => {
            const drilled = asState(isDrilled(stack), `isDrilled(${stack})`);
            const unbacked = asState(isDeclaredUnbacked(stack), `isDeclaredUnbacked(${stack})`);
            // Literals on the expected side. Both are booleans by now, so
            // `!==` is a value comparison rather than an identity one.
            expect({ stack, inExactlyOneState: drilled !== unbacked })
                .toEqual({ stack, inExactlyOneState: true });
        },
    );

    it('at least one stack IS drilled — a drill that drills nothing is not a drill', () => {
        // Without this, declaring every stack unbacked would satisfy the rule
        // above completely. That is the relax-the-caller failure: a guard
        // disarmed by widening what counts as acceptable.
        //
        // `=== true`, not truthiness: `[]` is truthy, so a gutted predicate
        // made `filter` keep every stack and this assertion pass over nothing.
        const drilled = STACKS.filter((s) => isDrilled(s) === true);
        expect({ drilledCount: drilled.length, drilled })
            .toEqual({ drilledCount: drilled.length, drilled: expect.arrayContaining([]) });
        expect(drilled.length).toBeGreaterThanOrEqual(1);
    });

    it('the drill refuses a dump whose globals sibling is missing', () => {
        // The reason a drilled stack is actually covered rather than nominally
        // covered. #2337: `pg_dump` omits roles while emitting every GRANT
        // that needs them, so a dump alone restores into 142 failures. A drill
        // that accepted a lone dump would pass on an unrestorable backup.
        // Not "globals is mentioned somewhere" — that passed with the whole
        // precondition deleted, because the variable and the `docker cp` lines
        // survive. What must exist is a FATAL refusal between resolving the
        // sibling's path and downloading the dump.
        const lines = DRILL_CODE.split('\n');
        const resolvedAt = lines.findIndex((l) => /GLOBALS=/.test(l));
        const downloadAt = lines.findIndex((l) => /storage cp .*"\$DUMP"/.test(l));
        expect({ resolvedAt: resolvedAt >= 0, downloadAt: downloadAt >= 0 })
            .toEqual({ resolvedAt: true, downloadAt: true });
        const window = lines.slice(resolvedAt, downloadAt);
        expect({
            refusesMissingGlobals:
                window.some((l) => /\$GLOBALS/.test(l)) && window.some((l) => /\bdie\b/.test(l)),
        }).toEqual({ refusesMissingGlobals: true });
        // The diagnosis names the error class, so the operator is not left to
        // discover 42704 from a restore log. Prose is the right place for it,
        // hence the raw read here.
        expect(DRILL).toMatch(/42704|does not exist/);
        // And it must assert, not warn: pg_restore CONTINUES past errors and
        // exits 0 by DEFAULT, reporting them as warnings on stderr. Read from
        // the code: the flag is also discussed in a comment, and a mutation
        // that deleted the real one survived against the raw text.
        expect(DRILL_CODE).toMatch(/--exit-on-error/);
    });

    it('the drill restores the globals BEFORE the database', () => {
        // Order is not a preference. Reversed, every GRANT fails.
        // Positions of the INVOCATIONS, not of the first mention. `docker cp`
        // copies globals.sql into the container before either restore runs, so
        // `indexOf('/tmp/globals.sql')` finds the copy and stays put however
        // the psql calls are reordered — a mutation that moved the restore
        // after the dump survived exactly that way.
        const lines = DRILL_CODE.split('\n');
        const globalsAt = lines.findIndex((l) => /psql\b.*globals\.sql/.test(l));
        const restoreAt = lines.findIndex((l) => /pg_restore\b.*-d restored/.test(l));
        expect({ globalsFound: globalsAt >= 0, restoreFound: restoreAt >= 0 })
            .toEqual({ globalsFound: true, restoreFound: true });
        expect({ globalsBeforeRestore: globalsAt < restoreAt })
            .toEqual({ globalsBeforeRestore: true });
    });

    /**
     * ── PORTED from `tests/unit/restore-drill-error-reporting.test.ts` (#663) ──
     *
     * That file guarded the retired snapshot drill and is deleted with it
     * (#2340). Its lesson is not retired, and it is the sharpest one in this
     * area, so it moves here rather than going with the file.
     *
     * Both of the old drill's first two assertions captured their `gcloud`
     * call as `X="$(gcloud ... 2>/dev/null || true)"`, which collapses two
     * different answers into one: a permission error, an IAM propagation
     * delay, a wrong zone and an API blip all produce an empty string, and an
     * empty string failed the substring test and printed
     *
     *     ✗ ... Production is running WITHOUT automated backups.
     *
     * That fired for real on 2026-08-21, on two stacks whose backups were
     * working perfectly. A false alarm about the one control standing between
     * a backup and an unrecoverable database costs as much as a missed one.
     *
     * The dump drill hit the same shape from the other side: `gcloud storage
     * ls` exits non-zero both when a glob matches nothing and when it cannot
     * look, so "there is no backup" was being reported as "could not list" —
     * and that arm made the explicit no-dump diagnosis UNREACHABLE. Found by
     * running the negative control rather than reasoning about it.
     */
    it('tells "there is no backup" apart from "I could not look"', () => {
        const noMatch = DRILL_CODE.slice(DRILL_CODE.indexOf('storage ls'));
        // The no-match arm must CLASSIFY rather than collapse.
        expect(noMatch).toMatch(/matched no object/);
        // And the two diagnoses must say different things.
        expect(DRILL).toMatch(/there is nothing to restore/);
        expect(DRILL).toMatch(/could not look/);
    });

    it('never swallows a gcloud failure into an empty string', () => {
        // The exact #663 shape: `$(... 2>/dev/null || true)` makes an error
        // indistinguishable from an empty answer. Checked on comment-stripped
        // code because the ported docblock above quotes the bad pattern.
        expect({ collapsesErrors: /2>\/dev\/null\s*\|\|\s*true/.test(DRILL_CODE) })
            .toEqual({ collapsesErrors: false });
    });

    /**
     * ── PORTED from `tests/guards/restore-drill-remote-script.test.ts` (#1179, #1225) ──
     *
     * Also deleted with the retired script. Its mechanism cannot recur — the
     * old drill built its whole battery into a string and handed it to
     * `gcloud compute ssh --command`, and on 2026-10-01 a comment carrying an
     * ODD number of backticks in an UNQUOTED heredoc turned the rest of the
     * payload into a command substitution evaluated on the GitHub runner. No
     * SSH connection was ever opened, so the restore was never attempted and
     * every assertion in the battery was silently unreachable.
     *
     * The dump drill has no remote payload and no heredoc, so that cannot
     * happen. What survives is the PROPERTY: a battery that did not run must
     * not read as a pass. Here the first check is the liveness probe — if
     * `docker exec` were failing entirely, every `q()` would return empty and
     * `SELECT 1` fails before any count is believed.
     */
    it('the battery opens with a liveness probe, so an unexecuted one cannot pass', () => {
        const battery = DRILL_CODE.slice(DRILL_CODE.indexOf('validation battery'));
        const firstCheck = battery.indexOf('SELECT 1');
        const firstCount = battery.indexOf('count(*)');
        expect({ hasLiveness: firstCheck >= 0, hasCounts: firstCount >= 0 })
            .toEqual({ hasLiveness: true, hasCounts: true });
        // Liveness BEFORE any count, so an empty answer cannot be read as a
        // legitimate zero.
        expect({ livenessFirst: firstCheck < firstCount }).toEqual({ livenessFirst: true });
    });

    it('no remote payload to mis-quote', () => {
        // Stated as an assertion rather than a comment: if somebody reaches
        // for `ssh --command` again, the #1179 failure mode returns with it.
        expect({ shipsARemoteBattery: /ssh\s+.*--command|<<\s*'?REMOTE'?/.test(DRILL_CODE) })
            .toEqual({ shipsARemoteBattery: false });
    });

    it('freshness is NOT this drill\'s gate, and says so', () => {
        // The old drill hard-failed on MAX_SNAPSHOT_AGE_HOURS, and the daily
        // `Backup exists` probe owns that question now (#2329) precisely
        // because a monthly cadence let a total absence go unreported for 13
        // days. The drill must not duplicate the alarm — two jobs filing about
        // one outage is how both get muted — but it must not IMPLY freshness
        // either, so the age it prints is marked informational.
        expect(DRILL_CODE).toMatch(/informational/);
        // Negative assertions want the widest true form, not a guessed one.
        // The first version demanded `MAX_` *before* `|| die`, so a mutation
        // writing `|| die "MAX_AGE too old"` sailed through. What must not
        // exist is ANY fatal call whose reason is about age — so the check is
        // over every `die`/`exit 1` line and the vocabulary of staleness.
        const fatalAboutAge = DRILL_CODE.split('\n').filter(
            (l) => /\bdie\b|exit 1/.test(l) && /\b(age|old|stale|fresh|MAX_.*AGE)\b/i.test(l),
        );
        expect({ fatalAboutAge }).toEqual({ fatalAboutAge: [] });
    });
});
