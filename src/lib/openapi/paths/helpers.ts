/**
 * The shared shape of every documented operation (#944).
 *
 * ## Why path specs live HERE and not beside the handlers
 *
 * The obvious home for a `registerPath` call is the route file it describes,
 * where it cannot drift. That is not available: the spec is built by
 * `scripts/openapi-build.ts`, which `tests/contracts/api-schemas.test.ts`
 * imports at module scope — so its import graph is evaluated with **no
 * `jest.mock` available**. 319 of the 352 `route.ts` files pull in prisma or
 * `next/server` transitively (`@/app-layer/context` → `@/lib/auth`; usecases →
 * repositories → prisma), so co-locating would drag auth, Redis and the Earth
 * Engine client into spec generation.
 *
 * Deriving them from an AST walk is also not enough: that recovers method and
 * path but not the RESPONSE shape, and the response is where the value is.
 * `GET /journal` alone returns three different bodies depending on its query.
 *
 * So: sidecar modules, one per domain, sharded to stay reviewable — and a
 * guard (`tests/guards/openapi-paths-complete.test.ts`) that compares the
 * registered paths against the route files on disk, so a NEW route without a
 * spec fails CI rather than going quietly undocumented. The existing tail sits
 * on a shrinking baseline beside that guard; it is gated, not yet described.
 *
 * Both sentences above described the guard for weeks before it existed.
 *
 * ## The minimum honest operation
 *
 * A path with no response schema is the same empty-selection defect one level
 * down — a spec that lists endpoints and describes none of them would satisfy
 * "paths is non-empty" while telling a client nothing. So `op()` requires a
 * 2xx with content, and attaches the standard error envelope every route
 * shares through `withApiErrorHandling`.
 */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
// `ZodObject`, not `AnyZodObject` — the latter is zod v3 vintage and this
// repo is on zod 4.
import type { ZodObject, ZodTypeAny } from 'zod';
import { ApiErrorResponseSchema, RawErrorResponseSchema } from '@/lib/dto/common';

/** The auth schemes the API actually uses. Registered once, referenced by name. */
export function registerSecuritySchemes(registry: OpenAPIRegistry): void {
    registry.registerComponent('securitySchemes', 'sessionCookie', {
        type: 'apiKey',
        in: 'cookie',
        name: 'next-auth.session-token',
        description:
            'NextAuth session cookie. The default for browser clients. `src/middleware.ts` ' +
            'answers an unauthenticated API route with 401 JSON rather than a redirect.',
    });
    registry.registerComponent('securitySchemes', 'bearerToken', {
        type: 'http',
        scheme: 'bearer',
        description:
            'Access token from `POST /api/auth/token`, bound to the same UserSession as the ' +
            'cookie. Used by native clients; `auth()` resolves it via resolveBearerSession.',
    });
    registry.registerComponent('securitySchemes', 'platformAdminKey', {
        type: 'apiKey',
        in: 'header',
        name: 'x-platform-admin-key',
        description: 'PLATFORM_ADMIN_API_KEY, compared in constant time. Tenant-bootstrap surface only.',
    });
    registry.registerComponent('securitySchemes', 'scimBearer', {
        type: 'http',
        scheme: 'bearer',
        description:
            'Opaque SCIM token compared against a hash in TenantScimToken. Verified in the ' +
            'HANDLER, not at the Edge — the Edge has no database.',
    });
}

/**
 * The errors EVERY route can return, because they come from the layers above
 * the handler rather than from the handler itself.
 *
 * 426 is here deliberately: `src/middleware.ts` returns it on any API route
 * whose declared client version is below the floor, so it is part of the
 * contract for every operation — and a client that mistakes it for a payload
 * rejection parks its queue (#938).
 */
/**
 * Override individual status codes with the BARE error body (#1391).
 *
 * `commonErrorResponses()` declares the `ErrorResponse` envelope for
 * 400/401/403/404/426/429 on every route that uses it. That is right almost
 * everywhere and wrong for the auth family, whose routes answer their own
 * refusals with `{"error": "<code>"}`. Pass the statuses a route actually
 * refuses with and what it can send; `op()` spreads `extraResponses` AFTER the
 * common entries, so this replaces them.
 *
 * Only the codes a route raises ITSELF belong here. 429 and 5xx stay on the
 * envelope — `withApiErrorHandling` builds those and knows nothing about the
 * route's vocabulary, so claiming the bare shape for them would be the same
 * contradiction one status code over.
 */
export function rawErrorResponses(
    spec: Record<number, string>,
): NonNullable<RouteConfig['responses']> {
    const out: NonNullable<RouteConfig['responses']> = {};
    for (const [status, description] of Object.entries(spec)) {
        out[Number(status)] = {
            description,
            content: { 'application/json': { schema: RawErrorResponseSchema } },
        };
    }
    return out;
}

export function commonErrorResponses(): RouteConfig['responses'] {
    const json = { 'application/json': { schema: ApiErrorResponseSchema } };
    return {
        400: { description: 'Invalid request body or query parameters.', content: json },
        401: { description: 'Not signed in, or the session was refused.', content: json },
        403: {
            description:
                'Signed in, but not permitted.\n\n' +
                'Four of these come from `src/middleware.ts` rather than from any handler, ' +
                'so they are reachable on EVERY route and are the ones worth switching on:\n\n' +
                '- `ADMIN_REQUIRED` — the route is admin-only and this role is not.\n' +
                '- `CSRF_BLOCKED` — a cross-site admin request. Retrying will not help; ' +
                'the request must originate from the app.\n' +
                '- `MFA_REQUIRED` — the session carries a pending MFA challenge. Complete ' +
                'it and retry; the credential is valid.\n' +
                '- `TERMS_ACCEPTANCE_REQUIRED` — consent has not been recorded. ' +
                '`POST /api/auth/accept-terms` is the way out, and the session must be ' +
                're-minted afterwards because `termsPending` is a JWT claim.\n\n' +
                'Each carries an English `message` as a developer-facing fallback; it is NOT ' +
                'translated, so render your own copy keyed on `code`. Route-level 403s carry ' +
                'their own codes and are described on the operation that returns them.\n\n' +
                'One route-level code is described HERE rather than per-operation. MOST ' +
                'operations cannot return it — it is confined to the five capability ' +
                'families named below — but it means the same thing on each of them, and ' +
                'one of the five (`upload`) is gated at a choke point that many unrelated ' +
                'routes reach, so an exhaustive per-operation list would be the kind that ' +
                'is wrong by omission:\n\n' +
                '- `PAST_DUE_RESTRICTED` — a payment on this tenant failed and the 14-day ' +
                'grace period has elapsed. It is NOT a quota or a plan ceiling: the plan is ' +
                'untouched and nothing was exceeded. The withheld capabilities are exactly ' +
                '`exchange`, `trends`, `task.create`, `upload` and `journal.create`; every ' +
                'other surface, including reading everything already recorded, is unaffected. ' +
                'The tenant\'s own ACTIVE exchange listings stay visible to other farms and ' +
                'inbound threads keep arriving — this is the unpaid tenant\'s own view ' +
                'closing, not a withdrawal.\n\n' +
                '  The restriction is COMPUTED per request, with no sweep and nothing to ' +
                'settle, so a cleared balance lifts it on the very next request — a client ' +
                'can honestly tell the user to resolve it and refresh. This description ' +
                'deliberately names no remedy beyond that: App Store guideline 3.1.1 keeps ' +
                'the native client from pointing anyone to pay outside the app, so a ' +
                'prescribed destination would be unreachable for one of the two clients ' +
                '(#1490). What both clients CAN do is distinguish this from ' +
                '`plan_limit_exceeded:` and say which happened.',
            content: json,
        },
        404: { description: 'Not found, or not visible to this tenant.', content: json },
        426: {
            description:
                'Client too old — the declared `x-agrent-client-version` is below the ' +
                'supported floor. The request was not processed; it is NOT a payload rejection.',
            content: json,
        },
        429: {
            description: 'Rate limited.',
            // DECLARED, not merely described. These four are set on every 429
            // by `rateLimitedResponse` (rate-limit-middleware.ts:187-190), and
            // until now they existed only in this sentence — so a generated
            // client could not see them and had to learn `Retry-After` out of
            // band. That is the measured-not-contracted shape this repo keeps
            // paying for; the iOS client retries 429s today and parses none of
            // this.
            headers: {
                'Retry-After': {
                    description:
                        'Whole seconds to wait before retrying. `max(1, ceil(retryAfterMs / 1000))`, ' +
                        'so it is never 0 — a client that retries immediately on 0 would spend the ' +
                        'next window the moment it opens. The same number is in the body as ' +
                        '`retryAfterSeconds`.',
                    schema: { type: 'integer', minimum: 1 },
                },
                'X-RateLimit-Limit': {
                    description: 'The preset ceiling for this scope, in requests per window.',
                    schema: { type: 'integer' },
                },
                'X-RateLimit-Remaining': {
                    description: 'Always `0` on a 429 — present for symmetry with the other headers.',
                    schema: { type: 'integer' },
                },
                'X-RateLimit-Reset': {
                    description: 'Unix time in SECONDS at which the window frees up.',
                    schema: { type: 'integer' },
                },
            },
            content: json,
        },
        500: { description: 'Unhandled server error. Carries `x-request-id`.', content: json },
    };
}

export interface OperationInput {
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    operationId: string;
    summary: string;
    description?: string;
    tags: string[];
    security?: Array<Record<string, string[]>>;
    /**
     * A ZodObject, not a record of schemas. The generator reads its shape to
     * build inline parameters; a plain record reaches `getOpenApiMetadata`
     * with no internal registry entry and dies on `undefined.parent`. An
     * `as never` cast hid that mismatch until generation actually ran — the
     * type was right and the cast was the defect.
     */
    params?: ZodObject;
    query?: ZodObject;
    /**
     * REQUEST headers this operation reads.
     *
     * Added because `Idempotency-Key` lived in prose on the exchange-message
     * send while being load-bearing for it — a client reading the document
     * strictly could not see that the header exists at all.
     */
    headers?: ZodObject;
    /** Request body schema. Omit for GET/DELETE. */
    body?: ZodTypeAny;
    /**
     * Media type of the REQUEST body. Defaults to `application/json`.
     *
     * Not every write on this API takes JSON: the spatial import is a
     * `multipart/form-data` upload read with `req.formData()`. Declaring its
     * body as JSON because that is what the helper happened to support would
     * be a documented lie, and a generated client built on it cannot upload a
     * shapefile at all.
     */
    bodyContentType?: string;
    /**
     * The success response. REQUIRED — an operation that describes no result
     * documents nothing.
     *
     * `schema` is the shorthand for a single `application/json` body and
     * covers almost every operation. `content` is the general form, for the
     * operator endpoints that are not JSON — the MVT parcel tile, the
     * basemap tile — and for `POST .../farm-record`, whose ONE 200 answers
     * `application/pdf` by default and `application/json` when the caller
     * asks to save instead. A client that assumes one of those parses the
     * other as garbage, so the media type is part of the contract, not a
     * detail to approximate.
     */
    success: {
        /**
         * 3xx is here because for some operations the REDIRECT is the success.
         * `/api/auth/native/start` hands the system browser to NextAuth and
         * `/complete` hands the code back to the app's URI; a 200 would be a
         * lie about both. The implementation below already emits a bodyless
         * response when no schema is given — only this type stood in the way.
         */
        status: 200 | 201 | 202 | 204 | 302 | 303 | 307;
        description: string;
        schema?: ZodTypeAny;
        content?: Record<string, ZodTypeAny>;
    };
    /** Extra statuses this operation specifically can return, e.g. 409 on an optimistic lock. */
    extraResponses?: RouteConfig['responses'];
}

/** Register one operation with the shared security, params and error envelope. */
export function op(registry: OpenAPIRegistry, input: OperationInput): void {
    const successBodies =
        input.success.content ??
        (input.success.schema ? { 'application/json': input.success.schema } : undefined);

    const responses: RouteConfig['responses'] = {
        ...commonErrorResponses(),
        ...(input.extraResponses ?? {}),
        [input.success.status]: {
            description: input.success.description,
            ...(successBodies
                ? {
                      content: Object.fromEntries(
                          Object.entries(successBodies).map(([mediaType, schema]) => [
                              mediaType,
                              { schema },
                          ]),
                      ),
                  }
                : {}),
        },
    };

    registry.registerPath({
        method: input.method,
        path: input.path,
        operationId: input.operationId,
        summary: input.summary,
        ...(input.description ? { description: input.description } : {}),
        tags: input.tags,
        security: input.security ?? [{ sessionCookie: [] }, { bearerToken: [] }],
        request: {
            ...(input.params ? { params: input.params } : {}),
            ...(input.query ? { query: input.query } : {}),
            ...(input.headers ? { headers: input.headers } : {}),
            ...(input.body
                ? {
                      body: {
                          content: {
                              [input.bodyContentType ?? 'application/json']: { schema: input.body },
                          },
                      },
                  }
                : {}),
        },
        responses,
    });
}
