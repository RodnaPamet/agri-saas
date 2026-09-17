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
import type { ExecSyncOptions } from 'child_process';

/**
 * The base/template test database URL.
 * Priority: DATABASE_URL_TEST env > .env.test > test container default.
 *
 * `.env` is deliberately NOT a source. It names the DEV database, and reading
 * it here is what let a test run migrate a database nobody meant to touch —
 * see the container-default comment below for the incident. If none of the
 * three sources above is set, tests point at the test container and fail
 * loudly when it is not running, which is the correct outcome: a missing test
 * database is not a licence to use a live one.
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

    // 3. Test container default (docker-compose.test.yml → port 5435).
    //    Repo-SPECIFIC database name on purpose. This used to be
    //    `inflect_test`, which is the same name the inflect-compliance
    //    checkout uses on the same host+port — so a run that fell through
    //    to this fallback silently applied THIS repo's migrations to the
    //    other product's database (observed: a failed migration left
    //    behind in inflect's test DB).
    //
    //    That rename did not close the hole, because this branch used to
    //    only DECLARE the value while a later branch returned `.env` first —
    //    so the fix was unreachable whenever a `.env` existed, which is
    //    always. A fix documented as taking precedence is worthless if an
    //    earlier branch returns before it. It now returns.
    return 'postgresql://test:test@127.0.0.1:5435/agri_saas_test?schema=public';
}

/**
 * Databases a test run is allowed to create, migrate, clone and DROP.
 *
 * An ALLOWLIST, not a denylist. The predicate this replaced was
 * `base.includes('test')`, which is a denylist wearing an allowlist's
 * clothes: `inflect_compliance_test`, `agrent_production_testbed`,
 * `latest_backup`, `protest_db` and `contest_db` all pass it. Naming a
 * database we recognise means a database nobody anticipated fails CLOSED.
 *
 * `_w<n>` is the per-worker TEMPLATE clone globalSetup creates.
 */
const ALLOWED_TEST_DB = /^(agri_saas_test|ci_testdb)(_w\d+)?$/;

/**
 * Throw unless `url` names a database this repo's tests own.
 *
 * Call this BEFORE anything that writes — migrating, terminating
 * connections, creating or dropping. A check that runs after the damage
 * guards nothing.
 */
export function assertIsTestDatabase(url: string, what: string): void {
    const name = getDbName(url);
    if (ALLOWED_TEST_DB.test(name)) return;
    const safe = url.replace(/:[^@]*@/, ':***@');
    throw new Error(
        `${what}: refusing to run against database "${name}".\n` +
            `  resolved URL: ${safe}\n` +
            `  allowed:      agri_saas_test, ci_testdb (plus _w<n> worker clones)\n` +
            `A test run migrates, clones and DROPs databases. Pointing it at a ` +
            `database it does not own has destroyed another product's data in ` +
            `this repo's history.\n` +
            `Fix: start the test container (docker compose -f docker-compose.test.yml up -d), ` +
            `or export DATABASE_URL_TEST=postgresql://test:test@127.0.0.1:5435/agri_saas_test?schema=public`,
    );
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
export type MigrationRunner = (cmd: string, opts: ExecSyncOptions) => unknown;

export function migrateTestDb(run: MigrationRunner = execSync): 'migrated' | 'unreachable' {
    // Always migrate the BASE/template DB — globalSetup TEMPLATE-clones
    // it into per-worker DBs, so the migration only needs to run once.
    const url = getBaseTestDatabaseUrl();
    assertIsTestDatabase(url, 'migrateTestDb');
    // DIRECT_DATABASE_URL must be pinned too, not just DATABASE_URL:
    // prisma.config.ts reads `DIRECT_DATABASE_URL ?? DATABASE_URL`, so an
    // exported DIRECT_DATABASE_URL (direnv, a sourced .env, a compose env)
    // silently outranks the URL we just resolved and validated. jest.setup.js
    // pins it only in WORKERS — globalSetup runs before any worker — and it
    // is written to stand aside for an exported value, so it cannot help here.
    try {
        run('npx prisma migrate deploy', {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
            stdio: 'pipe',
            timeout: 60_000,
        });
        return 'migrated';
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // UNREACHABLE is tolerated on purpose: this repo runs guard and unit
        // suites with no database at all, and `DB_AVAILABLE`
        // (tests/integration/db-helper.ts) already skips the suites that need
        // one. The caller must not claim the migration succeeded.
        if (/P1001|ECONNREFUSED|ENOTFOUND|Can't reach database server/i.test(msg)) {
            return 'unreachable';
        }
        // Any OTHER failure is a real migration error. Tolerating it is what
        // let suites run against a database that IS reachable but was never
        // migrated — the dangerous half, because DB_AVAILABLE is a liveness
        // probe and cannot see a failed migration.
        throw err;
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
    // This list is deliberately NOT exhaustive — `Tenant`, `User` and the
    // rest of the fixture scaffolding survive a reset, and several
    // integration suites depend on that. It is the set of per-test
    // content tables, and it is hand-maintained.
    //
    // It rotted for months without a symptom. Until GRC teardown phase 3
    // it still named `Membership` (never a model in this schema — it is
    // `TenantMembership`), `Risk` (removed by the risk uproot), and 18
    // GRC tables. Every one of those hit the `catch` below, which
    // swallowed the error, so the list got shorter in effect while
    // staying long on the page: a test whose rows were never truncated
    // simply saw leftovers from the previous test and, most of the time,
    // did not care.
    //
    // Hence the throw. An unknown table is now a loud failure naming the
    // entry, not a silent no-op — the whole point of a reset helper is
    // that "it ran" and "it worked" are the same statement.
    const tables = [
        'AuditLog', 'TaskLink', 'TaskComment', 'TaskWatcher', 'Task',
        'EvidenceReview', 'Evidence', 'FileRecord', 'Asset',
    ];

    // Use raw SQL for speed — TRUNCATE CASCADE handles FK constraints
    for (const table of tables) {
        try {
            await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
        } catch (err) {
            throw new Error(
                `resetDatabase: TRUNCATE "${table}" failed — is it still a model? ` +
                    `Remove it from the list in tests/helpers/db.ts if it was dropped. ` +
                    `Cause: ${(err as Error).message}`,
            );
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
