/**
 * Integration test helper: synchronous DB availability check.
 * Used to conditionally skip integration test suites that require PostgreSQL.
 *
 * URL resolution order:
 *   1. DATABASE_URL_TEST env var (set by ci-local.mjs)
 *   2. .env.test file (DATABASE_URL_TEST or DATABASE_URL)
 *   3. .env file DATABASE_URL (dev database)
 *   4. Process env DATABASE_URL
 *   5. Hard-coded fallback
 */
import * as fs from 'fs';
import * as path from 'path';
import { getTestDatabaseUrl } from '../helpers/db';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Parse a key from an env file. Returns undefined if not found.
 */
function parseEnvKey(filePath: string, key: string): string | undefined {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const re = new RegExp(`^${key}=["']?([^"'\\n]*)["']?$`, 'm');
        return content.match(re)?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolve the database URL for integration tests.
 *
 * Delegates to the single source of truth `getTestDatabaseUrl()` so this
 * resolver can NEVER diverge from the app's prisma client + the test
 * prisma client: under per-worker isolation all three resolve to THIS
 * worker's cloned DB; serial/CI resolves to the shared base DB. (A prior
 * independent resolver here hit the base DB while the app hit the worker
 * clone — the cross-DB data-race that broke parallel integration runs.)
 * `parseEnvKey` + the chain below remain only as a non-jest fallback.
 */
function resolveDbUrl(): string {
    const fromHelper = getTestDatabaseUrl();
    if (fromHelper) return fromHelper;

    // ── Fallback chain (non-jest contexts) ──
    // 1. Explicit test env var (highest priority — set by CI scripts)
    if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

    // 2. .env.test file
    const envTestPath = path.join(ROOT, '.env.test');
    const fromEnvTest = parseEnvKey(envTestPath, 'DATABASE_URL_TEST')
        || parseEnvKey(envTestPath, 'DATABASE_URL');
    if (fromEnvTest) return fromEnvTest;

    // 3. Process env DATABASE_URL
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    // 4. .env file (dev database — standard local dev, no jest.setup)
    const envPath = path.join(ROOT, '.env');
    const fromEnv = parseEnvKey(envPath, 'DATABASE_URL');
    if (fromEnv) return fromEnv;

    // 5. Hard-coded fallback
    return 'postgresql://user:password@localhost:5432/testdb';
}

/**
 * Synchronous DB availability check.
 *
 * Attempts a Prisma `$connect()` + `$queryRaw` against the given URL.
 * Runs synchronously via spawnSync so it can gate `describe` / `describe.skip`
 * at module scope.
 *
 * Uses spawnSync (no shell) with the URL passed via environment variable to
 * avoid shell-escaping issues with special characters like & in pgbouncer URLs.
 */
/**
 * What the probe learned. THREE outcomes, not two.
 *
 *   'ok'       — connected and ran `SELECT 1`
 *   'refused'  — the probe finished and could NOT connect (no database)
 *   'unknown'  — the probe did not finish: timed out, was signalled, or
 *                could not be spawned
 *
 * The third used to be folded into the second, and that is the bug this
 * distinction fixes. `spawnSync` returns `status: null` on timeout, so
 * `result.status === 0` was false and the helper reported "no database" —
 * turning every integration suite into `describe.skip`. The run then got
 * GREENER by running less, which is the failure mode CLAUDE.md names first
 * under "a skipped suite is indistinguishable from a passing one".
 *
 * Measured 2026-09-29: with a mutation sweep loading the box to ~12, the
 * 30s probe timed out and a new integration suite reported `1 skipped`.
 * The database was up and connecting in 1.1 seconds. Raising the budget —
 * which is what the previous comment here did — makes the window smaller
 * without making the two cases distinguishable.
 */
import { classifyProbe, PROBE_SCRIPT, type DbProbeOutcome } from './db-probe';
export type { DbProbeOutcome } from './db-probe';

function probeOnce(url: string, timeoutMs: number): DbProbeOutcome {
    try {
        const { spawnSync } = require('child_process');
        return classifyProbe(
            spawnSync('node', ['-e', PROBE_SCRIPT], {
                timeout: timeoutMs,
                stdio: 'ignore',
                cwd: ROOT,
                env: { ...process.env, __DB_CHECK_URL: url },
            }),
        );
    } catch {
        return 'unknown';
    }
}

/**
 * Opt-in escalation, mirroring `RLS_GUARDRAIL_REQUIRE_DB` and
 * `BULLMQ_SMOKE_REQUIRE_REDIS`. Any environment that GUARANTEES a database
 * can set `INTEGRATION_REQUIRE_DB=1` to make "the integration suites did not
 * run" a red build instead of a quiet skip.
 */
const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';

function probeDb(url: string | undefined): DbProbeOutcome {
    if (!url) return 'refused';

    let outcome = probeOnce(url, 30_000);
    // RETRY an unfinished probe, with room. When the database is up this
    // costs ~1s; when it is absent we never get here, because a refusal
    // returns in milliseconds. So the retry is paid only in the case it is
    // for: a machine too busy to answer in time.
    if (outcome === 'unknown') outcome = probeOnce(url, 90_000);

    if (outcome === 'unknown') {
        const banner =
            '\n' +
            '='.repeat(72) + '\n' +
            '  DATABASE PROBE DID NOT FINISH — integration suites will SKIP.\n' +
            '  This is UNKNOWN, not "no database". The probe timed out twice\n' +
            '  (30s then 90s), which on a loaded machine says nothing about\n' +
            '  whether Postgres is reachable. Re-run when the box is quiet\n' +
            '  before believing any skip, and set INTEGRATION_REQUIRE_DB=1\n' +
            '  anywhere a database is guaranteed.\n' +
            '='.repeat(72) + '\n';
        // No eslint-disable: `no-console` does not apply under tests/, so the
        // directive would mute nothing and register as an unused-directive
        // warning — and the Lint gate counts SUPPRESSIONS, so a needless one
        // costs exactly what the finding it does not mute would.
        console.warn(banner);
        if (REQUIRE_DB) {
            throw new Error(
                'INTEGRATION_REQUIRE_DB=1 but the database probe did not finish. ' +
                    'Refusing to skip the integration suites silently.',
            );
        }
    }

    if (outcome === 'refused' && REQUIRE_DB) {
        throw new Error(
            'INTEGRATION_REQUIRE_DB=1 but no database is reachable at the resolved URL.',
        );
    }

    return outcome;
}

const dbUrl = resolveDbUrl();

export const DB_URL = dbUrl;

/**
 * WHY the suites are running or skipping, not just whether. A caller that
 * needs to tell "no database" from "could not tell" reads this.
 */
export const DB_PROBE: DbProbeOutcome = probeDb(dbUrl);
export const DB_AVAILABLE = DB_PROBE === 'ok';
