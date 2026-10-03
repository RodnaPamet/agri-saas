/**
 * Sentry Error Reporting — server-side integration.
 *
 * Provides a thin wrapper around @sentry/nextjs for error capture with
 * requestId correlation and safe metadata. Noop when SENTRY_DSN is not set.
 *
 * SAFETY:
 *   - beforeSend strips authorization headers, cookies, and request bodies
 *   - Expected 4xx errors are not reported
 *   - Never sends secrets, tokens, or raw payloads
 *
 * ENV VARS:
 *   SENTRY_DSN                  — Sentry project DSN (noop if missing)
 *   SENTRY_ENVIRONMENT          — environment tag (default: NODE_ENV)
 *   SENTRY_TRACES_SAMPLE_RATE   — performance sample rate (default: 0 — use OTel)
 */

import * as Sentry from '@sentry/nextjs';
import { getRequestContext } from './context';

// ── State ──

let _initialized = false;

// ── Sensitive URL query params to redact ──

const SENSITIVE_PARAMS = new Set([
    'code', 'state', 'token', 'access_token', 'refresh_token',
    'id_token', 'client_secret', 'secret', 'SAMLResponse', 'RelayState',
    // Market-data API keys ride in the QUERY STRING, not a header —
    // alpha-vantage-client.ts and barchart-client.ts both build
    // `...?apikey=<key>`. Sentry's default HTTP breadcrumbs capture outbound
    // URLs, and rate-limit throws from those clients are the EXPECTED steady
    // state rather than a rare event, so without these the keys would be
    // shipped to a third party on a routine schedule.
    'apikey', 'api_key', 'apiKey', 'key',
]);

// ── Errors to ignore (expected / handled) ──

const IGNORED_ERROR_PATTERNS = [
    'NEXT_REDIRECT',
    'NEXT_NOT_FOUND',
    'DYNAMIC_SERVER_USAGE',
];

/**
 * Redact sensitive query parameters from a URL string.
 */
function redactUrl(url: string): string {
    try {
        const parsed = new URL(url, 'http://placeholder');
        for (const param of SENSITIVE_PARAMS) {
            if (parsed.searchParams.has(param)) {
                parsed.searchParams.set(param, '[Redacted]');
            }
        }
        // Return without the placeholder origin if original was relative
        return url.startsWith('http') ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
    } catch {
        return url;
    }
}

/**
 * Request headers never sent to Sentry.
 *
 * The first three are credentials. The rest carry the CALLER'S IP ADDRESS,
 * which `beforeSend` did not touch before #1158 — so an operator's address
 * reached a third party whenever a proxy set one, independently of
 * `sendDefaultPii`. Lower-cased because Sentry normalises header names.
 */
const REDACTED_HEADERS = [
    'authorization',
    'cookie',
    'x-api-key',
    'x-forwarded-for',
    'x-real-ip',
    'forwarded',
    'cf-connecting-ip',
    'true-client-ip',
] as const;

/**
 * Initialize Sentry SDK. Safe to call multiple times — only initializes once.
 * Noop when SENTRY_DSN is not set.
 */
export function initSentry(): void {
    if (_initialized) return;

    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        _initialized = true;
        return;
    }

    Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),

        // #1158 — EXPLICIT, not inherited. This was unset, so whatever the SDK
        // defaulted to governed, and `@sentry/nextjs` 11 enables data
        // collection by default and restructures this option. On a product
        // that encrypts farm free-text at rest and masks cadastre individuals
        // for GDPR, "whatever the next major defaults to" is not a privacy
        // posture. Setting it false means a future default cannot quietly
        // start attaching IPs, cookies and request bodies to every event.
        sendDefaultPii: false,

        // Don't send expected / handled errors
        beforeSend(event, hint) {
            const error = hint?.originalException;

            // Skip Next.js internal navigation errors
            if (error instanceof Error) {
                for (const pattern of IGNORED_ERROR_PATTERNS) {
                    if (error.message.includes(pattern) || error.name.includes(pattern)) {
                        return null;
                    }
                }
            }

            // Redact sensitive request data
            if (event.request) {
                if (event.request.headers) {
                    const headers = { ...event.request.headers };
                    for (const name of REDACTED_HEADERS) delete headers[name];
                    event.request.headers = headers;
                }
                // Never send full request body
                if (event.request.data) {
                    event.request.data = '[Filtered]';
                }
                // Redact sensitive URL params
                if (event.request.url) {
                    event.request.url = redactUrl(event.request.url);
                }
                if (event.request.query_string) {
                    event.request.query_string = '[Filtered]';
                }
            }

            // #1158 — the USER object, which nothing redacted before.
            //
            // `setUser({ id })` is deliberate: an opaque id is what makes an
            // error traceable to a report without naming anybody, and it is
            // kept. Everything else on this object is identifying — and
            // `ip_address` is the one the SDK fills in BY ITSELF when PII
            // collection is on, which is exactly what v11 changed the default
            // for. Keeping the id and dropping the rest means the opt-out
            // above and this scrub have to BOTH fail before an operator's IP
            // reaches a third party.
            if (event.user) {
                event.user = { id: event.user.id };
            }

            // Redact breadcrumb URLs
            if (event.breadcrumbs) {
                for (const crumb of event.breadcrumbs) {
                    if (crumb.data?.url && typeof crumb.data.url === 'string') {
                        crumb.data.url = redactUrl(crumb.data.url);
                    }
                }
            }

            return event;
        },

        // Ignore common noisy errors
        ignoreErrors: [
            'ResizeObserver loop',
            'ResizeObserver loop completed with undelivered notifications',
            'Non-Error exception captured',
            /^Loading chunk \d+ failed/,
            /^Loading CSS chunk \d+ failed/,
        ],
    });

    _initialized = true;
}

/** Check if Sentry has been initialized with a valid DSN. */
export function isSentryInitialized(): boolean {
    return _initialized;
}

/**
 * Flush pending Sentry events and close the client. Bounded by
 * `timeoutMs` — Sentry.close() takes its own timeout and never
 * throws, but we guard with Promise.race so a misbehaving transport
 * can't block shutdown past the graceful-shutdown budget.
 *
 * Noop when Sentry was never initialised (SENTRY_DSN unset).
 *
 * Safe to call multiple times.
 */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
    if (!_initialized) return;
    _initialized = false;

    await Promise.race([
        Sentry.close(timeoutMs).then(() => { /* discard boolean */ }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100)),
    ]);
}

/**
 * Capture an error in Sentry with request context correlation.
 *
 * Only captures errors with status >= 500 (server errors).
 * Skips 4xx (client/validation errors) to reduce noise.
 *
 * @param error — the error to capture
 * @param extra — optional metadata (requestId, route, method, status, etc.)
 */
export function captureError(
    error: unknown,
    extra?: {
        requestId?: string;
        route?: string;
        method?: string;
        status?: number;
        tenantId?: string;
        userId?: string;
        errorCode?: string;
    },
): void {
    // Noop when Sentry was never initialized (e.g. SENTRY_DSN unset).
    // Without this guard, Sentry.withScope below throws "is not a
    // function" on an unbound SDK and masks the real error being reported.
    if (!_initialized) return;

    // Skip 4xx — these are expected/handled
    if (extra?.status && extra.status < 500) return;

    // Auto-enrich from ALS context if extra not provided
    const ctx = getRequestContext();

    Sentry.withScope((scope) => {
        // Tags for filtering in Sentry dashboard
        scope.setTag('requestId', extra?.requestId || ctx?.requestId || 'unknown');
        if (extra?.route || ctx?.route) scope.setTag('route', extra?.route || ctx?.route || '');
        if (extra?.method) scope.setTag('method', extra.method);
        if (extra?.status) scope.setTag('statusCode', String(extra.status));
        if (extra?.errorCode) scope.setTag('errorCode', extra.errorCode);

        // Safe context (never include secrets)
        scope.setContext('request', {
            requestId: extra?.requestId || ctx?.requestId,
            route: extra?.route || ctx?.route,
            method: extra?.method,
            statusCode: extra?.status,
        });

        // User context (Sentry's built-in user tracking — safe fields only)
        const tenantId = extra?.tenantId || ctx?.tenantId;
        const userId = extra?.userId || ctx?.userId;
        if (userId || tenantId) {
            scope.setUser({
                id: userId,
                ...(tenantId && { tenantId } as Record<string, string>),
            });
        }

        if (error instanceof Error) {
            Sentry.captureException(error);
        } else {
            Sentry.captureException(new Error(String(error)));
        }
    });
}

/**
 * Set Sentry scope context from the current request.
 * Useful for enriching errors captured later in the same request lifecycle.
 */
export function setSentryContext(ctx: {
    requestId: string;
    tenantId?: string;
    userId?: string;
    route?: string;
}): void {
    Sentry.setTag('requestId', ctx.requestId);
    if (ctx.route) Sentry.setTag('route', ctx.route);
    if (ctx.tenantId) Sentry.setContext('tenant', { tenantId: ctx.tenantId });
    if (ctx.userId) Sentry.setUser({ id: ctx.userId });
}

/**
 * Reset init flag (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
    _initialized = false;
}
