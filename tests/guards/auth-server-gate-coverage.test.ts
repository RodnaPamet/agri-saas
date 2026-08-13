/**
 * Auth server-gate coverage — the load-bearing integration tests.
 *
 * Playwright runs with `AUTH_TEST_MODE=1` (see
 * `tests/e2e/README.md → Server-mode invariant`), which bypasses
 * per-email rate-limit and `AUTH_REQUIRE_EMAIL_VERIFICATION`. The
 * server enforcement of those gates is covered by real-mode
 * integration tests instead — these files are the documented
 * reason we don't run a sibling `playwright.real-auth.config.ts`.
 *
 * This guard locks the decision structurally: if a future PR
 * deletes one of these integration tests, the gap reopens and a
 * real-auth Playwright config (with SMTP catcher + Compose
 * service + second CI job) becomes worth reconsidering. Without
 * this guard, the deletion would be invisible to PR review until
 * a regression slipped through.
 *
 * If you delete a file from this list intentionally: edit the
 * list AND `tests/e2e/README.md → Why not a sibling
 * playwright.real-auth.config.ts?` in the same PR, and explain
 * what replaces it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Each entry: a real-mode integration test we depend on plus the
 * specific gate it exercises. Adding here is fine; removing
 * without a paired README + spec migration is the failure mode.
 */
const AUTH_SERVER_GATE_TESTS: ReadonlyArray<{
    file: string;
    covers: string;
}> = [
    {
        file: 'tests/integration/auth-ratelimit.test.ts',
        covers:
            'Per-email rate limit (checkCredentialsAttempt) — N consecutive failures lock + reset on success',
    },
    {
        // Re-pointed in GRC teardown phase 2. This entry named
        // `tests/integration/auth-gating.test.ts`, which contained ZERO
        // email-verification tests — its two describes were Practices and
        // Policy auth gating, and it was deleted with them. The claim was
        // false before the teardown, not because of it. The enforcement IS
        // covered, by the file below (see its `blocked unverified login`
        // case at :150) and by tests/unit/credentials-auth.test.ts.
        file: 'tests/integration/credentials-end-to-end.test.ts',
        covers:
            'AUTH_REQUIRE_EMAIL_VERIFICATION enforcement on the authenticate path',
    },
    {
        file: 'tests/integration/credentials-end-to-end.test.ts',
        covers:
            'Credentials flow end-to-end against real Prisma — verify password, dummy-compare timing, session shape',
    },
    {
        file: 'tests/integration/email-verification.test.ts',
        covers:
            'Issue + consume + re-issue + expiry of verification tokens against real DB',
    },
    {
        file: 'tests/integration/auth-routes.test.ts',
        covers:
            'NextAuth /api/auth/* routes exposed correctly + register flow shape',
    },
];

describe('auth server-gate coverage — integration tests we rely on', () => {
    it.each(AUTH_SERVER_GATE_TESTS)(
        '$file exists ($covers)',
        ({ file }) => {
            const abs = path.join(ROOT, file);
            expect(fs.existsSync(abs)).toBe(true);
        },
    );

    it('the AUTH_TEST_MODE=1 invariant is still set on the Playwright webServer command', () => {
        // If a future PR removes `AUTH_TEST_MODE=1` from the
        // webServer command WITHOUT building out a real-auth
        // config + SMTP catcher to replace it, the E2E suite
        // would start hitting real rate-limit + verification
        // gates and time-out / fail unpredictably. Lock the
        // invariant here so the removal can't slip in silently.
        const src = fs.readFileSync(
            path.join(ROOT, 'playwright.config.ts'),
            'utf8',
        );
        expect(src).toMatch(/AUTH_TEST_MODE=1/);
    });

    it('the decision README still documents the deferred real-auth config', () => {
        // The README is the operator-facing record of WHY we
        // run with AUTH_TEST_MODE=1. If the README disappears,
        // a future contributor has no context for the choice.
        const src = fs.readFileSync(
            path.join(ROOT, 'tests/e2e/README.md'),
            'utf8',
        );
        expect(src).toContain('AUTH_TEST_MODE=1');
        expect(src).toContain('playwright.real-auth.config.ts');
        expect(src).toContain('SMTP catcher');
    });
});
