/**
 * Is rate limiting bypassed for this process? — extracted from
 * `rate-limit-middleware.ts` so a WORKER can ask without importing Next.
 *
 * ## Why this module exists at all
 *
 * The predicate is four `process.env` reads and needs nothing else. It lived
 * in `rate-limit-middleware.ts`, which imports `NextResponse` from
 * `next/server` — and that put a Next-only module into the BullMQ worker's
 * bundle through a chain nobody intended:
 *
 *   scripts/worker.ts
 *     -> jobs/executor-registry -> jobs/classify-photo -> usecases/rag
 *     -> ai/routing -> rate-limit/aiRateLimit -> security/rate-limit-middleware
 *
 * `scripts/build-worker.mjs` keeps node_modules external (`packages:
 * 'external'`), so the bundle emitted a BARE `from "next/server"`. Plain Node
 * cannot resolve that, because next@16.4.x ships no `exports` map — measured on
 * 16.4.3 and 16.4.4, so it is not a version regression:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '/app/node_modules/next/server' imported from /app/dist/worker.mjs
 *
 * The worker crash-looped on startup from the first publish after #2784 added
 * the `rag -> ai/routing` edge, and every background job stopped for ~12-17
 * hours: notification digests, expiry sweeps, the mail canary, compliance
 * snapshots, and the BullMQ health beat. Nothing paged, because the GCP uptime
 * check probes `/api/readyz` on the APP tier and the app tier was healthy.
 *
 * ## Why not a dynamic import at the call site
 *
 * Tried first, and it does not work: esbuild BUNDLES `await import()` when
 * code splitting is off, so the edge stayed in the graph and the bare import
 * survived. Measured on the rebuilt bundle rather than discovered on the VM.
 * Moving the symbol is what actually removes the edge.
 *
 * ## `process.env` directly, not `src/env.ts`
 *
 * Carried over verbatim from the original: the validated `env` snapshot is
 * captured at first import and would not pick up a per-test flip, and these
 * toggles are flipped mid-process by tests.
 */
export function isRateLimitBypassed(): boolean {
    if (process.env.RATE_LIMIT_ENABLED === '0') return true;
    if (process.env.AUTH_TEST_MODE === '1') return true;
    if (process.env.NEXT_TEST_MODE === '1') return true;
    if (
        process.env.NODE_ENV === 'test' &&
        process.env.RATE_LIMIT_ENABLED !== '1'
    ) {
        return true;
    }
    return false;
}
