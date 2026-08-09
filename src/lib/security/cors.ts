/**
 * CORS policy resolution for the request/response boundary.
 *
 * Environment-aware origin allowlist:
 *
 *   ┌───────────────┬───────────────────────────────────────────────┐
 *   │ Environment   │ Allowed Origins                              │
 *   ├───────────────┼───────────────────────────────────────────────┤
 *   │ production    │ CORS_ALLOWED_ORIGINS only (fail closed)      │
 *   │ staging       │ CORS_ALLOWED_ORIGINS only (fail closed)      │
 *   │ development   │ CORS_ALLOWED_ORIGINS + http://localhost:*    │
 *   │ test          │ CORS_ALLOWED_ORIGINS + http://localhost:*    │
 *   └───────────────┴───────────────────────────────────────────────┘
 *
 * CRITICAL: In production/staging, if CORS_ALLOWED_ORIGINS is empty,
 * NO cross-origin requests are permitted. This is fail-closed by design.
 *
 * @see src/middleware.ts — the single application point for CORS headers
 */

export interface CorsConfig {
    /** Parsed list of allowed origins from env */
    allowedOrigins: string[];
    /** Whether the current environment permits localhost origins */
    allowLocalhost: boolean;
}

/**
 * Resolve the CORS configuration for the current environment.
 *
 * @param corsEnvVar - The raw CORS_ALLOWED_ORIGINS env value (comma-separated)
 * @param nodeEnv - The current NODE_ENV value
 * @returns CorsConfig with parsed origins and localhost policy
 */
export function resolveCorsConfig(
    corsEnvVar: string | undefined,
    nodeEnv: string
): CorsConfig {
    // Parse comma-separated origins, filter empty strings
    const allowedOrigins = (corsEnvVar || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

    // Localhost is ONLY permitted in development and test environments
    const allowLocalhost = nodeEnv === 'development' || nodeEnv === 'test';

    return { allowedOrigins, allowLocalhost };
}

/**
 * Check if a request origin is allowed by the current CORS policy.
 *
 * @param origin - The Origin header value from the request
 * @param config - The resolved CORS configuration
 * @returns true if the origin is allowed, false otherwise
 */
export function isOriginAllowed(origin: string, config: CorsConfig): boolean {
    if (!origin) return false;

    // Exact match against configured origins
    if (config.allowedOrigins.includes(origin)) return true;

    // Localhost match (development/test only)
    if (config.allowLocalhost && isLocalhostOrigin(origin)) return true;

    return false;
}

/**
 * Check if an origin is a localhost development origin.
 * Matches: http://localhost:PORT, http://127.0.0.1:PORT
 */
function isLocalhostOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        const hostname = url.hostname;
        return (
            url.protocol === 'http:' &&
            (hostname === 'localhost' || hostname === '127.0.0.1')
        );
    } catch {
        return false;
    }
}

/**
 * CORS headers to apply to a preflight (OPTIONS) response.
 */
export const CORS_PREFLIGHT_HEADERS = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-forwarded-for, x-request-id, user-agent',
    'Access-Control-Max-Age': '86400',
} as const;

/**
 * Apply CORS headers to a response for an allowed origin.
 *
 * @param headers - The response Headers object to modify
 * @param origin - The validated, allowed origin to echo back
 */
export function applyCorsHeaders(headers: Headers, origin: string): void {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.append('Vary', 'Origin');
}
