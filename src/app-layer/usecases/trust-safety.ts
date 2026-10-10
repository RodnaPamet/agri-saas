/**
 * Trust & safety — filing a DSA Art 16 notice, and reading your own back
 * (P5.2, #1593).
 *
 * ## The read and the write run in DIFFERENT contexts, and that is the design
 *
 * It looks like an inconsistency and it is the whole shape of P5.1's RLS:
 *
 *   * **Reading** your own notices goes through `runInUserContext`, because
 *     `content_report_reporter_read` matches on `app.user_id` — which only
 *     that runner sets. Under a tenant context the variable is unset,
 *     `current_setting(…, true)` yields NULL, the arm matches nothing, and the
 *     call returns ZERO ROWS WITHOUT ERROR. That is why `listOwnReports`
 *     cannot be "simplified" to the raw client or to a tenant context: both
 *     would look like a user who has filed nothing.
 *
 *   * **Writing** goes through the privileged client, because there is
 *     deliberately no `app_user` INSERT arm. P5.1's migration says why: a
 *     reporter who could INSERT directly could forge `reporterUserId` or set
 *     any `status`. So the route authenticates the person, this module
 *     validates and sanitises, and the write runs privileged with the reporter
 *     taken from the verified session.
 *
 * The consequence worth stating plainly: **nothing in this module may put a
 * client-supplied value into `reporterUserId`.** The anonymous path writes
 * NULL and the signed-in path writes `ctx.userId`. There is no third case.
 *
 * ## The snapshot is captured here, not by the client
 *
 * P5's text requires it: "the report snapshot is captured server-side; client
 * text is ignored". `FileReportSchema` has no snapshot field at all, which is
 * the strongest form of ignoring it — a client cannot supply one even by
 * accident.
 *
 * Capture is BEST EFFORT and its failure is recorded rather than thrown. A
 * notice whose evidence could not be captured is still a notice the operator
 * owes an answer to under Art 16, so losing the notice because the listing was
 * deleted half a second earlier would be the wrong trade. `captureError` holds
 * the reason, because the answer a moderator gives differs by cause.
 */
import { randomUUID } from 'node:crypto';

import type { UserContext } from '@/app-layer/types';
import { runInUserContext } from '@/lib/db-context';
import prisma from '@/lib/prisma';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logger } from '@/lib/observability/logger';
import type { z } from 'zod';
import type { FileReportSchema } from '@/lib/schemas';

type FileReportInput = z.infer<typeof FileReportSchema>;

/** What the caller gets back. Deliberately minimal — see `fileNotice`. */
export interface FiledReport {
    id: string;
    status: 'RECEIVED';
}

/** A notice as its own reporter may read it back. */
export interface OwnReport {
    id: string;
    createdAt: Date;
    subjectKind: string;
    subjectId: string;
    reasonCode: string;
    detail: string | null;
    status: string;
}

/**
 * Capture the reported content as evidence, on the privileged path.
 *
 * Returns nothing: the row is the output, and a failure is written to
 * `captureError` rather than raised. A thrown error here would lose the notice.
 *
 * The four subject kinds have unrelated shapes and only two exist today, which
 * is why this resolves by `switch` rather than through a registry: a registry
 * with two entries and two holes reads as complete.
 */
async function captureSnapshot(
    reportId: string,
    subjectKind: FileReportInput['subjectKind'],
    subjectId: string,
): Promise<void> {
    let body: string | null = null;
    let captureError: string | null = null;

    try {
        switch (subjectKind) {
            case 'LISTING': {
                const row = await prisma.exchangeListing.findUnique({
                    where: { id: subjectId },
                    select: { commodity: true, description: true, sellerDisplayName: true },
                });
                body = row
                    ? [
                        `commodity: ${row.commodity}`,
                        `seller: ${row.sellerDisplayName ?? '(anonymous)'}`,
                        '',
                        row.description ?? '',
                    ].join('\n')
                    : null;
                if (!row) captureError = 'SUBJECT_NOT_FOUND';
                break;
            }
            case 'MESSAGE': {
                const row = await prisma.exchangeMessage.findUnique({
                    where: { id: subjectId },
                    select: { body: true, senderTenantId: true, createdAt: true },
                });
                // The decrypted body, because the capture runs on the
                // privileged client and the middleware decrypts there. This is
                // private conversation, which is precisely why `ReportSnapshot`
                // denies `app_user` and the reporter cannot read it back.
                body = row
                    ? [
                        `sender tenant: ${row.senderTenantId}`,
                        `sent: ${row.createdAt.toISOString()}`,
                        '',
                        row.body,
                    ].join('\n')
                    : null;
                if (!row) captureError = 'SUBJECT_NOT_FOUND';
                break;
            }
            case 'PROFILE':
            case 'THREAD':
                // Neither surface exists yet — PROFILE arrives with P6, and a
                // THREAD is a collection whose capture shape is P5.4's
                // question. Recorded as unsupported rather than silently
                // empty, so the queue can tell "nothing to capture" from
                // "nobody implemented this".
                captureError = 'SUBJECT_KIND_NOT_CAPTURABLE';
                break;
        }
    } catch (err) {
        // A capture failure must not lose the notice. Narrow, because a
        // swallowed programming error here would read as a missing subject.
        captureError = 'CAPTURE_FAILED';
        logger.warn('trust-safety.snapshot_capture_failed', {
            component: 'trust-safety',
            reportId,
            subjectKind,
            // `error`, not `err`: the context type reserves `err` for a real
            // Error and a caught value is `unknown`.
            error: err instanceof Error ? err.message : String(err),
        });
    }

    await prisma.reportSnapshot.create({
        data: {
            id: `rs-${randomUUID()}`,
            reportId,
            subjectKind,
            subjectId,
            // NOT NULL in the schema, so an uncapturable subject stores the
            // empty string and says why in `captureError`. A nullable column
            // would make "captured nothing" and "captured an empty listing"
            // the same row.
            body: body ?? '',
            captureError,
        },
    });
}

/**
 * File a notice.
 *
 * `reporterUserId` is the ONLY difference between the anonymous and signed-in
 * paths, and it is a parameter here rather than a field on the input so that
 * no caller can route a body value into it.
 *
 * The response is deliberately minimal — an id and `RECEIVED`. It must not
 * reveal whether the subject existed: `SUBJECT_NOT_FOUND` goes to
 * `captureError` for the moderator, not to the notifier, because a notice form
 * that confirms which ids are real is an enumeration oracle on an
 * unauthenticated route.
 */
export async function fileNotice(
    input: FileReportInput,
    reporterUserId: string | null,
): Promise<FiledReport> {
    const id = `cr-${randomUUID()}`;

    await prisma.contentReport.create({
        data: {
            id,
            // Never from the body. `FileReportSchema.strip()` drops a
            // client-supplied `reporterUserId`; this is the other half of that.
            reporterUserId,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            reasonCode: input.reasonCode,
            // Sanitised on the WRITE path, which is what moves ContentReport
            // out of KNOWN_UNCOVERED in sanitize-rich-text-coverage. An empty
            // string after sanitising is stored as NULL: "they wrote only
            // markup" and "they wrote nothing" are the same fact to a
            // moderator.
            detail: input.detail ? (sanitizePlainText(input.detail) || null) : null,
            // `status` defaults to RECEIVED in the schema and is NOT accepted
            // from the body.
        },
    });

    // After the notice is durable, so a capture failure cannot lose it.
    await captureSnapshot(id, input.subjectKind, input.subjectId);

    logger.info('trust-safety.notice_filed', {
        component: 'trust-safety',
        reportId: id,
        subjectKind: input.subjectKind,
        reasonCode: input.reasonCode,
        // Whether it was anonymous, NOT who filed it. A reporter id in a log
        // line is the identifier DECISION 5 declined to store in the row.
        anonymous: reporterUserId === null,
    });

    return { id, status: 'RECEIVED' };
}

/**
 * The caller's own notices, newest first.
 *
 * `runInUserContext` is required, not preferred — see the module docblock. The
 * policy arm is what filters; this query has no `where` on `reporterUserId` ON
 * PURPOSE, so that the test asserting a reporter sees exactly their own rows
 * is testing the POLICY rather than a `where` clause that would pass with the
 * policy dropped.
 */
export async function listOwnReports(ctx: UserContext): Promise<OwnReport[]> {
    return runInUserContext(ctx, async (db) => {
        const rows = await db.contentReport.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
                id: true,
                createdAt: true,
                subjectKind: true,
                subjectId: true,
                reasonCode: true,
                detail: true,
                status: true,
            },
        });
        return rows.map((r) => ({ ...r }));
    });
}
