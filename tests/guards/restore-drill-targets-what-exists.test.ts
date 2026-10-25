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

/** A stack is drilled when the workflow names it as a target. */
const isDrilled = (s: string) =>
    new RegExp(`Restore Test \\(${s}\\)|target:\\s*${s}\\b`).test(WORKFLOW);

/**
 * A stack is declared unbacked when the runbook says so about it by name.
 * Matched on a heading rather than anywhere in the file, so a passing mention
 * in the history section cannot be read as the declaration.
 */
const isDeclaredUnbacked = (s: string) =>
    new RegExp(`^>?\\s*#{0,4}\\s*\`?${s}\`?\\s+is\\s+(STILL\\s+)?unbacked`, 'im').test(RUNBOOK);

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

    it.each(STACKS.map((s) => [s] as const))(
        '%s is either drilled or declared unbacked, never neither',
        (stack) => {
            expect({
                stack,
                drilled: isDrilled(stack),
                declaredUnbacked: isDeclaredUnbacked(stack),
                inExactlyOneState: isDrilled(stack) !== isDeclaredUnbacked(stack),
            }).toEqual({
                stack,
                drilled: isDrilled(stack),
                declaredUnbacked: isDeclaredUnbacked(stack),
                inExactlyOneState: true,
            });
        },
    );

    it('at least one stack IS drilled — a drill that drills nothing is not a drill', () => {
        // Without this, declaring every stack unbacked would satisfy the rule
        // above completely. That is the relax-the-caller failure: a guard
        // disarmed by widening what counts as acceptable.
        expect(STACKS.filter(isDrilled).length).toBeGreaterThanOrEqual(1);
    });

    it('the drill refuses a dump whose globals sibling is missing', () => {
        // The reason a drilled stack is actually covered rather than nominally
        // covered. #2337: `pg_dump` omits roles while emitting every GRANT
        // that needs them, so a dump alone restores into 142 failures. A drill
        // that accepted a lone dump would pass on an unrestorable backup.
        expect(DRILL).toMatch(/globals/i);
        expect(DRILL).toMatch(/42704|does not exist/);
        // And it must assert, not warn: pg_restore CONTINUES past errors and
        // exits 0 by default.
        expect(DRILL).toMatch(/--exit-on-error/);
    });

    it('the drill restores the globals BEFORE the database', () => {
        // Order is not a preference. Reversed, every GRANT fails.
        const globalsAt = DRILL.indexOf('/tmp/globals.sql');
        const restoreAt = DRILL.indexOf('pg_restore -U postgres -d restored');
        expect(globalsAt).toBeGreaterThan(-1);
        expect(restoreAt).toBeGreaterThan(-1);
        expect(globalsAt).toBeLessThan(restoreAt);
    });

    it('freshness is NOT this drill\'s gate, and says so', () => {
        // The old drill hard-failed on MAX_SNAPSHOT_AGE_HOURS, and the daily
        // `Backup exists` probe owns that question now (#2329) precisely
        // because a monthly cadence let a total absence go unreported for 13
        // days. The drill must not duplicate the alarm — two jobs filing about
        // one outage is how both get muted — but it must not IMPLY freshness
        // either, so the age it prints is marked informational.
        expect(DRILL).toMatch(/informational/);
        expect({ hardFailsOnAge: /MAX_.*AGE.*\|\| die|exit 1.*too old/i.test(DRILL) })
            .toEqual({ hardFailsOnAge: false });
    });
});
