/**
 * Enhanced test database helpers.
 *
 * Extends the existing db-helper.ts with:
 * - migrateTestDb(): run prisma migrate deploy against test DB
 * - resetDatabase(): truncate all tables for clean state
 * - prismaTestClient(): get a connected PrismaClient for tests
 * - getTestDatabaseUrl(): resolve the test database URL
 *
 * Usage (integration tests):
 *   import { DB_AVAILABLE } from './db-helper';
 *   import { prismaTestClient, resetDatabase } from '../helpers/db';
 *   if (!DB_AVAILABLE) { test.skip('DB not available', () => {}); return; }
 *   const prisma = prismaTestClient();
 *   afterAll(() => prisma.$disconnect());
 *   beforeEach(() => resetDatabase(prisma));
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

/**
 * The base/template test database URL.
 * Priority: DATABASE_URL_TEST env > .env.test > test container default > .env > fallback.
 */
export function getBaseTestDatabaseUrl(): string {
    // 1. Explicit test env var (set by CI scripts or jest.setup.js)
    if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

    // 2. .env.test file
    const envTestPath = path.resolve(__dirname, '../../.env.test');
    try {
        const content = fs.readFileSync(envTestPath, 'utf8');
        const match = content.match(/^DATABASE_URL_TEST=["']?([^"'\n]*)["']?$/m)
            || content.match(/^DATABASE_URL=["']?([^"'\n]*)["']?$/m);
        if (match?.[1]) return match[1];
    } catch { /* no .env.test */ }

    // 3. Test container default (docker-compose.test.yml → port 5434).
    //    Repo-SPECIFIC database name on purpose. This used to be
    //    `inflect_test`, which is the same name the inflect-compliance
    //    checkout uses on the same host+port — so a run that fell through
    //    to this fallback silently applied THIS repo's migrations to the
    //    other product's database (observed: a failed migration left
    //    behind in inflect's test DB).
    const testContainerUrl = 'postgresql://test:test@127.0.0.1:5434/agri_saas_test?schema=public';

    // 4. Parse from .env (dev database)
    const envPath = path.resolve(__dirname, '../../.env');
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^DATABASE_URL="(.*)"/m);
        if (match?.[1]) return match[1];
    } catch { /* no .env */ }

    // Return test container URL as preferred fallback over hard-coded dummy
    return testContainerUrl;
}

// ─── Per-worker DB isolation (flake fix 2026-06) ──────────────────────
//
// Integration tests share one DB and TRUNCATE in beforeEach — safe only
// serially (`test:ci --runInBand`). Run in PARALLEL (`jest`), workers
// truncate each other's data mid-test → deadlocks + data races. Fix:
// when Jest runs >1 worker, globalSetup TEMPLATE-clones the migrated
// base DB into one DB per worker (`<base>_w<id>`) and writes a marker;
// each worker then targets its own DB. Serial runs (CI) skip this and
// stay on the shared base DB — that path is unchanged.

/**
 * Cross-process marker written by globalSetup describing the DB mode.
 * Repo-local (NOT os.tmpdir): a predictable name in the world-writable
 * temp dir is a symlink-race vector (CodeQL js/insecure-temporary-file).
 * node_modules/.cache is repo-scoped + gitignored.
 */
export const PER_WORKER_MARKER = path.resolve(
    __dirname,
    '../../node_modules/.cache/inflect-test-perworker.json',
);

interface PerWorkerInfo { perWorker: boolean; count: number; baseName: string; baseUrl: string }

/** Swap the database name in a Postgres URL, preserving everything else. */
export function withDbName(url: string, dbName: string): string {
    const u = new URL(url);
    u.pathname = '/' + dbName;
    return u.toString();
}

/** The database name from a Postgres URL (`agri_saas_test`). */
export function getDbName(url: string): string {
    return new URL(url).pathname.replace(/^\//, '');
}

/** Admin connection string (to the `postgres` DB, no Prisma-only params). */
export function adminConnectionString(): string {
    const u = new URL(getBaseTestDatabaseUrl());
    u.pathname = '/postgres';
    u.search = '';
    return u.toString();
}

let _perWorker: PerWorkerInfo | undefined;
function readPerWorker(): PerWorkerInfo {
    if (_perWorker !== undefined) return _perWorker;
    try {
        _perWorker = JSON.parse(fs.readFileSync(PER_WORKER_MARKER, 'utf8')) as PerWorkerInfo;
    } catch {
        _perWorker = { perWorker: false, count: 1, baseName: '', baseUrl: '' };
    }
    return _perWorker;
}

/**
 * True when Jest is running >1 worker (per-worker DB isolation active).
 * Timing-sensitive perf tests use this to skip under CPU contention —
 * their latency budgets are only meaningful in a serial run (CI uses
 * `--runInBand`, where this is false).
 */
export function isParallelRun(): boolean {
    return readPerWorker().perWorker;
}

/**
 * The test database URL for THIS worker. Falls back to the shared base
 * URL when per-worker isolation is off (serial runs / CI).
 */
export function getTestDatabaseUrl(): string {
    const info = readPerWorker();
    // Derive from the marker's base URL when per-worker isolation is on,
    // so the test client + jest.setup.js + globalSetup all agree on the
    // exact base (host/creds/dbname) before appending the worker suffix.
    if (!info.perWorker) return getBaseTestDatabaseUrl();
    const workerId = process.env.JEST_WORKER_ID || '1';
    const base = info.baseUrl || getBaseTestDatabaseUrl();
    return withDbName(base, `${getDbName(base)}_w${workerId}`);
}

/**
 * Run prisma migrate deploy against the test database.
 * Should be called in globalSetup or once before all integration tests.
 */
export function migrateTestDb(): void {
    // Always migrate the BASE/template DB — globalSetup TEMPLATE-clones
    // it into per-worker DBs, so the migration only needs to run once.
    const url = getBaseTestDatabaseUrl();
    try {
        execSync('npx prisma migrate deploy', {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, DATABASE_URL: url },
            stdio: 'pipe',
            timeout: 60_000,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[test-db] Migration failed (DB may not be running): ${msg.slice(0, 200)}`);
    }
}

/**
 * Create and return a PrismaClient connected to the test database.
 *
 * Prisma 7 — connections go through the adapter pattern instead of
 * `datasources: { db: { url } }`. The PII encryption middleware is
 * wired via `$extends` (was `$use` in v5). Both adapters take the
 * same env-derived URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prismaTestClient(): any {
    if (!_client) {
        const url = getTestDatabaseUrl();
        const adapter = new PrismaPg({ connectionString: url });
        const base = new PrismaClient({ adapter });
        // GAP-21: wire the same PII middleware production uses so
        // integration tests that write to encrypted-only models
        // (User, AuditorAccount, UserIdentityLink) auto-populate the
        // *Hash columns. Tests that need to bypass the middleware
        // (e.g. rls-isolation.test.ts) construct their own raw
        // PrismaClient and provide emailHash explicitly.
        //
        // Lazy require keeps this file importable from jest's
        // globalSetup context (which doesn't apply the moduleNameMapper
        // for the `@/` alias).

        const { withPiiEncryptionExtension } = require('../../src/lib/security/pii-middleware');
        _client = withPiiEncryptionExtension(base);
    }
    return _client;
}

/**
 * Truncate all application tables in the test database.
 * Preserves system tables (_prisma_migrations, etc).
 * Uses TRUNCATE CASCADE for PostgreSQL.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
    const tables = [
        'AuditLog', 'TaskLink', 'TaskComment', 'TaskWatcher', 'Task',
        'EvidenceReview', 'Evidence', 'FileRecord',
        'ControlRequirementLink', 'ControlRiskLink', 'ControlAssetLink',
        'Control', 'Risk', 'Asset',
        'AuditPackItem', 'AuditPack', 'AuditCycle',
        'PolicyVersion', 'Policy',
        'TestRunEvidence', 'TestRun', 'TestPlan',
        'VendorDocument', 'VendorAssessment', 'VendorContact', 'Vendor',
        'Membership', 'Framework', 'FrameworkRequirement',
    ];

    // Use raw SQL for speed — TRUNCATE CASCADE handles FK constraints
    for (const table of tables) {
        try {
            await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
        } catch {
            // Table may not exist in schema — skip silently
        }
    }
}

/**
 * Disconnect the singleton test client.
 */
export async function disconnectTestClient(): Promise<void> {
    if (_client) {
        await _client.$disconnect();
        _client = null;
    }
}
