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
function checkDbAvailable(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const { spawnSync } = require('child_process');
        // Prisma 7 dropped the `datasources` constructor option; URLs
        // now flow in through a driver adapter (`@prisma/adapter-pg`).
        // Mirrors the singleton wiring in `src/lib/prisma.ts`.
        const script = [
            "const{PrismaClient}=require('@prisma/client');",
            "const{PrismaPg}=require('@prisma/adapter-pg');",
            'const u=process.env.__DB_CHECK_URL;',
            'const adapter=new PrismaPg({connectionString:u});',
            'const p=new PrismaClient({adapter});',
            'p.$connect()',
            '.then(()=>p.$queryRawUnsafe("SELECT 1"))',
            '.then(()=>{p.$disconnect();process.exit(0)})',
            '.catch(()=>{p.$disconnect().catch(()=>{});process.exit(1)})',
        ].join('');
        const result = spawnSync('node', ['-e', script], {
            // 30s, not 5s. This probe pays a cold Node start plus the Prisma
            // client's own load before it can even attempt a connection —
            // measured at ~7s on an ordinary dev machine, i.e. reliably over
            // the old budget. A timeout here reads as "no database", which
            // turns every integration suite into `describe.skip` and makes
            // the run GREENER by running less. An absent database still fails
            // fast (ECONNREFUSED returns in milliseconds), so the larger
            // budget costs nothing in the case it was guarding against.
            timeout: 30_000,
            stdio: 'ignore',
            cwd: ROOT,
            env: { ...process.env, __DB_CHECK_URL: url },
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

const dbUrl = resolveDbUrl();

export const DB_URL = dbUrl;
export const DB_AVAILABLE = checkDbAvailable(dbUrl);
