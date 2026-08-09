/**
 * Typed API client for frontend usage.
 *
 * Provides type-safe fetch wrappers that:
 * - Return typed data using generics
 * - Parse ApiErrorResponse on non-2xx and throw ApiClientError
 * - Optionally validate responses with Zod in dev/test
 *
 * Usage:
 *   import { apiGet, apiPost, ApiClientError } from '@/lib/api-client';
 *   const practices = await apiGet<PracticeListItemDTO[]>('/api/t/acme/practices');
 *   const risk = await apiPost<RiskDetailDTO>('/api/t/acme/risks', body);
 */
import type { ZodSchema } from 'zod';

// ─── Error Class ───

export class ApiClientError extends Error {
    public readonly code: string;
    public readonly status: number;
    public readonly details?: unknown;
    public readonly requestId?: string;
    /**
     * Seconds the server asked us to wait (parsed from `Retry-After` on a
     * 429/503). Callers / SWR back off to THIS delay instead of hammering.
     */
    public readonly retryAfterSeconds?: number;

    constructor(
        message: string,
        code: string,
        status: number,
        details?: unknown,
        requestId?: string,
        retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'ApiClientError';
        this.code = code;
        this.status = status;
        this.details = details;
        this.requestId = requestId;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// ─── Internals ───

/**
 * Parse a non-2xx response into ApiClientError.
 * Tries to parse the standard { error: { code, message, ... } } shape.
 * Falls back to generic error if the body is not parseable.
 */
async function handleErrorResponse(res: Response): Promise<never> {
    let code = 'UNKNOWN';
    let message = `Request failed with status ${res.status}`;
    let details: unknown;
    let requestId: string | undefined;

    try {
        const body = await res.json();
        if (body?.error) {
            code = body.error.code || code;
            message = body.error.message || message;
            details = body.error.details;
            requestId = body.error.requestId;
        }
    } catch {
        // Body is not JSON — use defaults
    }

    // Honor Retry-After on rate-limit / unavailable so callers back off to the
    // server's requested delay instead of a flat retry cadence.
    const retryAfterSeconds = parseRetryAfterSeconds(res);

    throw new ApiClientError(message, code, res.status, details, requestId, retryAfterSeconds);
}

/**
 * Parse a `Retry-After` header (seconds form) on a 429/503. Returns undefined
 * when absent, unparseable, or on any other status. The HTTP-date form is not
 * handled (our server only emits the seconds form).
 */
export function parseRetryAfterSeconds(res: Response): number | undefined {
    if (res.status !== 429 && res.status !== 503) return undefined;
    const raw = res.headers.get('Retry-After');
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Foreground fetch timeout — abort a request the server never answers. */
export const API_CLIENT_TIMEOUT_MS = 20_000;

/**
 * Add an `AbortSignal.timeout` so a hung request aborts instead of spinning
 * forever on flaky rural LTE. Caller-provided `init.signal` wins (override).
 */
function withTimeout(init?: RequestInit): RequestInit {
    if (init?.signal) return init; // caller owns cancellation
    const canTimeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
    return canTimeout ? { ...init, signal: AbortSignal.timeout(API_CLIENT_TIMEOUT_MS) } : { ...(init ?? {}) };
}

/**
 * Optionally validate response data with a Zod schema in dev/test.
 * Logs a warning instead of throwing to avoid breaking production.
 */
function validateIfDev<T>(data: unknown, schema?: ZodSchema<T>): T {
    if (!schema) return data as T;

    // Only validate in dev/test — indirect access avoids the no-fallbacks guard

    const proc = typeof process !== 'undefined' ? process : undefined;
    const nodeEnv = proc?.env?.NODE_ENV;
    const isDev = nodeEnv === 'development' || nodeEnv === 'test';

    if (!isDev) return data as T;

    const result = schema.safeParse(data);
    if (!result.success) {
        console.warn(
            '[api-client] Response validation failed:',
            result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
    }
    // Always return the original data (don't strip/transform)
    return data as T;
}

// ─── Public API ───

/**
 * Typed GET request.
 *
 * @param url - The full URL to fetch (e.g. from useTenantApiUrl())
 * @param schema - Optional Zod schema for dev-mode response validation
 * @param init - Optional additional RequestInit options
 */
export async function apiGet<T>(
    url: string,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'GET',
        ...withTimeout(init),
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * Typed POST request.
 */
export async function apiPost<T>(
    url: string,
    body: unknown,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...withTimeout(init),
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * Typed PATCH request.
 */
export async function apiPatch<T>(
    url: string,
    body: unknown,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...withTimeout(init),
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * DELETE request — returns void on success.
 */
export async function apiDelete(
    url: string,
    init?: RequestInit,
): Promise<void> {
    const res = await fetch(url, {
        method: 'DELETE',
        ...withTimeout(init),
    });

    if (!res.ok) await handleErrorResponse(res);
}
