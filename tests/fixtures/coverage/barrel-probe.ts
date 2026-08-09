/**
 * Coverage probe — fixture for
 * `tests/guards/coverage-barrel-exclusion.test.ts`.
 *
 * Deliberately NOT named `*.test.ts`: neither project's `testMatch`
 * picks it up, so it never runs in the main suite. The guard runs it on
 * its own, with `--coverage`, against a config derived from the real
 * `jest.config.js`.
 *
 * The import is the entire point. `@/lib/observability` is one of the
 * `PURE_REEXPORT_BARRELS`, so loading it here is what gives the
 * exclusion something to remove — and loading it pulls in its siblings
 * (`./context`, `./logger`, …), which become the practice: they MUST
 * appear in the emitted report.
 *
 * Without a real load, "the barrel is absent from coverage-summary.json"
 * is vacuously true for any file the run never touched. That is exactly
 * how a broken exclusion passed verification before: it was checked with
 * a scoped run that never loaded the barrel at all.
 */
import * as observability from '@/lib/observability';

it('loads the excluded barrel through its public entry point', () => {
    // Reached through the barrel's re-export getters, i.e. through the
    // emitted `Object.defineProperty(exports, …)` functions that are the
    // reason the file is excluded in the first place.
    expect(typeof observability.getRequestId).toBe('function');
    expect(typeof observability.log).toBe('function');
});
