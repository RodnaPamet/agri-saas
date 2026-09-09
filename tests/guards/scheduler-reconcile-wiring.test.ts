import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The reconcile is correct only if the SCRIPT hands it the right set, and no
 * unit test can see that — `scripts/scheduler.ts` is the I/O edge.
 *
 * Two ways to sever it, both silent:
 *   1. pass `SCHEDULED_JOBS` instead of `ALL_SCHEDULE_NAMES` — deletes
 *      key-gated schedules from Redis whenever their API key is absent;
 *   2. call `reconcile` only under `--clean` — which is exactly the state
 *      #803 describes, since the deploy command never passes that flag.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts/scheduler.ts'), 'utf8');

describe('the scheduler reconcile is wired to the safe set', () => {
    it('the script still has the shape this guard reasons about', () => {
        // Positive control: every assertion below is a substring match on one
        // file. If the file is renamed or gutted they would fail loudly, but
        // if it were merely truncated a `not.toMatch` would pass — so anchor
        // on the functions that must exist.
        expect(SRC).toMatch(/async function registerAll\(/);
        expect(SRC).toMatch(/async function reconcile\(/);
    });

    it('passes ALL_SCHEDULE_NAMES, not SCHEDULED_JOBS, to schedulersToRemove', () => {
        // Match to the closing `);` on its own line — a lazy `\)` stops at
        // the nested paren in `existing.map(s => s.name)` and captures nothing
        // useful. That mis-match failed OPEN in the first draft of this file.
        const call = SRC.match(/schedulersToRemove\(([\s\S]{0,300}?)\n\s*\);/);
        expect(call).not.toBeNull();
        expect(call![1]).toMatch(/ALL_SCHEDULE_NAMES/);
        expect(call![1]).not.toMatch(/SCHEDULED_JOBS/);
    });

    it('runs the reconcile on the DEPLOY path, not only under --clean', () => {
        // `registerAll` then `reconcile`, in the same branch. The bug in #803
        // is precisely that the only removal path was behind a flag the deploy
        // command does not pass.
        expect(SRC).toMatch(/await registerAll\(queue\);\s*\n\s*await reconcile\(queue\);/);
    });

    it('logs each removal by name', () => {
        // A wrong removal must be diagnosable after the fact rather than
        // inferred from an absence.
        expect(SRC).toMatch(/log\.info\(\{ name \}, 'reconcile: removed orphaned scheduler'\)/);
    });
});
