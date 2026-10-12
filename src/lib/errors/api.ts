import { NextRequest, NextResponse } from 'next/server';
import { toApiErrorResponse, codedForbidden } from './types';
import { runWithRequestContext, getRequestContext } from '@/lib/observability/context';
import { logger, extractErrorMeta } from '@/lib/observability/logger';
import { getTracer } from '@/lib/observability/tracing';
import { normaliseClient, normaliseDevice } from '@/lib/observability/usage-counter';
import { recordRequestMetrics, recordRequestError } from '@/lib/observability/metrics';
import { captureError } from '@/lib/observability/sentry';
import { SpanStatusCode } from '@opentelemetry/api';
import {
    enforceRateLimit,
    isRateLimitBypassed,
    API_MUTATION_LIMIT,
    SLOW_MODE_MUTATION_LIMIT,
    type RateLimitScope,
} from '@/lib/security/rate-limit-middleware';
import type { RateLimitConfig } from '@/lib/security/rate-limit';
import { resolveRequestUserId, resolveRequestIdentity } from '@/lib/security/rate-limit-identity';
import { API_VERSION, API_VERSION_HEADER } from '@/lib/api-version';

// Depending on the Node.js / Edge runtime version, crypto.randomUUID() is natively available globally.
// If it fails (e.g. extremely old runtimes), fallback to a simple Math.random() based ID.
function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}



// ─── Rate-limit options for the shared wrapper ───────────────────────
//
// Mutation methods (POST/PUT/DELETE/PATCH) are rate-limited by default
// using API_MUTATION_LIMIT. Routes that need a stricter or looser
// policy pass an options object; routes that need to opt out entirely
// (webhook receivers, health checks — almost always already not using
// this wrapper anyway) pass `rateLimit: false`.

const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Surfaces the deletion freeze does NOT cover (#1655).
 *
 * The owner's ruling is "no new content" during the 30-day grace period, and
 * these two prefixes are not content by construction: `/api/auth/` is session
 * lifecycle (getting in, getting out, proving who you are, rotating a
 * password) and `/api/account/` is self-service account management.
 *
 * **A PREFIX rule, not a per-route opt-out, and that is the load-bearing
 * choice.** Nine wrapped mutation routes would otherwise each need to remember
 * a flag — `account/deletion` (both methods), `auth/logout`, `auth/token`,
 * `auth/token/refresh`, and the four native `auth/native/*` POSTs the phone
 * signs in through. A forgotten one does not fail a test; it traps a person
 * inside the freeze with no way out. This file's own rate-limit comment records
 * the same lesson from the other side: the mechanism was opt-in and 343 of 346
 * routes keyed `anon`, because "an invariant that holds only when 346 authors
 * each remember it is not an invariant".
 *
 * The trailing slash is deliberate, per the `PUBLIC_PATH_PREFIXES` convention:
 * `/api/accountsomething` must not be exempted by `/api/account`.
 *
 * `GET /api/account/export` needs no entry — it is a GET, and the freeze only
 * ever applies to `MUTATION_METHODS`. It is named here anyway because Art 15
 * does not lapse because Art 17 was invoked, and a future reader wondering
 * whether the export survives the freeze should find the answer next to the
 * rule rather than have to derive it.
 */
const DELETION_FREEZE_EXEMPT_PREFIXES = ['/api/auth/', '/api/account/'] as const;

function isDeletionFreezeExempt(route: string): boolean {
    return DELETION_FREEZE_EXEMPT_PREFIXES.some((p) => route.startsWith(p));
}

export interface ApiWrapperOptions {
    /**
     * Rate-limit policy for this route.
     *   - omitted          → default API_MUTATION_LIMIT on mutation methods
     *   - `false`          → skip rate limiting entirely for this route
     *   - `{ ... }`        → custom config/scope/userId resolver
     */
    rateLimit?: false | {
        config?: RateLimitConfig;
        scope?: string;
        /**
         * OVERRIDE the default identity resolution.
         *
         * Rarely needed: the wrapper resolves the caller's user id itself
         * (`resolveRequestUserId`), so a route gets a `(IP, userId)` key with
         * no opt-in. Pass this only when the id that should bound the budget
         * is NOT the authenticated caller — e.g. a route acting on a TARGET
         * user, where keying by the admin would let one admin exhaust the
         * budget for every target.
         */
        getUserId?: (
            req: NextRequest,
        ) => string | null | undefined | Promise<string | null | undefined>;
        /**
         * Cap a SHARED RESOURCE instead of an individual caller.
         *
         * Returns a bucket derived from the REQUEST — typically path
         * segments. When present the key drops IP and userId entirely,
         * so every user of a tenant shares one budget (#1161).
         *
         * Derive it from the URL, not the database: this runs before the
         * handler, so a lookup here is work an unauthenticated caller can
         * make the server do.
         */
        getBucket?: (
            req: NextRequest,
        ) => string | null | undefined | Promise<string | null | undefined>;
    };
}

async function resolveRateLimitScope(
    req: NextRequest,
    options: ApiWrapperOptions['rateLimit'],
): Promise<RateLimitScope | null> {
    if (options === false) return null;
    if (!MUTATION_METHODS.has(req.method)) return null;
    if (isRateLimitBypassed()) return null;

    const config = options?.config ?? API_MUTATION_LIMIT;
    const scope = options?.scope ?? 'api-mutation';

    // BUCKET FIRST, because it decides whether the identity matters at all.
    // `getBucket` REPLACES the ip+userId portion of the key (#1161), so
    // resolving a userId for a bucketed route is work thrown away — and the
    // resolution below costs a JWE decode.
    let bucket: string | null | undefined;
    if (options?.getBucket) {
        try {
            bucket = await options.getBucket(req);
        } catch {
            // FAIL CLOSED onto the per-caller key rather than skipping the
            // limit. A resolver that throws must not be a way past the gate.
            bucket = null;
        }
    }

    // The userId is resolved BY DEFAULT, and `getUserId` is now an override
    // rather than the only way in.
    //
    // `buildRateLimitKey`'s docblock says "every authenticated preset MUST
    // keep the userId" and explains why: carrier-grade NAT puts thousands of
    // unrelated subscribers behind one public IPv4, so an IP-only key lets one
    // caller throttle a village. Measured before this change: 3 of 346 wrapped
    // route files passed a resolver, so 343 keyed `anon`. The mechanism was
    // never broken — it was OPT-IN, and an invariant that holds only when 346
    // authors each remember it is not an invariant.
    let userId: string | null | undefined;
    // P5.5a — slow mode narrows the DEFAULT tier only, and `usesDefaultTier`
    // is how that is decided. A route passing an explicit `config` has had its
    // budget chosen deliberately for that route, and in every case today that
    // choice is already tighter than `SLOW_MODE_MUTATION_LIMIT` — overriding
    // it would LOOSEN the route for a slow-mode account, which is backwards.
    const usesDefaultTier = options?.config === undefined;
    let effectiveConfig = config;

    // The CALLER, resolved once and reported separately from the id that bounds
    // the budget (#1655). The two are not the same thing and conflating them
    // would aim the deletion freeze at the wrong person:
    //
    //   - a `getUserId` route's `userId` is the TARGET of the action, so using
    //     it would ask whether the target asked to be deleted;
    //   - a `getBucket` route resolves no identity at all, and its one live
    //     instance is SENDING A MESSAGE — exactly what the freeze must stop.
    //
    // So this is resolved for every mutation, which costs the bucketed route a
    // JWE decode it used to skip. #1161 skipped it because the identity was
    // irrelevant to the KEY, and that is still true — the key is untouched.
    // What changed is that a second control now needs the answer.
    let callerUserId: string | null = null;

    if (bucket == null) {
        if (options?.getUserId) {
            try {
                userId = await options.getUserId(req);
            } catch {
                userId = null;
            }
            callerUserId = (await resolveRequestIdentity(req)).userId ?? null;
        } else {
            // One decode for all three answers — see `resolveRequestIdentity`.
            const identity = await resolveRequestIdentity(req);
            userId = identity.userId;
            callerUserId = identity.userId ?? null;
            if (usesDefaultTier && identity.slowMode) {
                effectiveConfig = SLOW_MODE_MUTATION_LIMIT;
            }
        }
    } else {
        callerUserId = (await resolveRequestIdentity(req)).userId ?? null;
    }
    // NOTE the two paths that deliberately do NOT get slow mode:
    //
    //   - a BUCKETED route (`getBucket`), because the bucket REPLACES the
    //     per-caller key entirely — the budget there caps a shared resource,
    //     and narrowing it for one caller would throttle everyone sharing it;
    //   - a route with a `getUserId` OVERRIDE, which exists precisely because
    //     the id bounding the budget is NOT the caller (a route acting on a
    //     target user). The account state to apply would be the target's,
    //     which is not a statement about who is making the request.
    //
    // Both are narrow and both are the existing semantics of those options
    // rather than new exceptions.

    return {
        scope: effectiveConfig === config ? scope : `${scope}-slow`,
        config: effectiveConfig,
        userId: userId ?? null,
        callerUserId,
        bucket: bucket ?? undefined,
    };
}

/**
 * The wrapped route handler's exported signature.
 *
 * GAP-05 is complete: every dynamic route handler under `src/app/api`
 * types `params` as `Promise<P>` and `await`s it (the Next 16 contract,
 * enforced by `tests/guards/async-params-route-typing.test.ts`), and the
 * runtime async-params shim was removed from `withApiErrorHandling`. So
 * the wrapper is now a straight pass-through of the inner handler's
 * `Context` — no `AsyncifyParams` transform, no dual sync/async shape.
 * Tests invoke wrapped exports with the same Next-shaped ctx
 * (`{ params: Promise.resolve({...}) }`).
 */
type ApiRouteHandler<Context> = (
    req: NextRequest,
    ctx: Context,
) => Promise<NextResponse | Response>;

/**
 * High-Order Wrapper for all app/api routes.
 *
 * Catch all throws (ZodError, AppError, primitive errors) and shapes them
 * into standardized ApiErrorResponse JSON payloads.
 *
 * Also provides:
 * - x-request-id for correlation tracking
 * - Observability request context (AsyncLocalStorage)
 * - Structured request lifecycle logs (start/end/error) via Pino
 * - OpenTelemetry root span (api.request) with HTTP attributes
 * - Request metrics (count, duration, errors)
 * - **Rate limiting (Epic A.2):** POST/PUT/DELETE/PATCH default to
 *   API_MUTATION_LIMIT. Pass `{ rateLimit: { config, scope } }` for
 *   stricter presets (LOGIN_LIMIT, API_KEY_CREATE_LIMIT), or
 *   `{ rateLimit: false }` to opt out.
 */
export function withApiErrorHandling<Context = unknown>(
    handler: (req: NextRequest, ctx: Context) => Promise<NextResponse | Response> | NextResponse | Response,
    options: ApiWrapperOptions = {},
): ApiRouteHandler<Context> {
    const impl = async (
        req: NextRequest,
        ctxIn: unknown,
    ): Promise<NextResponse | Response> => {
        // GAP-05 follow-up (Roadmap-6 P3): the transparent async-params
        // shim that once reified a Promise-shaped `ctx.params` to its
        // sync form was removed once every route handler migrated to
        // the Next 15 contract — each handler now types `params` as
        // `Promise<…>` and `await`s it itself. `withApiErrorHandling`
        // forwards `ctx` through untouched. (Unit tests that pass a
        // plain sync `params` object still work: a migrated handler's
        // `await params` resolves a non-thenable to itself.)
        const ctx = ctxIn as Context;
        const requestId = req.headers.get('x-request-id') || generateRequestId();
        const route = req.nextUrl.pathname;
        // P0.5 — resolved ONCE here rather than at each recordRequestMetrics call,
        // so a rate-limited request and a completed one cannot be attributed to
        // different clients. Both are low-cardinality enums and neither can fail
        // the request — see normaliseClient.
        //
        // `usageClient` also goes onto every request log line below, which is
        // only safe because it is NORMALISED rather than the raw header: an
        // attacker-controlled `x-agrent-client` is collapsed to one of a fixed
        // allowlist, or to `other`/`unknown`. Logging the raw header would put
        // unbounded caller-controlled text into the log stream. `usageDevice` is
        // deliberately NOT logged — three values that answer no question the
        // client axis does not already answer, and every field on a
        // per-request line is paid on every request.
        const usageClient = normaliseClient(req.headers.get('x-agrent-client'));
        const usageDevice = normaliseDevice(req.headers.get('sec-ch-ua-mobile'));
        const method = req.method;
        const startTime = performance.now();

        // Run the entire request inside an observability context so that
        // any downstream code can access requestId/route via getRequestContext().
        // tenantId and userId are enriched later by getTenantCtx/getLegacyCtx.
        return runWithRequestContext(
            { requestId, route, startTime },
            async () => {
                // ── OTel root span ──
                const tracer = getTracer();
                return tracer.startActiveSpan('api.request', async (span) => {
                    span.setAttributes({
                        'http.method': method,
                        'http.route': route,
                        'app.requestId': requestId,
                    });

                    // ── Request started ──
                    logger.info('request started', {
                        component: 'api',
                        method,
                        client: usageClient,
                    });

                    try {
                        // ── Rate-limit check (Epic A.2) ──
                        const rateScope = await resolveRateLimitScope(req, options.rateLimit);
                        if (rateScope) {
                            const { response: rateBlocked } = await enforceRateLimit(
                                req,
                                rateScope,
                            );
                            if (rateBlocked) {
                                const durationMs = Math.round(
                                    performance.now() - startTime,
                                );
                                span.setAttributes({
                                    'http.status_code': 429,
                                    'rate_limit.scope': rateScope.scope,
                                });
                                span.setStatus({ code: SpanStatusCode.OK });
                                recordRequestMetrics({
                                    method,
                                    route,
                                    status: 429,
                                    durationMs,
                                    client: usageClient,
                                    device: usageDevice,
                                });
                                logger.warn('request rate-limited', {
                                    component: 'api',
                                    method,
                                    scope: rateScope.scope,
                                    durationMs,
                                    client: usageClient,
                                });
                                rateBlocked.headers.set('x-request-id', requestId);
                                rateBlocked.headers.set(API_VERSION_HEADER, API_VERSION);
                                return rateBlocked;
                            }
                        }

                        // ── The deletion freeze (#1655) ──
                        //
                        // The privacy notice tells people, in both locales,
                        // that asking to be deleted stops the account straight
                        // away. Until this landed the request wrote
                        // `deletionRequestedAt`, revoked sessions, and nothing
                        // else read the column — so a person who signed back in
                        // could keep posting for the full 30 days while the
                        // notice said otherwise.
                        //
                        // HERE and not in `getSessionOrThrow`, where P5.9's
                        // suspension check lives, for two reasons: that choke
                        // point governs READS too and the ruling is "no new
                        // content" rather than "no access"; and both escape
                        // hatches resolve through it, so a check there would
                        // block the route out of the freeze — the
                        // `slow-mode-escape-is-not-throttled` failure exactly.
                        //
                        // The id is REUSED from the rate-limit scope where one
                        // was resolved, so the common mutation pays no second
                        // JWT decode; only a `rateLimit: false` route does its
                        // own.
                        if (
                            MUTATION_METHODS.has(method) &&
                            !isDeletionFreezeExempt(route)
                        ) {
                            // `callerUserId`, never `userId` — see
                            // `resolveRateLimitScope`. The own-decode branch is
                            // only for a `rateLimit: false` route, where no
                            // scope was resolved at all.
                            const frozenUserId = rateScope
                                ? rateScope.callerUserId
                                : (await resolveRequestIdentity(req)).userId;
                            // LAZY, and not for performance. A static import
                            // pulls the Prisma client into this module's graph,
                            // and this module is imported by ~65 unit suites
                            // through the route they test — two of them mock
                            // `@/lib/db/rls-middleware` partially and died with
                            // `withRlsTripwireExtension is not a function`, the
                            // repo's partial-barrel-mock trap. Loading it here
                            // costs nothing real: a non-exempt mutation is
                            // about to touch the database anyway, so the module
                            // is already warm, and the import cache makes it
                            // once per process.
                            const { isDeletionPending } = await import(
                                '@/lib/auth/deletion-pending'
                            );
                            if (frozenUserId && (await isDeletionPending(frozenUserId))) {
                                // A DISTINCT code, never `ACCOUNT_SUSPENDED`:
                                // the cause and the remedy differ, and a person
                                // who asked to leave must not be told a
                                // moderator stopped them. The remedy is
                                // `DELETE /api/account/deletion`, which the
                                // prefix rule above keeps reachable.
                                throw codedForbidden(
                                    'ACCOUNT_DELETION_PENDING',
                                    'ACCOUNT_DELETION_PENDING',
                                );
                            }
                        }

                        // Execute the original handler
                        const response = await handler(req, ctx);

                        const status = response.status;
                        const durationMs = Math.round(performance.now() - startTime);

                        // ── Span + metrics ──
                        span.setAttributes({ 'http.status_code': status });
                        span.setStatus({ code: SpanStatusCode.OK });
                        recordRequestMetrics({
                            method, route, status, durationMs,
                            client: usageClient, device: usageDevice,
                        });

                        // ── Request completed ──
                        logger.info('request completed', {
                            component: 'api',
                            method,
                            status,
                            durationMs,
                            client: usageClient,
                        });

                        // Apply request ID + API version header. Wrapped
                        // (canonical-contract) routes ALL emit X-API-Version;
                        // future breaking changes bump it in `src/lib/api-version.ts`.
                        if (response instanceof NextResponse) {
                            response.headers.set('x-request-id', requestId);
                            response.headers.set(API_VERSION_HEADER, API_VERSION);
                        } else if (response instanceof Response) {
                            // clone and append headers if plain standard Response
                            const newHeaders = new Headers(response.headers);
                            newHeaders.set('x-request-id', requestId);
                            newHeaders.set(API_VERSION_HEADER, API_VERSION);
                            return new Response(response.body, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: newHeaders
                            });
                        }

                        return response;

                    } catch (error) {
                        // Unhandled throw! Map it.
                        const { payload, status } = toApiErrorResponse(error, requestId);
                        const durationMs = Math.round(performance.now() - startTime);

                        // ── Span error ──
                        span.setAttributes({ 'http.status_code': status });
                        span.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: error instanceof Error ? error.message : String(error),
                        });
                        if (error instanceof Error) {
                            span.recordException(error);
                        }

                        // ── Metrics ──
                        recordRequestMetrics({
                            method, route, status, durationMs,
                            client: usageClient, device: usageDevice,
                        });
                        recordRequestError({ method, route, errorCode: payload.error.code });

                        // ── Sentry error capture (5xx only — skips 4xx) ──
                        const reqCtx = getRequestContext();
                        captureError(error, {
                            requestId,
                            route,
                            method,
                            status,
                            tenantId: reqCtx?.tenantId,
                            userId: reqCtx?.userId,
                            errorCode: payload.error.code,
                        });

                        // ── Request failed ──
                        logger.error(`request failed ${status} ${method} ${route}`, {
                            component: 'api',
                            method,
                            status,
                            durationMs,
                            errorCode: payload.error.code,
                            error: extractErrorMeta(error),
                            client: usageClient,
                        });

                        return NextResponse.json(payload, {
                            status,
                            headers: {
                                'x-request-id': requestId,
                                [API_VERSION_HEADER]: API_VERSION,
                                'Cache-Control': 'no-store, max-age=0'
                            }
                        });
                    } finally {
                        span.end();
                    }
                });
            },
        );
    };
    return impl as ApiRouteHandler<Context>;
}

