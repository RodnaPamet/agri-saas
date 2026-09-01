import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// Always use a dedicated port for E2E tests to avoid conflicts with `npm run dev` on 3000.
// This ensures E2E tests always start their own server with AUTH_TEST_MODE=1.
const port = 3006;

export default defineConfig({
    testDir: './tests/e2e',
    globalSetup: './tests/e2e/global-setup.ts',
    // GAP-23: hard-deletes any tenants the suite created via
    // `createIsolatedTenant` (tracked in
    // `tests/e2e/.tenant-tracker.jsonl`). Idempotent — does
    // nothing when the file is absent. Failures don't abort the
    // run; the tracker file is preserved so the next run retries.
    globalTeardown: './tests/e2e/global-teardown.ts',
    timeout: 180_000,
    fullyParallel: false,
    forbidOnly: isCI,
    // BOTH CI and local runs use `next start` (production mode) — a
    // pre-compiled server that handles the full serial suite cleanly.
    // We previously used `next dev` locally, which JIT-compiles routes
    // and leaks memory over long sessions. The 30-ish spec serial suite
    // ran ~38 min and the dev server consistently degraded near the
    // end (ECONNREFUSED, 30-60s selector timeouts on pages that render
    // fine in isolation), producing 2-3 spurious failures per run that
    // 1 retry couldn't recover from because the server stayed slow.
    //
    // `scripts/e2e-local.mjs` already runs `next build` before kicking
    // off Playwright, so the build artifact is always fresh. Direct
    // `npx playwright test` invocations need a prior `npx next build`
    // (without it, `next start` errors out with a clear message).
    //
    // 2 retries on both — local can still hit transient localhost
    // races, but production-mode server eliminates the systematic
    // degradation flakes that were the dominant failure mode.
    retries: 2,
    // Serial (single worker) WITHIN a run. An intra-job `workers: 3` was
    // tried (for a faster E2E job) and REVERTED: despite per-test tenant
    // isolation, the heavier timing-sensitive flows — org/tenant creation,
    // audit-pack freeze/share-link, offline-queue flush, a11y scans — flaked
    // intermittently under parallel load on one runner (different specs
    // failed each run). So intra-run parallelism stays OFF. CI wall-clock is
    // instead cut by CROSS-JOB sharding: the `e2e-shard` matrix in
    // .github/workflows/ci.yml runs `--shard=i/2` on two runners, each with
    // its own isolated DB, each still serial here — no contention, no
    // coupling. `retries: 2` covers transient localhost races.
    workers: 1,
    reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.URL || 'http://localhost:3006',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'on',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
            // The `@mobile` specs assert phone-viewport layout + the mobile
            // bottom-tab nav; they'd be meaningless at the desktop 1280px
            // viewport, so the desktop project skips them (the mobile
            // projects below own them).
            grepInvert: /@mobile/,
        },
        // ── Mobile device matrix ──────────────────────────────────────
        // Runs every `@mobile`-tagged spec — the responsive pass
        // (`mobile-responsive.spec.ts`) AND the bottom-tab nav smoke
        // (`tests/e2e/mobile/**`). Both phones sit under the `md:` (768px)
        // breakpoint so the single-column stacking + the `md:hidden`
        // bottom-tab bar are exercised. `grep: /@mobile/` keeps desktop
        // specs from re-running here, so the serial suite doesn't balloon.
        //
        // Both run on the CHROMIUM engine. `Pixel 5` is Chromium-native.
        // `iPhone 13` uses the REAL iPhone viewport / touch / deviceScale /
        // UA from the device descriptor but overrides the engine to
        // chromium: the Linux WebKit build in CI can't hydrate the
        // client-rendered `/login` page (its credentials form is gated on a
        // post-hydration effect resolving the provider list), so NO e2e can
        // authenticate under WebKit. Running the iPhone-13 *profile* on
        // Chromium verifies one-thumb nav at exact iPhone metrics while
        // keeping CI green; `isMobile` / `hasTouch` are Chromium-supported.
        // Real-Safari coverage is deferred to the `/login`-hydration fix
        // (mobile-hardening), at which point this override + a `webkit`
        // install in CI restore it.
        {
            name: 'mobile-android',
            use: { ...devices['Pixel 5'] },
            grep: /@mobile/,
        },
        {
            name: 'mobile-iphone',
            use: { ...devices['iPhone 13'], browserName: 'chromium' },
            grep: /@mobile/,
        },
    ],
    webServer: {
        // AUTH_URL / NEXTAUTH_URL must match the actual test port. NextAuth's
        // reqWithEnvURL() rewrites the request origin to AUTH_URL for every
        // /api/auth/* request — any mismatch causes login redirects to land on
        // the wrong host and surfaces as spurious MissingCSRF / stuck-login
        // failures in Playwright.
        // Both CI and local use `next start` (production mode). See the
        // retries comment above for why local stopped using `next dev`.
        // PORT must be set explicitly because `next start -p` doesn't
        // propagate to the env that `auth-config.ts` reads at startup.
        // NEXT_PUBLIC_TEST_MODE=1 is mainly inlined at build time, but
        // keeping it on `next start` too is a belt-and-braces guard in
        // case some part of the runtime re-reads it. Suppresses the
        // Driver.js onboarding-tour auto-trigger so the tour overlay
        // doesn't cover every authenticated page in E2E sessions.
        // DATA_ENCRYPTION_KEY: `next start` overwrites process.env.NODE_ENV
        // to "production" regardless of what cross-env passed in. The Epic B
        // encryption sentinel inside src/instrumentation.ts reads NODE_ENV at
        // runtime and refuses to start a "production" process without a
        // 32+ char DATA_ENCRYPTION_KEY. We seed a default via shell `${VAR:-…}`
        // expansion (NOT cross-env, which would override the value the
        // surrounding env already set) so:
        //   • direct `npx playwright test …` works locally without env wiring
        //   • CI keeps its own `DATA_ENCRYPTION_KEY` (the seed step uses the
        //     same value, so the HMAC-derived `emailHash` matches between
        //     seed and login). Forcing a different value here causes
        //     `unknown_email` login failures because the seed and the
        //     webserver hash `admin@acme.com` under different keys.
        // NOT a real secret; visible in source so no operator confuses it
        // for prod.
        // E2E_SOIL_FIXTURE_TILES=1 is the same idea for the ISRIC soil WMS
        // (#782) — the SECOND third-party map origin, which #764's survey
        // missed. It needs no client half: unlike the basemap style, the soil
        // tile URL is already built by the host page as a same-origin proxy
        // template, so only the server end can reach ISRIC.
        // E2E_BASEMAP_FIXTURE_TILES=1 is the SERVER half of #764: the
        // per-location basemap proxy serves a fixture tile rather than
        // fetching demotiles. It is a plain server var read at RUNTIME, so
        // unlike a NEXT_PUBLIC_* flag ONE site here covers CI,
        // `scripts/e2e-local.mjs` and a bare `npx playwright test`.
        // The CLIENT half is NEXT_PUBLIC_MAP_BASEMAP_FIXTURE and must live on
        // the BUILD step (Next inlines NEXT_PUBLIC_* at build time) —
        // deliberately NOT repeated here, where it would be inert.
        command: `DATA_ENCRYPTION_KEY=\${DATA_ENCRYPTION_KEY:-e2e-deterministic-test-encryption-key-32+-chars} npx cross-env NODE_ENV=test NODE_OPTIONS="--max-old-space-size=4096" NEXT_IGNORE_INCORRECT_LOCKFILE=1 AUTH_TEST_MODE=1 NEXT_TEST_MODE=1 NEXT_PUBLIC_TEST_MODE=1 E2E_BASEMAP_FIXTURE_TILES=1 E2E_SOIL_FIXTURE_TILES=1 AUTH_URL=http://localhost:${port} NEXTAUTH_URL=http://localhost:${port} PORT=${port} npx next start -p ${port}`,
        port,
        reuseExistingServer: !isCI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
