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
        }),
    })
    .openapi('ErrorResponse', {
        description: 'Canonical error envelope returned by every error path. `code` is a stable string clients can branch on; `message` is human-readable; `requestId` correlates with server logs; `details` is optional structured context (validation issues, rate-limit info, etc.).',
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
