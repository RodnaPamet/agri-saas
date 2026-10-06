/**
 * Sentry error reporting — BROWSER integration.
 *
 * The server SDK (`sentry.ts`) is initialised in `instrumentation.ts` on the
 * Node runtime, but nothing ever initialised Sentry on the CLIENT — so
 * `global-error.tsx`'s `captureException`, chunk-load failures, and client JS
 * crashes on rural devices were invisible (the only surviving client signal
 * was the anonymous web-vitals beacon). This is the missing client channel.
 *
 * Gated on `NEXT_PUBLIC_SENTRY_DSN`: absent ⇒ a NO-OP (a self-hosted deploy
 * stays clean), mirroring how VAPID gates web push. Deliberately conservative
 * for mobile / metered rural connections:
 *   - errors ALWAYS captured (`sampleRate: 1`) — the whole point,
 *   - traces sampled LOW (default 2%) — perf spans are nice-to-have,
 *   - NO session replay (`replays*SampleRate: 0`) — replay is a heavy,
 *     data-hungry channel we deliberately don't ship to field devices.
 * Releases are tagged so a field crash maps to the deploy that shipped it.
 *
 * Boundaries: OTel + the web-vitals beacon already own tracing and vitals;
 * this adds ONLY the client error channel, not a second copy of those.
 */
import * as Sentry from '@sentry/nextjs';
import { SENTRY_DATA_COLLECTION } from './sentry-data-collection';

let _clientInitialized = false;

export interface ClientSentryOptions {
    release?: string;
    environment?: string;
    /** Trace sample rate override (0..1). Default 0.02 — conservative on mobile. */
    tracesSampleRate?: number;
}

/**
 * Initialise the browser Sentry SDK. Safe to call multiple times — only the
 * first call with a DSN wires the SDK; without a DSN it's a permanent no-op.
 */
export function initClientSentry(dsn: string | undefined, opts: ClientSentryOptions = {}): void {
    if (_clientInitialized) return;
    _clientInitialized = true;
    if (!dsn) return; // no DSN ⇒ self-hosted / dev stays clean

    Sentry.init({
        dsn,

        // #1158 — explicit for the same reason as the server init: this was
        // unset, and `@sentry/nextjs` 11 enables data collection by default.
        // On the BROWSER side the default is what attaches the visitor's IP to
        // every event, so an inherited default is the difference between
        // knowing an error happened and recording who it happened to.
        // #1311 — same translation as the server init, from one shared
        // constant so the two sides cannot drift. Sentry 11 removed
        // `sendDefaultPii`; `dataCollection`'s fields all default to TRUE,
        // and on the browser side that default is what attaches the
        // visitor's identity to every event.
        dataCollection: SENTRY_DATA_COLLECTION,
        environment: opts.environment || process.env.NODE_ENV || 'production',
        release: opts.release,
        // Errors always on; traces low; NO session replay (see file header).
        sampleRate: 1,
        tracesSampleRate: opts.tracesSampleRate ?? 0.02,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
    });
}

/** Test-only — reset the once-guard so each case starts clean. */
export function __resetClientSentryForTests(): void {
    _clientInitialized = false;
}
