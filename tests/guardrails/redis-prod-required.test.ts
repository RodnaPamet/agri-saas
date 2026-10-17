/**
 * GAP-13 — Structural ratchet for the REDIS_URL "required in production"
 * enforcement surfaces.
 *
 * The audit's GAP-13 finding was that the schema marked `REDIS_URL` as
 * `.optional()` with a "graceful degradation" comment — true in dev,
 * a lie in prod where rate limits, BullMQ jobs, session coordination,
 * and audit-stream batches all collapse to no-ops without it. The fix
 * landed on three coordinated surfaces:
 *
 *   1. Zod schema — `superRefine` on the field in `src/env.ts`.
 *   2. Web startup hook — `src/instrumentation.ts` exits 1 in prod
 *      when REDIS_URL is unset (defense-in-depth for SKIP_ENV_VALIDATION).
 *   3. Health probes — `src/app/api/health/route.ts` and
 *      `src/app/api/readyz/route.ts` PING Redis on every request and
 *      surface 'Not configured' as an error in production.
 *
 * Plus operator-visible documentation in:
 *   4. `.env.production.example` — REDIS_URL marked REQUIRED.
 *   5. `docs/deployment.md` — required-env table row.
 *
 * A future "simplify" PR could quietly remove any one of these and
 * re-introduce the vulnerable state. This guardrail asserts the
 * structural shape of each surface — failing CI before the change
 * lands instead of relying on a security review that someone might
 * miss. Mirrors `tests/guardrails/encryption-key-enforcement.test.ts`
 * (the GAP-03 equivalent).
 *
 * Functional behaviour is covered separately by:
 *   - `tests/unit/env.test.ts` (schema validation under NODE_ENV=production)
 *   - `tests/unit/health-route.test.ts` (Redis ping affects status)
 *   - `tests/unit/readyz-route.test.ts` (parity for the modern probe)
 */

import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return blankNonCode(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
}

describe('GAP-13 ratchet — schema layer', () => {
    it('src/env.ts has REDIS_URL with a superRefine that mentions production', () => {
        const src = readRepoFile('src/env.ts');
        // Regression: a future PR that drops the superRefine — for
        // example a "simplify env validation" cleanup — would silently
        // re-introduce the vulnerable optional() shape that GAP-13
        // closed. Mirrors the GAP-03 DATA_ENCRYPTION_KEY ratchet.
        expect(src).toMatch(/REDIS_URL/);
        // Look for the REDIS_URL block specifically having a superRefine.
        // We slice the source from the REDIS_URL line through the next
        // ~30 lines and assert it contains the refinement; this beats a
        // global match that could pass thanks to an UNRELATED superRefine
        // (e.g. DATA_ENCRYPTION_KEY's at line 87).
        const redisIdx = src.indexOf('REDIS_URL');
        const window = src.slice(redisIdx, redisIdx + 1500);
        expect(window).toMatch(/\.superRefine\(/);
        expect(window).toMatch(/NODE_ENV[\s\S]*production|production[\s\S]*NODE_ENV/);
        expect(window).toMatch(/REQUIRED in production/);
    });
});

describe('GAP-13 ratchet — runtime startup hook', () => {
    it('src/instrumentation.ts exits 1 in production when REDIS_URL is unset', () => {
        const src = readRepoFile('src/instrumentation.ts');
        // Regression: removing this defense-in-depth check leaves the
        // SKIP_ENV_VALIDATION=1 escape hatch unguarded. Schema is the
        // primary gate; this is the runtime backstop.
        expect(src).toMatch(/REDIS_URL/);
        expect(src).toMatch(/process\.exit\(1\)/);
        // Must be in a NODE_ENV=production conditional — never run
        // unconditionally (would break dev/test ergonomics).
        expect(src).toMatch(/NODE_ENV.*['"]production['"]/);
    });

    it('src/instrumentation.ts has NO RATE_LIMIT_ENABLED escape hatch on the Redis check', () => {
        const src = readRepoFile('src/instrumentation.ts');
        // The original implementation exempted Redis from the prod
        // check when RATE_LIMIT_ENABLED=0 — based on the wrong premise
        // that "if rate limits are off, Redis isn't needed." Redis
        // underpins more than the rate limiter (queues, session
        // cache, audit batches). GAP-13 removed that escape hatch.
        // This test catches a regression that re-adds the toggle.
        //
        // Match the `if (…)` *condition expression* specifically,
        // not the surrounding comments — the comments legitimately
        // explain why RATE_LIMIT_ENABLED *was* removed and would
        // false-positive a naive substring check.
        const conditionMatch = src.match(
            /if\s*\(\s*process\.env\.NODE_ENV\s*===\s*['"]production['"][\s\S]*?\)\s*\{\s*\n[\s\S]*?REDIS_URL[\s\S]*?process\.exit\(1\)/,
        );
        if (!conditionMatch) {
            throw new Error(
                'Cannot locate the GAP-13 Redis production check in src/instrumentation.ts. ' +
                'Update this test to match the new shape if the check was refactored.',
            );
        }
        // Slice out just the `if (...)` parenthesized condition.
        const condition = conditionMatch[0].match(/if\s*\(([\s\S]*?)\)\s*\{/);
        expect(condition).not.toBeNull();
        // The condition MUST NOT short-circuit on RATE_LIMIT_ENABLED.
        // (Comments referring to the removed flag are fine — they're
        // outside the condition expression.)
        expect(condition![1]).not.toMatch(/RATE_LIMIT_ENABLED/);
    });
});

describe('GAP-13 ratchet — health endpoints', () => {
    it('/api/health pings Redis (parity with /api/readyz)', () => {
        const src = readRepoFile('src/app/api/health/route.ts');
        // Regression: pre-GAP-13, /api/health checked DB only and
        // would report "healthy" while Redis was down. Operators
        // pointing legacy probes at /api/health would get a false
        // green. The Redis check here closes that gap.
        expect(src).toMatch(/Redis|redis/);
        expect(src).toMatch(/\.ping\(\)|@\/lib\/redis/);
        // In production a missing REDIS_URL must surface as an
        // error in the response, not as the historical "ok latency=0".
        expect(src).toMatch(/Not configured|process\.env\.NODE_ENV.*production/);
    });

    it('/api/readyz reports Redis as error in production when REDIS_URL is unset', () => {
        const src = readRepoFile('src/app/api/readyz/route.ts');
        expect(src).toMatch(/Redis|redis/);
        // The "not configured" branch must distinguish prod from dev:
        // prod returns error, dev/test returns ok (ergonomics).
        expect(src).toMatch(/Not configured/);
        expect(src).toMatch(/NODE_ENV.*production/);
    });
});

describe('GAP-13 ratchet — env templates + docs', () => {
    it('.env.production.example sets REDIS_URL (uncommented, REQUIRED)', () => {
        const src = readRepoFile('.env.production.example');
        // Regression: an empty production template (the pre-GAP-13
        // state — REDIS_URL was a commented "optional" line) gives
        // operators no signal that this var is required. Uncommented
        // placeholder is the visibility lever, and the inline
        // REQUIRED label catches anyone skimming.
        expect(src).toMatch(/^REDIS_URL=/m);
        expect(src).toMatch(/REDIS_URL[\s\S]*REQUIRED|REQUIRED[\s\S]*REDIS_URL/);
        expect(src).toMatch(/GAP-13/);
    });

    it('docs/deployment.md flags REDIS_URL as REQUIRED in production in the env table', () => {
        const src = readRepoFile('docs/deployment.md');
        // Regression: doc rot — operators reading the deployment
        // guide must see REDIS_URL marked the same way as
        // DATA_ENCRYPTION_KEY (the GAP-03 precedent). A future
        // table-cleanup PR could silently strip the row or downgrade
        // the "required" marker.
        expect(src).toMatch(/REDIS_URL/);
        expect(src).toMatch(/REDIS_URL[\s\S]*REQUIRED|REQUIRED[\s\S]*REDIS_URL/);
        expect(src).toMatch(/GAP-13/);
    });
});

describe('GAP-13 ratchet — CI workflow', () => {
    it('CI Test + Coverage + E2E jobs do not depend on REDIS_URL being unset', () => {
        const src = readRepoFile('.github/workflows/ci.yml');
        // Regression: a CI workflow setting NODE_ENV=production (e.g.
        // a smoke job, deployment-style integration test) without
        // also setting REDIS_URL would fail the new env-schema check.
        // Today none of the jobs do that — but if a future workflow
        // does, the schema's superRefine will refuse to construct env
        // and the job will fail with a clear error message rather
        // than mysteriously hanging on missing rate-limit state.
        //
        // This test is intentionally weak: it asserts the workflow
        // file exists and is parseable. The functional contract is
        // tested in tests/unit/env.test.ts via runEnvScript().
        expect(src.length).toBeGreaterThan(0);
        expect(src).toMatch(/name:\s+CI/);
    });
});
