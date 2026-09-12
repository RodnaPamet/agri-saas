/**
 * GAP-10 step 3 — CLI: generate `src/generated/openapi.json` from the
 * annotated Zod schemas.
 *
 * Run via:
 *   npm run openapi:generate
 *
 * Implementation: this script DELEGATES to Jest via
 * `tests/contracts/api-schemas.test.ts`, with `UPDATE_OPENAPI=1`
 * env to flip the test from compare-mode to write-mode. Jest is
 * the canonical runtime for spec generation because the contract
 * test (GAP-10 step 5) compares the in-process build against the
 * committed file — running the generator under a DIFFERENT runtime
 * (e.g. tsx ESM) would produce subtly different output for some
 * Zod constructs (notably `.nullable().optional()` schema
 * references), which would break the byte-for-byte comparison.
 *
 * Single-runtime guarantee: both the writer and the verifier use
 * the same module-loading path. No drift is possible.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
    'npx',
    [
        'jest',
        'tests/contracts/api-schemas.test.ts',
        '--runInBand',
        '--no-coverage',
        '--testNamePattern=full-spec drift check',
        '--silent',
    ],
    {
        stdio: 'inherit',
        env: { ...process.env, UPDATE_OPENAPI: '1', SKIP_ENV_VALIDATION: '1' },
    },
);

if (result.status !== 0) {

    console.error('[generate-openapi] FAILED — see Jest output above');
    process.exit(result.status ?? 1);
}


console.log('[generate-openapi] Wrote src/generated/openapi.json (via Jest contract test in update mode)');
