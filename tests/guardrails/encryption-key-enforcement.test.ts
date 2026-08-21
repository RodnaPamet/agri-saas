/**
 * GAP-03 — Structural ratchet for the DATA_ENCRYPTION_KEY enforcement
 * surfaces.
 *
 * The audit's GAP-03 finding was that the schema marked
 * `DATA_ENCRYPTION_KEY` as `.optional()` and a production process
 * could boot without encryption-at-rest. The fix landed in five
 * coordinated surfaces:
 *
 *   1. Zod schema — `superRefine` on the field in `src/env.ts`.
 *   2. Web startup hook — `src/instrumentation.ts` calls
 *      `checkProductionEncryptionKey` + `runEncryptionSentinel`.
 *   3. Worker startup — `scripts/worker.ts` calls the same checker.
 *   4. Scheduler startup — `scripts/scheduler.ts` calls the checker.
 *   5. Docker Compose — `:?error` syntax in all three prod compose
 *      files.
 *
 * A future "simplify" PR could quietly remove any one of these and
 * re-introduce the vulnerable state. This guardrail asserts the
 * structural shape of each surface — failing CI before the change
 * lands instead of relying on a security review that someone might
 * miss. Each assertion has a one-line note explaining the regression
 * class it protects.
 *
 * The functional behaviour is covered separately by:
 *   - `tests/unit/env.test.ts` (schema validation)
 *   - `tests/unit/security/startup-encryption-check.test.ts` (helpers)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('GAP-03 ratchet — schema layer', () => {
    it('src/env.ts has DATA_ENCRYPTION_KEY with a superRefine that mentions production', () => {
        const src = readRepoFile('src/env.ts');
        // Regression: a future PR that drops the superRefine — for
        // example a "simplify env validation" cleanup — would silently
        // re-introduce the vulnerable optional() shape that GAP-03
        // closed.
        expect(src).toMatch(/DATA_ENCRYPTION_KEY/);
        expect(src).toMatch(/\.superRefine\(/);
        // Use [\s\S]* instead of `.*` + `s` flag for ES2017 target.
        expect(src).toMatch(/NODE_ENV[\s\S]*production|production[\s\S]*NODE_ENV/);
    });

    it('src/env.ts imports DEV_FALLBACK_DATA_ENCRYPTION_KEY from the shared constants module', () => {
        const src = readRepoFile('src/env.ts');
        // Regression: inline-defining the dev fallback string in the
        // schema instead of importing the constant breaks the
        // single-source-of-truth contract — a typo would cause the
        // schema and runtime to disagree on what counts as the dev
        // fallback.
        expect(src).toMatch(
            /import[\s\S]*DEV_FALLBACK_DATA_ENCRYPTION_KEY[\s\S]*encryption-constants/,
        );
    });

    it('the dev-fallback constant is exported from a dedicated module', () => {
        const src = readRepoFile('src/lib/security/encryption-constants.ts');
        expect(src).toMatch(/export const DEV_FALLBACK_DATA_ENCRYPTION_KEY/);
        // Regression: removing the export would force callers to
        // duplicate the literal string and break the cross-layer
        // ratchet.
    });
});

describe('GAP-03 ratchet — runtime startup hooks', () => {
    it('Next.js instrumentation hook calls checkProductionEncryptionKey + runEncryptionSentinel', () => {
        const src = readRepoFile('src/instrumentation.ts');
        // Regression: a refactor that drops either check leaves the
        // SKIP_ENV_VALIDATION=1 escape hatch unguarded (if the schema
        // is bypassed) OR loses the functional sentinel that catches
        // structurally-valid keys that fail HKDF/AES.
        expect(src).toMatch(/checkProductionEncryptionKey/);
        expect(src).toMatch(/runEncryptionSentinel/);
        // The check must be inside an if-production block — never
        // run unconditionally (would break dev/test ergonomics).
        expect(src).toMatch(/NODE_ENV.*['"]production['"]/);
    });

    // The two standalone entrypoints call the shared gate rather than the two
    // helpers directly (#698). They used to inline the calls inside a
    // NON-AWAITED async IIFE, so both processes were already live when the
    // refusal printed — the worker subscribed to its queues, the scheduler
    // mid-registration. `assertProductionEncryptionReady` is the awaited form,
    // and it is where the `NODE_ENV === 'production'` gate now lives.
    //
    // This is a structural check and cannot see ordering. The behaviour —
    // that the FATAL line is the FIRST thing either script emits — is asserted
    // by driving real child processes in
    // `tests/unit/security/startup-fail-fast-execution.test.ts`.
    it('BullMQ worker (scripts/worker.ts) awaits the production startup gate', () => {
        const src = readRepoFile('scripts/worker.ts');
        // Regression: workers run as a separate process and bypass
        // src/instrumentation.ts. Without their own check, a worker
        // can boot in production with no key and crash on the first
        // job that reads/writes an encrypted column.
        expect(src).toMatch(/assertProductionEncryptionReady/);
        // AWAITED — `void`-ing it is the #698 defect, and it is invisible to
        // every other assertion in this file.
        expect(src).toMatch(/await assertProductionEncryptionReady\(/);
        expect(src).not.toMatch(/void assertProductionEncryptionReady\(/);
    });

    it('Scheduler (scripts/scheduler.ts) awaits the production startup gate', () => {
        const src = readRepoFile('scripts/scheduler.ts');
        // Regression: scheduler runs once on deploy. Refusing to
        // register schedules when the key is missing surfaces the
        // misconfiguration on the deploy that caused it, not three
        // jobs later when the worker crashes on its first dispatch.
        expect(src).toMatch(/await assertProductionEncryptionReady\(/);
        expect(src).not.toMatch(/void assertProductionEncryptionReady\(/);
    });

    it('the shared gate runs both halves, and only in production', () => {
        const src = readRepoFile('src/lib/security/startup-gate.ts');
        expect(src).toMatch(/export async function assertProductionEncryptionReady/);
        expect(src).toMatch(/checkProductionEncryptionKey/);
        expect(src).toMatch(/runEncryptionSentinel/);
        expect(src).toMatch(/env\.NODE_ENV !== 'production'/);
        expect(src).toMatch(/process\.exit\(1\)/);
    });

    it('startup-encryption-check exports both helpers', () => {
        const src = readRepoFile('src/lib/security/startup-encryption-check.ts');
        expect(src).toMatch(/export function checkProductionEncryptionKey/);
        expect(src).toMatch(/export async function runEncryptionSentinel/);
    });
});

describe('GAP-03 ratchet — Docker Compose surfaces', () => {
    const COMPOSE_FILES = [
        'docker-compose.prod.yml',
        'docker-compose.staging.yml',
        'deploy/docker-compose.prod.yml',
    ];

    it.each(COMPOSE_FILES)(
        '%s declares DATA_ENCRYPTION_KEY with the :?error fail-fast suffix',
        (file) => {
            const src = readRepoFile(file);
            // The :?error syntax aborts `docker compose up` before
            // the container is even created. A refactor that switches
            // to a default value (`:-`) or drops the directive entirely
            // would silently allow `compose up` to start a container
            // with the var unset. The value is double-quoted (the
            // fail-fast message contains a `: ` that breaks unquoted
            // YAML) — the optional `"?` accepts that quoted form.
            expect(src).toMatch(
                /DATA_ENCRYPTION_KEY:\s*"?\$\{DATA_ENCRYPTION_KEY:\?/,
            );
        },
    );
});

describe('GAP-03 ratchet — env templates', () => {
    it('.env.production.example sets DATA_ENCRYPTION_KEY (uncommented)', () => {
        const src = readRepoFile('.env.production.example');
        // Regression: an empty production template (the original
        // GAP-03 state) gives operators no signal that this var is
        // required. Uncommented placeholder is the visibility lever.
        expect(src).toMatch(/^DATA_ENCRYPTION_KEY=/m);
    });

    it('.env.staging.example sets DATA_ENCRYPTION_KEY (uncommented)', () => {
        const src = readRepoFile('.env.staging.example');
        expect(src).toMatch(/^DATA_ENCRYPTION_KEY=/m);
    });

    it('deploy/.env.prod.example signals DATA_ENCRYPTION_KEY lives in AWS Secrets Manager (post-OI-1 model)', () => {
        const src = readRepoFile('deploy/.env.prod.example');
        // Epic OI-1 migrated DATA_ENCRYPTION_KEY (and 4 other runtime
        // secrets) out of plaintext deploy/.env.prod into AWS Secrets
        // Manager. The pre-OI-1 contract was an uncommented
        // `DATA_ENCRYPTION_KEY=` placeholder in this file; the new
        // contract is a deprecation banner that tells operators where
        // the value lives now and which tooling resolves it. Either
        // shape gives the same operator-visible signal that the var
        // is required, which is the original GAP-03 intent.
        const hasUncommentedPlaceholder = /^DATA_ENCRYPTION_KEY=/m.test(src);
        const hasSecretsManagerPointer =
            /AWS Secrets Manager/i.test(src) &&
            /bootstrap-env-from-secrets\.sh/.test(src) &&
            /DEPRECATED/i.test(src);

        expect(hasUncommentedPlaceholder || hasSecretsManagerPointer).toBe(true);
    });
});

describe('GAP-03 ratchet — CI workflow', () => {
    it('CI test + coverage jobs set DATA_ENCRYPTION_KEY in their env block', () => {
        const src = readRepoFile('.github/workflows/ci.yml');
        // Regression: removing the env entry would not break unit
        // tests today (they use the dev fallback under NODE_ENV=test)
        // but would silently make any future test that flips
        // NODE_ENV=production unable to find a key — the test would
        // fail in a confusing way ("DATA_ENCRYPTION_KEY required" on
        // a passing CI box).
        const matches = src.match(/^\s*DATA_ENCRYPTION_KEY:\s*\S+/gm) ?? [];
        // Both the test job and the coverage job set it.
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});
