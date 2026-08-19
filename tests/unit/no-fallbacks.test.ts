import fs from 'fs';
import path from 'path';

function walkDir(dir: string, fileList: string[] = []) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            if (file !== 'node_modules' && file !== '.next') {
                walkDir(filePath, fileList);
            }
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

describe('Static Analysis: No process.env fallbacks', () => {
    it('should not contain forbidden process.env or secret fallback patterns in src', () => {
        const srcDir = path.resolve(__dirname, '../../src');
        const files = walkDir(srcDir);

        let foundErrors = false;

        for (const file of files) {
            // Ignore the env definition itself since it maps process.env
            if (file.endsWith('env.ts')) continue;
            // Infrastructure routes intentionally use process.env for env gating / build info
            if (file.includes('health') && file.includes('route.ts')) continue;
            if (file.includes('readyz') && file.includes('route.ts')) continue;
            if (file.includes('livez') && file.includes('route.ts')) continue;
            if (file.includes('staging') && file.includes('route.ts')) continue;
            // Stripe SDK wrapper intentionally uses process.env for lazy key loading
            if (file.endsWith('stripe.ts')) continue;
            // Observability modules bootstrap before env validation (OTel/Sentry/diagnostics)
            if (file.includes('observability')) continue;
            if (file.endsWith('instrumentation.ts')) continue;
            // Diagnostics endpoint reads runtime-only observability config (OTEL_*, SENTRY_*, LOG_LEVEL)
            if (file.includes('diagnostics') && file.includes('route.ts')) continue;
            // AV webhook uses process.env for webhook auth that must run before env validation
            if (file.includes('av-webhook') && file.includes('route.ts')) continue;
            // Encryption module reads DATA_ENCRYPTION_KEY directly (must work before env validation)
            if (file.endsWith('encryption.ts') && file.includes('security')) continue;
            // Redis connection helper reads REDIS_URL directly (graceful null when unconfigured, pre-env-validation)
            if (file.endsWith('redis.ts') && file.includes('lib')) continue;
            // Edge middleware reads CSP_REPORT_ONLY before env validation (optional runtime toggle)
            if (file.endsWith('middleware.ts') && !file.includes('pii-middleware')) continue;
            // Dub-ported utility files use process.env by upstream design
            if (file.includes('dub-utils')) continue;
            // ui-config endpoint is intentionally a runtime process.env
            // reader so operators can toggle AUTH_CREDENTIALS_UI_HIDDEN
            // without a rebuild/rollout (NEXT_PUBLIC_* inlines at build
            // time). See the docblock in the file.
            if (file.endsWith('ui-config/route.ts')) continue;
            // Rate-limit bypass predicate reads RATE_LIMIT_ENABLED /
            // NODE_ENV at request time so tests can flip the bypass
            // per-test via env mutation (used by the Epic A.2/A.3
            // suites and the Epic B end-to-end). Reading through the
            // cached env.ts snapshot would freeze the value at import
            // time and break those flows.
            if (file.endsWith('rate-limit-middleware.ts')) continue;
            // Outbound-webhook headers read AUDIT_STREAM_LEGACY_HEADERS at
            // call time (same convention as rate-limit-middleware.ts) so an
            // operator can flip the legacy X-Inflect-* dual-emit without a
            // redeploy, and the unit test can toggle it per-case via env
            // mutation. Reading the cached env.ts snapshot would freeze it.
            if (file.endsWith('webhook-headers.ts')) continue;
            // GAP-17 read-tier rate limiter follows the same convention
            // as rate-limit-middleware.ts above — NEXT_TEST_MODE must be
            // read at request time so the Playwright suite can flip the
            // bypass per-test without re-importing the module.
            if (file.endsWith('apiReadRateLimit.ts')) continue;
            // SCIM tier — same convention and the same reason as the read
            // tier directly above: NEXT_TEST_MODE has to be read at request
            // time so a test can flip the bypass without re-importing the
            // module. See src/lib/rate-limit/scimRateLimit.ts.
            if (file.endsWith('scimRateLimit.ts')) continue;
            // GAP-10 Swagger-UI route gates prod via process.env.NODE_ENV
            // (HARD 404 in production). Same rationale as health/readyz
            // routes above — env.ts snapshot freezes at import time and
            // the route MUST refuse to render under prod.
            if (file.endsWith('docs/route.ts')) continue;
            // GAP-18 billing entitlements reads STRIPE_SECRET_KEY at
            // module load to decide SaaS vs self-hosted mode. The
            // decision MUST happen before env.ts validation runs
            // because self-hosted deployments deliberately do not
            // configure STRIPE_SECRET_KEY (the variable is treated as
            // optional under that mode). Routing through env.ts
            // would force every self-hosted operator to set the
            // variable to satisfy schema validation, contradicting
            // the operating model documented in docs/billing.md.
            if (file.endsWith('billing/entitlements.ts')) continue;
            // ClientProviders gates the Driver.js onboarding-tour
            // auto-trigger via NEXT_PUBLIC_TEST_MODE. NEXT_PUBLIC_*
            // env vars MUST be read via `process.env.NEXT_PUBLIC_*`
            // for Next.js's build-time inlining to fire — env.ts
            // validates at runtime and would break the inlining.
            // The fallback to `process.env.NODE_ENV` covers test
            // environments that don't set NEXT_PUBLIC_TEST_MODE
            // explicitly (e.g. jsdom + jest).
            if (file.endsWith('layout/ClientProviders.tsx')) continue;
            // The operator-PWA service-worker registrar gates registration
            // on `process.env.NODE_ENV === 'production'` — a SW intercepting
            // fetches in dev fights Next.js HMR. Same rationale as the
            // swr-devtools / docs-route prod gates: env.ts's snapshot
            // freezes at import time, and a client prod-gate must read
            // NODE_ENV directly.
            if (file.endsWith('pwa/ServiceWorkerRegistrar.tsx')) continue;
            // use-calendar-badge gates the sidebar polling fetch via
            // NEXT_PUBLIC_TEST_MODE for the same build-time-inlining
            // reason. Two SidebarContent mounts × N test page loads
            // produced enough in-flight requests to keep
            // `waitForLoadState('networkidle')` from settling on slow
            // CI runners — see the docblock in use-calendar-badge.ts.
            if (file.endsWith('use-calendar-badge.ts')) continue;
            // Epic 69 SWRDevTools is dev-only by design — it gates
            // visibility on `process.env.NODE_ENV === 'development'`
            // AND `process.env.NEXT_PUBLIC_TEST_MODE === '1'` so
            // Next.js can tree-shake the entire panel from the prod
            // bundle. NEXT_PUBLIC_* MUST be read via process.env for
            // the build-time inlining to fire; routing through env.ts
            // would break the inlining (same rationale as
            // ClientProviders + use-calendar-badge above).
            if (file.endsWith('dev/swr-devtools.tsx')) continue;
            // PushOptIn reads NEXT_PUBLIC_VAPID_PUBLIC_KEY via process.env so
            // Next inlines it at build time (same rationale as ClientProviders
            // / swr-devtools above — env.ts would break the inlining).
            if (file.endsWith('pwa/PushOptIn.tsx')) continue;
            // InstallPrompt suppresses itself under NEXT_PUBLIC_TEST_MODE
            // (promotional chrome, like the onboarding tour) — read via
            // process.env for build-time inlining (same as ClientProviders).
            if (file.endsWith('pwa/InstallPrompt.tsx')) continue;
            // CoachMark suppresses its first-time hint bubble under
            // NEXT_PUBLIC_TEST_MODE (onboarding chrome, like InstallPrompt /
            // the tour) so the always-on-fresh-browser bubble can't intercept
            // taps in E2E — read via process.env for build-time inlining
            // (same rationale as ClientProviders / InstallPrompt above).
            if (file.endsWith('ui/coach-mark.tsx')) continue;
            // DeferredOnMobile reads process.env.NODE_ENV to render heavy
            // children eagerly under jest (jsdom resolves to "mobile"); a
            // client test-env gate must read NODE_ENV directly, same as the
            // ServiceWorkerRegistrar prod-gate above.
            if (file.endsWith('ui/DeferredOnMobile.tsx')) continue;
            // The stale-chunk recovery hook gates its auto-reload on
            // `process.env.NODE_ENV === 'production'` — a reload in dev fights
            // Next.js HMR, and it shares the same reload window as the
            // ServiceWorkerRegistrar prod-gate above. env.ts's snapshot freezes
            // at import time; a client prod-gate must read NODE_ENV directly.
            if (file.endsWith('pwa/use-chunk-error-recovery.ts')) continue;

            const content = fs.readFileSync(file, 'utf8');

            // Look for `process.env.Something`
            if (content.includes('process.env.')) {
                console.error(`Forbidden 'process.env' usage found in ${file}`);
                foundErrors = true;
            }

            // Look for `|| "secret"` or `|| 'secret'` pattern (simplistic regex but effective)
            if (/\|\|\s*["'].*secret.*["']/i.test(content)) {
                console.error(`Forbidden hardcoded secret fallback found in ${file}`);
                foundErrors = true;
            }
        }

        expect(foundErrors).toBe(false);
    });
});
