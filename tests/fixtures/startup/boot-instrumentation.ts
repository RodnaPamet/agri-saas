/**
 * Minimal harness that runs the REAL Next.js instrumentation hook.
 *
 * `tests/unit/security/startup-fail-fast-execution.test.ts` spawns this as a
 * child process, because the thing under test is `process.exit(1)` — which
 * cannot be observed from inside the process that calls it. That is precisely
 * why the hook had never been executed: `startup-encryption-check.test.ts`
 * covers the two helper FUNCTIONS, and a guardrail greps the hook for the
 * strings; nothing had ever started a process with a bad key and watched it
 * refuse to boot.
 *
 * Printing `REGISTER_RETURNED_OK` is the negative control. Without it a test
 * asserting "no FATAL line" would pass just as happily if `register()` had
 * thrown, hung, or never reached the check at all.
 */
import { register } from '../../../src/instrumentation';

register().then(
    () => {
        console.log('REGISTER_RETURNED_OK');
        process.exit(0);
    },
    (err: unknown) => {
        console.error('REGISTER_THREW: ' + (err instanceof Error ? err.message : String(err)));
        process.exit(2);
    },
);
