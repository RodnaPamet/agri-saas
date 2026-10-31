/**
 * A guard whose assertions are SKIP-GATED, used as the second self-test for
 * `scripts/selector-teeth.mjs` (#2544).
 *
 * The sibling fixture (`selector-teeth-selftest.test.ts`) plants a toothless
 * selector and proves the tool REPORTS it. This one plants a selector with
 * perfectly good teeth whose assertion does not RUN, and proves the tool says
 * so instead of calling it dead.
 *
 * ## The shape it reproduces
 *
 * `tests/guardrails/rls-coverage.test.ts` gates its `pg_policies` assertions on
 * a database probe and deliberately keeps ONE always-running test — the
 * execution-status banner that makes the non-execution visible. The
 * `selector-teeth` job declares no services and no postgres, so on every run
 * that suite reports `Tests: N skipped, 1 passed`.
 *
 * `cleanPass` asks for a summary with no failures and at least one pass, and
 * that single passing test satisfies it. So every gut of every DB-gated
 * selector was scored SURVIVED — not because the selector was dead, but because
 * the test that would have killed it never ran. The guard that exists to make a
 * skip visible was supplying the pass that hid it.
 *
 * ## Why the gate is a constant
 *
 * A real guard derives its skip from a probe, and `const DB_AVAILABLE = false`
 * would be a defect there — a hard-coded skip never re-arms. Here the constant
 * IS the fixture: this file's job is to present the skipped shape on every run,
 * on any machine, with no service to arrange and nothing to flake. It is a
 * control, not a guard, and a control that only sometimes expresses the
 * condition it controls for is no control at all.
 *
 * NOT under tests/guards, so the suite never runs it as a real guard.
 */

/**
 * Gutting this to `[]` IS caught — by the assertion below, which does not run.
 * That is the whole point: the selector has teeth, and this run cannot tell.
 */
export function pick(haystack: string[]): string[] {
    return haystack.filter((h) => h.startsWith('BAD_'));
}

const DB_AVAILABLE = false;
const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('the gated half — would kill every gut of pick()', () => {
    it('finds the offender, so an emptied pick() fails here', () => {
        expect(pick(['BAD_one', 'ok_two'])).toEqual(['BAD_one']);
    });
});

describe('the always-running half', () => {
    it('reports that the gated half did not run', () => {
        // The pass that `cleanPass` used to read as "the mutation survived".
        expect(DB_AVAILABLE).toBe(false);
    });
});
