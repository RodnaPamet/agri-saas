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
 * registered paths against the route files on disk, so a route without a spec
 * fails CI rather than going quietly undocumented.
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
import { ApiErrorResponseSchema } from '@/lib/dto/common';

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
export function commonErrorResponses(): RouteConfig['responses'] {
    const json = { 'application/json': { schema: ApiErrorResponseSchema } };
    return {
        400: { description: 'Invalid request body or query parameters.', content: json },
        401: { description: 'Not signed in, or the session was refused.', content: json },
        403: { description: 'Signed in, but not permitted.', content: json },
        404: { description: 'Not found, or not visible to this tenant.', content: json },
        426: {
            description:
                'Client too old — the declared `x-agrent-client-version` is below the ' +
                'supported floor. The request was not processed; it is NOT a payload rejection.',
            content: json,
        },
        429: { description: 'Rate limited. Carries `Retry-After` and `X-RateLimit-*`.', content: json },
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
    /** Request body schema. Omit for GET/DELETE. */
    body?: ZodTypeAny;
    /** The success response. REQUIRED — an operation that describes no result documents nothing. */
    success: { status: 200 | 201 | 202 | 204; description: string; schema?: ZodTypeAny };
    /** Extra statuses this operation specifically can return, e.g. 409 on an optimistic lock. */
    extraResponses?: RouteConfig['responses'];
}

/** Register one operation with the shared security, params and error envelope. */
export function op(registry: OpenAPIRegistry, input: OperationInput): void {
    const responses: RouteConfig['responses'] = {
        ...commonErrorResponses(),
        ...(input.extraResponses ?? {}),
        [input.success.status]: {
            description: input.success.description,
            ...(input.success.schema
                ? { content: { 'application/json': { schema: input.success.schema } } }
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
            ...(input.body
                ? { body: { content: { 'application/json': { schema: input.body } } } }
                : {}),
        },
        responses,
    });
}
