/**
 * Shared DTO schemas and types for API responses.
 * All schemas use z.infer<> for type derivation.
 */
import { z } from '@/lib/openapi/zod';

// ─── Shared Refs ───

/** Minimal user reference returned in most includes */
/**
 * The OTHER error body: a bare machine code, not the `ErrorResponse` envelope.
 *
 * Lifted out of `locations.paths.ts` in #1391 so the auth family can reference
 * the SAME component rather than describing the shape a second time. Two names
 * for one shape would also defeat
 * `tests/contracts/error-bodies-match-their-declared-schema.test.ts`, which
 * compares dereferenced schema NAMES — a second name makes a mismatch read as
 * agreement.
 *
 * ## Why two shapes exist on purpose
 *
 * Measured on #1391: the spec declared `ErrorResponse` for 78 4xx responses
 * across 13 `/api/auth/*` paths, while 11 auth route files answer their own
 * refusals with `{"error": "<code>"}` — a STRING where the schema said OBJECT,
 * so a strict decoder fails. The bare form is deliberate: `invalid_grant` and
 * `invalid_request` are RFC 6749 §5.2 codes and
 * `unsupported_code_challenge_method` is RFC 7636's, so a conforming OAuth
 * client expects exactly this at a token endpoint. Converging those routes on
 * the envelope would break that conformance and any non-iOS caller keying on
 * the string — and on a public repo those cannot be enumerated.
 *
 * So the contract admits two error shapes and says which applies where. The
 * owner decided that on #1391.
 *
 * ## Which responses carry which
 *
 * A refusal the route raises ITSELF is bare. Everything the wrapper produces —
 * the 429 rate-limit, any unexpected 5xx — stays `ErrorResponse`, because
 * `withApiErrorHandling` builds those and knows nothing about the route's
 * vocabulary. That split is why `op()`'s `extraResponses` overrides individual
 * status codes rather than the whole family.
 *
 * ## `error` is deliberately not an enum
 *
 * The codes are per-route and several are RFC-defined, so an enum would either
 * go stale or claim a closed set the RFCs do not promise. Each operation's own
 * response description lists what it can send.
 *
 * The same shape also serves the spatial-import and cadastre-import routes,
 * where it predates this reasoning and `#1447` is converging the ones that
 * contradicted their own declaration.
 */
export const RawErrorResponseSchema = z
    .object({ error: z.string() })
    .openapi('RawErrorResponse', {
        description:
            'A bare error body: `{"error": "<code-or-message>"}` and nothing else — NOT the ' +
            '`ErrorResponse` envelope, so there is no `code`, `requestId`, `details` or ' +
            '`params`. Used by the native auth family, where it is the shape RFC 6749 §5.2 ' +
            'specifies for an OAuth token endpoint, and by the spatial-import and ' +
            'cadastre-import routes. A rate-limit (429) or an unexpected failure (5xx) on the ' +
            'same route still answers with `ErrorResponse`, because the error wrapper builds ' +
            'those rather than the route.',
    });

export const UserRefSchema = z
    .object({
        id: z.string().openapi({ example: 'usr_01HG7…' }),
        name: z.string().nullable().openapi({ example: 'Alice Admin' }),
        email: z.string().nullable().optional().openapi({ example: 'admin@acme.com' }),
    })
    .openapi('UserRef', {
        description: 'User identity reference embedded inside other resources (id + display name + optional email).',
    });
export type UserRef = z.infer<typeof UserRefSchema>;

/** Short user reference (id + name only, no email) */
export const UserRefShortSchema = z
    .object({
        id: z.string().openapi({ example: 'usr_01HG7…' }),
        name: z.string().nullable().openapi({ example: 'Alice Admin' }),
    })
    .openapi('UserRefShort', {
        description: 'User identity reference without email — used in audit-log entries and other places where leaking the email would be inappropriate.',
    });
export type UserRefShort = z.infer<typeof UserRefShortSchema>;

// ─── Standard Error Shape ───

/** Matches ApiErrorResponse from src/lib/errors/types.ts */
export const ApiErrorResponseSchema = z
    .object({
        error: z.object({
            code: z.string().openapi({ example: 'NOT_FOUND' }),
            message: z.string().openapi({ example: 'Practice not found' }),
            requestId: z.string().optional().openapi({ example: 'req_01HG7…' }),
            details: z.unknown().optional(),
            /**
             * Interpolation values for the client's OWN translated sentence.
             *
             * `toApiErrorResponse` has always emitted this (`types.ts:273`,
             * `if (error.params) payload.error.params = error.params`) and the
             * envelope has never documented it — so a client translating a code
             * had no contract for the values the sentence needs, and the native
             * client was left parsing them out of `message`. Raised by
             * agrent-ios in #1391.
             *
             * This is the field that makes a CODE usable. `FARM_NAME_TOO_LONG`
             * carries `{ max: 120 }` so a Bulgarian sentence can say the bound
             * without the server interpolating English; the insurance refusals
             * do the same. Keys are per-code and documented on the throw, not
             * here.
             *
             * It is NOT a place for anything personal — `ErrorParams` is
             * policed by `tests/guards/error-params-carry-no-pii.test.ts`,
             * which matches on the KEY name precisely because this value
             * leaves the server in the clear and lands on a phone.
             */
            params: z
                // `string | number`, matching `ErrorParams` exactly — NOT
                // `unknown`. The first draft used `z.unknown()` and the guard
                // added in #1384 caught it: a map whose value type is
                // undescribed "accepts anything while describing nothing", and
                // it was right. `ErrorParams` is
                // `Readonly<Record<string, string | number>>` — "ids and
                // quantities only" — so the narrower type is the HONEST one and
                // happens to satisfy the guard rather than needing a waiver.
                //
                // Interpolation values into a sentence are scalars by nature;
                // you cannot interpolate an object into a translated string.
                .record(z.string(), z.union([z.string(), z.number()]))
                .optional()
                .openapi({
                    description:
                        'Values for the client to interpolate into its own translated message, keyed per `code` — e.g. `{ "max": 120 }` for `FARM_NAME_TOO_LONG`. Ids and quantities only: strings and numbers, never an object and never personal data. Absent for codes that need no values.',
                    example: { max: 120 },
                }),
        }),
    })
    .openapi('ErrorResponse', {
        description: 'Canonical error envelope returned by every error path. `code` is a stable string clients can branch on; `message` is human-readable ENGLISH and is a fallback, not UI copy; `params` carries the values a client interpolates into its own translated sentence; `requestId` correlates with server logs; `details` is optional structured context (validation issues, rate-limit info, etc.).',
    });
export type ApiErrorResponseDTO = z.infer<typeof ApiErrorResponseSchema>;

// ─── Pagination ───

export interface PaginatedResponse<T> {
    items: T[];
    nextCursor?: string;
    total?: number;
}

// ─── Audit Log Entry ───

export const AuditLogEntrySchema = z
    .object({
        id: z.string(),
        action: z.string().openapi({ example: 'CONTROL_CREATED' }),
        entity: z.string().optional().openapi({ example: 'Practice' }),
        entityId: z.string().optional(),
        details: z.string().nullable(),
        createdAt: z.string().datetime().openapi({ example: '2026-04-28T07:42:11.000Z' }),
        user: UserRefShortSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('AuditLogEntry', {
        description: 'A single audit-log row. Hash-chained at the DB layer; this DTO is the read view exposed via the audit/activity endpoints.',
    });
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ─── Success Responses ───

export const SuccessResponseSchema = z
    .object({
        success: z.literal(true),
    })
    .openapi('SuccessResponse', {
        description: 'Empty success envelope. Returned by mutation endpoints that have no resource to echo back (e.g. status changes, links, deletes).',
    });
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
