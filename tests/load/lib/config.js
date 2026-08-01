// Shared k6 scenario config. Reads everything from environment so the
// same script works across local dev, CI, and against a remote staging
// environment without code changes.
//
// Defaults match prisma/seed.ts so a clean `npm run db:reset` is the
// only setup needed for local runs.

export function loadConfig() {
    return {
        // Target host. E2E uses :3006 (production-mode `next start`),
        // dev uses :3000. Either is fine — the scripts don't care.
        baseUrl: __ENV.BASE_URL || 'http://localhost:3006',

        // Seeded credentials from prisma/seed.ts (admin@acme.com).
        // Use a dedicated load-test user against staging/prod by
        // setting LOAD_TEST_EMAIL + LOAD_TEST_PASSWORD.
        email: __ENV.LOAD_TEST_EMAIL || 'admin@acme.com',
        password: __ENV.LOAD_TEST_PASSWORD || 'password123',

        // Seeded tenant slug.
        tenant: __ENV.LOAD_TEST_TENANT || 'acme-corp',

        // Concurrency + sustained duration for the steady-state phase.
        // Used by the ramping-vus executor stages in each scenario.
        vus: parseInt(__ENV.VUS || '50', 10),
        duration: __ENV.DURATION || '2m',

        // Ramp profile (kept short by default so a single 2 min run is
        // dominated by steady-state samples, not the ramp).
        rampUp: __ENV.RAMP_UP || '30s',
        rampDown: __ENV.RAMP_DOWN || '15s',

        // The same three durations as integer seconds. Scenarios that
        // need to do arithmetic on the profile — schedule a second
        // scenario to start after the first ends, or derive a
        // throughput floor from the window length — cannot do it with
        // the '30s' / '2m' strings k6 wants in its executor config.
        durationSec: toSeconds(__ENV.DURATION || '2m'),
        rampUpSec: toSeconds(__ENV.RAMP_UP || '30s'),
        rampDownSec: toSeconds(__ENV.RAMP_DOWN || '15s'),

        // Uncontended-latency regime (auth.js). A small fixed VU count
        // with no think-time, so there is never more than `latencyVus`
        // logins in flight and http_req_duration measures service time
        // rather than queue depth. See the auth.js docblock.
        latencyVus: parseInt(__ENV.LATENCY_VUS || '1', 10),
        latencySeconds: parseInt(__ENV.LATENCY_SECONDS || '60', 10),
    };
}

/**
 * Parse a k6 duration string ('30s', '2m', '1h') to whole seconds.
 * k6's own parser isn't exposed to scripts, and these values have to
 * be added together to schedule sequential scenarios.
 */
export function toSeconds(spec) {
    const m = String(spec).match(/^(\d+)\s*(ms|s|m|h)?$/);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
        case 'ms':
            return Math.ceil(n / 1000);
        case 'm':
            return n * 60;
        case 'h':
            return n * 3600;
        default:
            return n;
    }
}
