/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { execSync } from 'child_process';
import path from 'path';

describe('Environment Variable Validation', () => {
    const projectRoot = path.resolve(__dirname, '../..');

    const validEnv = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://user:password@localhost:5432/db',
        NEXTAUTH_URL: 'http://localhost:3000',
        AUTH_URL: 'http://localhost:3000',
        AUTH_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE in tests/guardrails/no-secrets.test.ts)
        JWT_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE)
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        MICROSOFT_CLIENT_ID: 'ms-client-id',
        MICROSOFT_CLIENT_SECRET: 'ms-secret',
        // A single-directory GUID. Shape matters, not the digits: a valid
        // production env must now name a directory rather than inherit the
        // multi-tenant default, so the shared fixture names one.
        MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555',
        UPLOAD_DIR: '/tmp/uploads',
    };

    function runEnvScript(envOverrides: Record<string, string | undefined>) {
        const testEnv: any = { ...process.env, ...validEnv, ...envOverrides, SKIP_ENV_VALIDATION: '' };

        // Remove undefined explicitly
        Object.keys(testEnv).forEach(key => {
            if (testEnv[key] === undefined) delete testEnv[key];
        });

        // Use ts-node (tsx) to run the script since it imports TS files
        try {
            const output = execSync('npx tsx scripts/print-env-ok.ts', {
                cwd: projectRoot,
                env: testEnv,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
            return { success: true, output };
        } catch (error: any) {
            return {
                success: false,
                output: error.stdout,
                error: error.stderr || error.message
            };
        }
    }

    it('should pass and print OK when all required vars are present', () => {
        const result = runEnvScript({});
        expect(result.success).toBe(true);
        expect(result.output).toContain('OK');
    });

    it('should fail when AUTH_SECRET is missing', () => {
        const result = runEnvScript({ AUTH_SECRET: undefined });
        expect(result.success).toBe(false);
        expect(result.error).toContain('AUTH_SECRET');
        expect(result.error).toContain('expected string'); // Zod error indicator
    });

    it('should fail when AUTH_SECRET is too short', () => {
        const result = runEnvScript({ AUTH_SECRET: 'short' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('AUTH_SECRET');
        expect(result.error).toContain('must be at least 16 characters');
    });

    it('should fail when DATABASE_URL is not a valid URL', () => {
        const result = runEnvScript({ DATABASE_URL: 'not-a-db-url' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATABASE_URL');
        expect(result.error).toContain('Invalid URL');
    });

    it('should pass validation even if NEXTAUTH_URL & AUTH_URL omitted entirely, relying on Vercel URL mapping if theoretically present', () => {
        const result = runEnvScript({ NEXTAUTH_URL: undefined, AUTH_URL: undefined, VERCEL: '1', VERCEL_URL: 'https://myapp.vercel.app' });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── GAP-03: DATA_ENCRYPTION_KEY production enforcement ──────────
    //
    // The schema-level superRefine on DATA_ENCRYPTION_KEY enforces the
    // production-required + not-equal-to-dev-fallback contract. These
    // tests run the env loader in a child process under
    // NODE_ENV=production and assert the failure modes the audit
    // identified as GAP-03.

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY is unset', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: undefined,
            // Provide REDIS_URL so we isolate the encryption-key path
            // (GAP-13 makes REDIS_URL prod-required too).
            REDIS_URL: 'redis://:devpass@localhost:6379',
            // Provide everything else so we isolate the encryption-key path.
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('REQUIRED in production');
        // Regression: a refactor that makes the field optional in
        // production again would silently undo GAP-03. The audit
        // flagged this exact regression class.
    });

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY equals the documented dev fallback', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            // Keep this string in sync with `encryption-constants.ts`.
            // We hard-code it here (rather than import) because runEnvScript
            // spawns a child process — the constant isn't available in
            // shell env at that point.
            DATA_ENCRYPTION_KEY: 'inflect-dev-encryption-key-not-for-production-use!!',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('dev fallback');
        // Regression: a misconfigured prod deploy with NODE_ENV=production
        // but DATA_ENCRYPTION_KEY accidentally set to the well-known dev
        // string would silently encrypt customer data with a key that
        // is committed in this repo. Refusing to boot is the only safe
        // outcome.
    });

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY is shorter than 32 chars', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'too-short',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('at least 32 characters');
    });

    it('passes when DATA_ENCRYPTION_KEY is unset under NODE_ENV=test (dev/test ergonomics preserved)', () => {
        const result = runEnvScript({
            NODE_ENV: 'test',
            DATA_ENCRYPTION_KEY: undefined,
        });
        // The dev fallback in the encryption module + the optional()
        // schema mean test/dev environments must continue to boot
        // without a key. A regression here would force every contributor
        // and every test runner to set DATA_ENCRYPTION_KEY.
        expect(result.success).toBe(true);
    });

    it('passes when DATA_ENCRYPTION_KEY is unset under NODE_ENV=development', () => {
        const result = runEnvScript({
            NODE_ENV: 'development',
            DATA_ENCRYPTION_KEY: undefined,
        });
        expect(result.success).toBe(true);
    });

    it('passes when production has a real ≥32-char key (happy path)', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── GAP-13: REDIS_URL production enforcement ──────────────────
    //
    // The schema-level superRefine on REDIS_URL enforces the
    // production-required contract. These tests run the env loader
    // in a child process under NODE_ENV=production and assert the
    // failure modes that GAP-13 closed.

    it('rejects NODE_ENV=production when REDIS_URL is unset', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            // Isolate the REDIS_URL path — supply everything else.
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            STORAGE_PROVIDER: 'local',
            REDIS_URL: undefined,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('REDIS_URL');
        expect(result.error).toContain('REQUIRED in production');
        // Regression: a refactor that drops the superRefine and makes
        // the field optional in production again would silently strip
        // rate-limit + queue + session-coordination guarantees.
    });

    it('passes when REDIS_URL is unset under NODE_ENV=test (dev/test ergonomics preserved)', () => {
        const result = runEnvScript({
            NODE_ENV: 'test',
            REDIS_URL: undefined,
        });
        // Without this, every contributor and every test runner would
        // need a local Redis to validate env. The graceful fallback
        // (in-memory rate-limit, no BullMQ jobs) is intentional in
        // dev/test only.
        expect(result.success).toBe(true);
    });

    it('passes when REDIS_URL is unset under NODE_ENV=development', () => {
        const result = runEnvScript({
            NODE_ENV: 'development',
            REDIS_URL: undefined,
        });
        expect(result.success).toBe(true);
    });

    it('passes when production has a real REDIS_URL (happy path)', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            REDIS_URL: 'redis://user:pass@redis.example.internal:6379',
            STORAGE_PROVIDER: 'local',
        });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── Redis production-auth enforcement ─────────────────────────
    //
    // The GAP-13 superRefine on REDIS_URL was strengthened: in
    // production the URL must not only be PRESENT, it must be
    // AUTHENTICATED — it must parse and carry a non-empty password in
    // its userinfo. A bare `redis://host:6379` is rejected. An
    // unauthenticated Redis that is network-reachable is wide open;
    // sessions, rate-limit counters, and the job queue all live
    // there. The rule is production-only — dev/test keep ergonomic
    // passwordless Redis.

    describe('Redis production-auth rule', () => {
        it('rejects NODE_ENV=production when REDIS_URL is unauthenticated (no password)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://redis:6379',
                STORAGE_PROVIDER: 'local',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('REDIS_URL');
            expect(result.error).toContain('AUTHENTICATED in production');
            // Regression: a bare redis://host:6379 leaves Redis open to
            // anyone who can reach the port. Refusing to boot is the
            // only safe outcome for a production-like deployment.
        });

        it('passes NODE_ENV=production when REDIS_URL carries a password (redis://:pw@host)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:supersecret@redis:6379',
                STORAGE_PROVIDER: 'local',
            });
            if (!result.success) {
                console.error(result.error);
            }
            expect(result.success).toBe(true);
        });

        it('passes NODE_ENV=production when REDIS_URL is a TLS auth-token URL (rediss://:token@host)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'rediss://:managed-auth-token@redis.example.internal:6379',
                STORAGE_PROVIDER: 'local',
            });
            if (!result.success) {
                console.error(result.error);
            }
            expect(result.success).toBe(true);
        });

        it('passes when REDIS_URL is unauthenticated under NODE_ENV=test (rule is production-only)', () => {
            const result = runEnvScript({
                NODE_ENV: 'test',
                REDIS_URL: 'redis://redis:6379',
            });
            // Dev/test keep passwordless Redis for ergonomics — the
            // auth rule must not fire outside production.
            expect(result.success).toBe(true);
        });

        it('still rejects NODE_ENV=production when REDIS_URL is missing entirely', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                STORAGE_PROVIDER: 'local',
                REDIS_URL: undefined,
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('REDIS_URL');
            expect(result.error).toContain('REQUIRED in production');
            // The pre-existing present-check must survive alongside the
            // new password check — the not-present branch returns early.
        });
    });

    // MICROSOFT_TENANT_ID — a multi-tenant Entra authority is refused in
    // production. `common` lets any Entra directory in the world obtain a
    // token; combined with the address-matching link in the signIn callback
    // (an Entra token carries no email_verified claim, and the guard there
    // only rejects an explicit `false`) that composes into account takeover.
    //
    // The value used to default to `common`, so a deploy that forgot the
    // variable silently chose the widest authority. These cases pin both
    // halves: production refuses it, and dev/test keep booting without it.
    describe('MICROSOFT_TENANT_ID multi-tenant authority', () => {
        it('rejects NODE_ENV=production when the tenant is "common"', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:password@localhost:6379',
                STORAGE_PROVIDER: 'local',
                MICROSOFT_TENANT_ID: 'common',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('MICROSOFT_TENANT_ID');
            expect(result.error).toContain('MULTI-TENANT');
        });

        it('rejects the other multi-tenant authorities too, not just "common"', () => {
            // `organizations` and `consumers` are the same hazard. A guard
            // that only knew the literal "common" would pass while an
            // operator picked a synonym from Microsoft's own docs.
            for (const authority of ['organizations', 'consumers', 'COMMON']) {
                const result = runEnvScript({
                    NODE_ENV: 'production',
                    DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                    REDIS_URL: 'redis://:password@localhost:6379',
                    STORAGE_PROVIDER: 'local',
                    MICROSOFT_TENANT_ID: authority,
                });
                expect(result.success).toBe(false);
                expect(result.error).toContain('MICROSOFT_TENANT_ID');
            }
        });

        it('rejects NODE_ENV=production when the tenant is UNSET (the default applies)', () => {
            // The whole point: an absent variable used to mean `common`
            // silently. Absence must now be as loud as the literal.
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:password@localhost:6379',
                STORAGE_PROVIDER: 'local',
                MICROSOFT_TENANT_ID: undefined,
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('MICROSOFT_TENANT_ID');
        });

        it('accepts a multi-tenant authority when the operator opts in explicitly', () => {
            // The escape hatch has to work, or the refinement is a wall
            // rather than a gate and someone will delete it under deadline.
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:password@localhost:6379',
                STORAGE_PROVIDER: 'local',
                MICROSOFT_TENANT_ID: 'common',
                ENTRA_ALLOW_MULTITENANT: '1',
            });
            expect(result.success).toBe(true);
        });

        it('accepts a single-directory GUID in production', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:password@localhost:6379',
                STORAGE_PROVIDER: 'local',
                MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555',
            });
            expect(result.success).toBe(true);
        });

        it('accepts "common" under NODE_ENV=test (dev/test ergonomics preserved)', () => {
            // CI sets a fake tenant and dev sets nothing. Neither should
            // have to care, which is why the refinement is production-only.
            const result = runEnvScript({ NODE_ENV: 'test', MICROSOFT_TENANT_ID: 'common' });
            expect(result.success).toBe(true);
        });

        it('accepts "common" under NODE_ENV=development', () => {
            const result = runEnvScript({
                NODE_ENV: 'development',
                MICROSOFT_TENANT_ID: 'common',
            });
            expect(result.success).toBe(true);
        });
    });
});
