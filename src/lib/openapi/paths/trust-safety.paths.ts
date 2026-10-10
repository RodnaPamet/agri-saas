/**
 * The DSA Art 16 notice surfaces — `/api/public/notices` and
 * `/api/social/reports` (P5.2, #1593).
 *
 * One module for both because they are two halves of ONE duty, and documenting
 * them apart would hide the only thing a reader needs to know about the pair:
 * the body is identical and the reporter is never part of it.
 *
 * `FileReportSchema` is IMPORTED from `@/lib/schemas`, not redeclared here.
 * `tests/guards/request-body-declared-once.test.ts` caps hand-written
 * duplicates at zero, and its reason applies exactly: a route and a spec module
 * each declaring their own Zod for the same body are two schemas nothing
 * compares, so a change to one is invisible to the other.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { FileReportSchema } from '@/lib/schemas';
import { op } from './helpers';

const FiledReceiptSchema = z
    .object({
        id: z.string().openapi({
            description:
                'A reference for the notice. Returned because Art 16 wants a notifier able to refer to what they filed. It discloses nothing and is not readable back on the public route — there is no GET there, and an anonymous notice stores no reporter, so the reporter read policy can never match it.',
            example: 'cr-9f1c7a2e-5d3b-4e8a-9c21-7b6f0e4d8a11',
        }),
        status: z.literal('RECEIVED').openapi({
            description:
                'Always `RECEIVED`. The pipeline sets every later state; a client cannot propose one, and this field exists so a notifier sees that the notice was accepted rather than inferring it from the HTTP code alone.',
        }),
    })
    .openapi('FiledReport', {
        description:
            'Acknowledgement of a filed notice. Deliberately minimal: it does NOT say whether the reported subject exists. A response that distinguished a real id from a made-up one would be an enumeration oracle on an unauthenticated endpoint, so a missing subject is recorded against the moderator-only snapshot instead.',
    });

const OwnReportSchema = z
    .object({
        id: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        subjectKind: z.enum(['LISTING', 'MESSAGE', 'PROFILE', 'THREAD']),
        subjectId: z.string(),
        reasonCode: z.string().openapi({
            description:
                'The category the notifier chose. A string rather than an enum in THIS response on purpose: the accepted request values are a closed set, but a notice filed before a category was renamed must still be readable back, and a codegen client that threw on an unknown value here would break on history.',
        }),
        detail: z.string().nullable().openapi({
            description:
                'The notifier’s own words, sanitised on the write path. `null` when they wrote nothing — or wrote only markup, which sanitises to nothing and is the same fact to a reader.',
        }),
        status: z.string().openapi({
            description:
                'Where the notice is in the pipeline: RECEIVED, TRIAGED, ACTIONED or REJECTED. This is the field the whole reporter-read policy arm exists to deliver — Art 16 entitles a notifier to the outcome. It carries no moderator identity, no rationale and no timing beyond its own row; all of that lives on tables no tenant session can read.',
        }),
    })
    .openapi('OwnReport', {
        description:
            'A notice as its own reporter may read it back. Every column of the stored row is here, because the policy that admits the reporter is ROW-level and cannot return a subset — which is why nothing may be added to that table without deciding it is reporter-safe.',
    });

export function registerTrustSafetyPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/public/notices',
        operationId: 'fileAnonymousNotice',
        summary: 'DSA Art 16 — file a notice without an account',
        description:
            'The anonymous notice mechanism. Art 16 requires a way for **any** person or entity to notify illegal content, so requiring an account would be requiring an account to exercise a right — this is the one write path in the product that accepts a body from nobody. '
            + '\n\n**It is not behind a feature flag**, and that is a duty rather than an oversight: a legal obligation cannot be dark-launched, because a flag defaulting OFF means the obligation is unmet until someone remembers to flip it. '
            + '\n\n**Nothing identifying is stored.** No IP, no hash of one, no surrogate. Rate limiting is the control instead, at 10/min per IP — tightened from the 60/min a public mutation gets by default, because the harm here is a flood that buries real notices in the triage queue rather than database load. The limiter sees the IP; the row never does. '
            + '\n\nSend `reporterUserId` and it is silently dropped, not rejected: a caller can neither attribute a notice to someone else nor learn from an error whether the field exists.',
        tags: ['Trust & safety'],
        body: FileReportSchema,
        success: {
            status: 201,
            description: 'The notice was accepted. Says nothing about the subject.',
            schema: FiledReceiptSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/social/reports',
        operationId: 'fileReport',
        summary: 'DSA Art 16 — file a notice as the signed-in user',
        description:
            'The same duty and the same body as the anonymous route; the difference is that the notice is attributable, which is what makes it readable back via `GET`. '
            + '\n\nThe reporter is taken from the **verified session** and never from the body. '
            + '\n\nAlso unflagged, for the same reason: Art 16 applies to a notifier who happens to have an account as much as to one who does not, so gating this would gate the duty for exactly the people most likely to exercise it. The person BLOCK routes are a product feature and ARE gated — that difference is deliberate.',
        tags: ['Trust & safety'],
        body: FileReportSchema,
        success: {
            status: 201,
            description: 'The notice was accepted and is attributable to the caller.',
            schema: FiledReceiptSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/social/reports',
        operationId: 'listMyReports',
        summary: 'DSA Art 16 — the notices you filed, and what became of them',
        description:
            'Newest first, capped at 100. Account-level with no `{tenantSlug}`: a notice is a property of the PERSON and carries no tenant, and a tenant-scoped route could not serve this at all — the policy that admits a reporter matches a session variable only the person-scoped runner sets, so under a tenant context it would return zero rows with no error, indistinguishable from having filed none. '
            + '\n\nAn anonymous notice is never here, by construction rather than by a filter: it stores no reporter, and in SQL `NULL = NULL` is NULL. '
            + '\n\nAn empty list is a real answer — a person who has filed nothing sees `[]`.',
        tags: ['Trust & safety'],
        success: {
            status: 200,
            description: 'The caller’s own notices.',
            schema: z.object({ reports: z.array(OwnReportSchema) }),
        },
    });
}
