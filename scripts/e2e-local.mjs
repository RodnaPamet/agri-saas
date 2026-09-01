#!/usr/bin/env node
/**
 * Local E2E pipeline — cross-platform (Windows/macOS/Linux).
 *
 * Steps: docker up → migrate → seed → build → playwright test
 *
 * Usage:
 *   node scripts/e2e-local.mjs             # full pipeline
 *   node scripts/e2e-local.mjs --skip-db   # skip docker (DB already running)
 *   node scripts/e2e-local.mjs --headed    # run Playwright in headed mode
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const SKIP_DB = args.includes('--skip-db');
const HEADED = args.includes('--headed');

// ── Load .env.e2e if present ──
const envFile = join(ROOT, '.env.e2e');
const envVars = {};
if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            envVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
    }
}

const TEST_DB_URL = envVars.DATABASE_URL_TEST
    || process.env.DATABASE_URL_TEST
    || 'postgresql://test:test@localhost:5434/inflect_test?schema=public';

const env = {
    ...process.env,
    ...envVars,
    DATABASE_URL: TEST_DB_URL,
    DATABASE_URL_TEST: TEST_DB_URL,
    DIRECT_DATABASE_URL: TEST_DB_URL,
    AUTH_TEST_MODE: '1',
    SKIP_ENV_VALIDATION: '1',
    AUTH_SECRET: envVars.AUTH_SECRET || process.env.AUTH_SECRET || 'dev-local-secret-not-for-production-at-all-ever-ever-9',
    AUTH_URL: envVars.AUTH_URL || process.env.AUTH_URL || 'http://127.0.0.1:3006',
    PORT: '3006',
    NODE_ENV: 'test',
    // `next start` resets process.env.NODE_ENV to "production" at
    // runtime regardless of what cross-env passed in. The Epic B
    // encryption module reads NODE_ENV at runtime and demands a real
    // DATA_ENCRYPTION_KEY when it sees "production" — so we provide
    // a deterministic 32+ char test key here. NOT a real secret;
    // visible in source so no operator confuses it for prod.
    DATA_ENCRYPTION_KEY:
        envVars.DATA_ENCRYPTION_KEY ||
        process.env.DATA_ENCRYPTION_KEY ||
        'e2e-deterministic-test-encryption-key-32+-chars',
};

const uploadDir = env.FILE_STORAGE_ROOT || env.UPLOAD_DIR || join(ROOT, 'tmp', 'test-uploads');
mkdirSync(uploadDir, { recursive: true });

function run(cmd, label, extraEnv = {}) {
    const stepEnv = { ...env, ...extraEnv };
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  → ${cmd}\n`);
    try {
        // 30-min timeout. The Playwright phase alone runs ~11 min on
        // `next start` (production mode), and historically ~38 min on
        // `next dev`. The previous 10-min cap aborted the wrapper
        // mid-suite even though all tests passed — the playwright
        // child stayed alive but execSync threw ETIMEDOUT. Generous
        // budget here covers the full pipeline + retries.
        execSync(cmd, { cwd: ROOT, env: stepEnv, stdio: 'inherit', timeout: 1_800_000 });
    } catch (err) {
        console.error(`\n❌ FAILED: ${label}`);
        process.exit(1);
    }
}

const startTime = Date.now();
console.log('\n🎭 Local E2E Pipeline\n');

// ── 1. Start test DB ──
if (!SKIP_DB) {
    run('docker compose -f docker-compose.test.yml up -d --wait', '1/6  Start test database');
} else {
    console.log('\n⏭  Skipping DB start (--skip-db)\n');
}

// ── 2. Generate + Migrate + Seed ──
run('npx prisma generate', '2/6  Generate Prisma client');
// `prisma db push --force-reset` was the historical default but it
// SKIPS migrations entirely — applying the Prisma schema directly. That
// means the RLS-setup migration (which `GRANT`s SELECT/INSERT/UPDATE/
// DELETE on every table to `app_user`, plus `ALTER DEFAULT PRIVILEGES`
// for future tables) never runs, and every `runInTenantContext` query
// fails with `permission denied for schema public`. Use `migrate
// reset` so the migration history applies in order, then seed.
//
// Prisma 7 dropped the `--skip-seed` flag — the auto-seed only
// fires when `prisma.config.ts` declares `migrations.seed`, which
// we don't (we run the seed step explicitly below so seed errors
// surface in 3/6b rather than hiding inside reset).
run('npx prisma migrate reset --force', '3/6a Reset test database');
run('npx tsx prisma/seed.ts', '3/6b Seed test data');

// ── 4. Build ──
// NEXT_IGNORE_INCORRECT_LOCKFILE=1 prevents Next 14 from attempting
// to "patch" a lockfile missing SWC binaries — that patch path
// crashes with `Cannot read properties of undefined (reading 'os')`
// on this machine. The webServer.command in playwright.config.ts
// already sets the same flag for runtime; the build step needs it too.
// NEXT_TEST_MODE=1 routes the build to `.next-test/` (see distDir in
// next.config.js). The webServer command in playwright.config.ts also
// sets NEXT_TEST_MODE so `next start` reads from the same distDir; if
// the build skipped this flag the test server would error
// `Could not find a production build in the '.next-test' directory`.
run('npx next build --webpack', '4/6  Build Next.js (production)', {
    NODE_ENV: 'production',
    NEXT_IGNORE_INCORRECT_LOCKFILE: '1',
    NEXT_TEST_MODE: '1',
    // NEXT_PUBLIC_* values get inlined into the client bundle at
    // build time. Used by `<ClientProviders>` to suppress the
    // Driver.js onboarding-tour auto-trigger so the tour overlay
    // doesn't cover every authenticated page in E2E sessions.
    NEXT_PUBLIC_TEST_MODE: '1',
    // Hermetic basemap (#764) — the CLIENT half, inlined at build time, so
    // MapCanvas renders an inline network-free fixture style instead of
    // demotiles. The SERVER half (E2E_BASEMAP_FIXTURE_TILES) rides
    // playwright.config.ts's webServer.command, which this script invokes.
    NEXT_PUBLIC_MAP_BASEMAP_FIXTURE: '1',
});

// ── 5. Install Playwright browsers ──
run('npx playwright install chromium', '5/6  Install Playwright browsers');

// ── 6. Run E2E tests ──
const pwArgs = HEADED ? '--headed' : '';
run(`npx playwright test ${pwArgs}`.trim(), '6/6  Run Playwright E2E tests');

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(60)}`);
console.log(`  ✅ Local E2E passed in ${elapsed}s`);
console.log(`${'═'.repeat(60)}`);
console.log(`\n📊 Report: npx playwright show-report\n`);
