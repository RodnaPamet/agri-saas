/**
 * Shared DTO schemas and types for API responses.
 * All schemas use z.infer<> for type derivation.
 */
import { z } from '@/lib/openapi/zod';

// ─── Shared Refs ───

/** Minimal user reference returned in most includes */
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
        createdAt: z.string().openapi({ example: '2026-04-28T07:42:11.000Z' }),
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
