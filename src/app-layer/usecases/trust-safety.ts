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
 * The five subject kinds have unrelated shapes and three exist today, which is
 * why this resolves by `switch` rather than through a registry: a registry with
 * three entries and two holes reads as complete. (Four and two until #2833 —
 * the counts are in the prose because a registry's completeness is exactly what
 * they argue about, so they have to move when a kind does.)
 *
 * `reporterUserId` is a parameter because ONE kind needs it: `DIRECT_MESSAGE`
 * must assert the reporter is a participant. It is threaded rather than read
 * from a context because this function runs after the notice is durable, on
 * the privileged client, where there is no request context to consult.
 */
async function captureSnapshot(
    reportId: string,
    subjectKind: FileReportInput['subjectKind'],
    subjectId: string,
    reporterUserId: string | null,
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
            case 'CHANNEL_POST': {
                // PUBLIC content, so this is the `LISTING` shape and NOT the
                // `DIRECT_MESSAGE` one. No participation is asserted and none
                // should be: `channel_post_select` admits any authenticated
                // caller, so the reporter could already read every word of
                // this. Adding a membership check would refuse a notice about
                // a post the reporter can see, which is the opposite of what
                // Art 16 asks for.
                //
                // `body` is PLAINTEXT by design (P9.1 — P9.7 needs channel
                // posts searchable), so there is no decryption here and no
                // read-the-metadata-first dance. That dance exists for
                // `DIRECT_MESSAGE` precisely to stop a non-participant causing
                // the plaintext to exist; here the plaintext is already
                // readable by everyone.
                const row = await prisma.channelPost.findUnique({
                    where: { id: subjectId },
                    select: {
                        body: true,
                        authorUserId: true,
                        kind: true,
                        channel: { select: { key: true, nameBg: true } },
                    },
                });
                body = row
                    ? [
                        `channel: ${row.channel.nameBg} (${row.channel.key})`,
                        `kind: ${row.kind}`,
                        '',
                        row.body,
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
            case 'DIRECT_MESSAGE': {
                // THE ONLY KIND THAT CHECKS WHO IS ASKING (#2833).
                //
                // Every other kind here is something the reporter could see
                // anyway — a listing is public, an exchange message is in a
                // thread they are party to. A direct message is not: this
                // function runs on the PRIVILEGED client, so a crafted id
                // would capture two strangers' private conversation into the
                // moderation queue, and the reporter would get the same
                // `{ id, RECEIVED }` either way. The notice form would be a
                // read oracle with the answer delivered to a moderator.
                if (!reporterUserId) {
                    // Defence in depth: `POST /api/public/notices` refuses
                    // this kind outright, because there is no principal to
                    // check against. If that refusal is ever removed, this
                    // records a miss rather than capturing the message.
                    captureError = 'SUBJECT_REQUIRES_A_REPORTER';
                    break;
                }

                // READ THE METADATA WITHOUT THE BODY FIRST. Selecting `body`
                // here would decrypt a stranger's message and then discard it
                // — the right outcome reached by the wrong route, and one
                // `select` edit away from storing it. A non-participant must
                // never cause the plaintext to exist.
                const meta = await prisma.directMessage.findUnique({
                    where: { id: subjectId },
                    select: {
                        conversationId: true,
                        senderUserId: true,
                        createdAt: true,
                        deletedAt: true,
                        attachmentMime: true,
                        attachmentBytes: true,
                    },
                });
                if (!meta) {
                    captureError = 'SUBJECT_NOT_FOUND';
                    break;
                }

                // `findFirst` on both columns rather than the compound unique:
                // the generated key name is a Prisma artefact, and a rename
                // there would be a silent miss here.
                //
                // `leftAt` is deliberately NOT filtered. Somebody who has left
                // the conversation still SAW the message, and their row is kept
                // precisely so their history resolves — refusing them would
                // mean leaving a conversation destroys your ability to report
                // what was said in it.
                const participant = await prisma.conversationParticipant.findFirst({
                    where: { conversationId: meta.conversationId, userId: reporterUserId },
                    select: { id: true },
                });
                if (!participant) {
                    captureError = 'SUBJECT_NOT_VISIBLE_TO_REPORTER';
                    break;
                }

                if (meta.deletedAt) {
                    // P5.3's rule: a deleted message has nothing to capture,
                    // and its snapshot would be an empty body indistinguishable
                    // from a capture failure. The row still HOLDS the plaintext
                    // until a retraction overwrites it, so this is a refusal to
                    // look rather than an absence of anything to see.
                    captureError = 'SUBJECT_DELETED';
                    break;
                }

                const row = await prisma.directMessage.findUnique({
                    where: { id: subjectId },
                    select: { body: true },
                });
                if (!row) {
                    // Deleted between the two reads. Not impossible, and the
                    // honest answer is the same as never having found it.
                    captureError = 'SUBJECT_NOT_FOUND';
                    break;
                }

                // The attachment is NAMED but its key is not recorded. A
                // photo-only message has a null body, and without this line a
                // moderator cannot tell that from a failed capture — but the
                // storage key would be a second copy of a locator they can
                // already reach through `subjectId` and the participation-gated
                // egress route.
                const photo = meta.attachmentMime
                    ? `photo: ${meta.attachmentMime}, ${meta.attachmentBytes ?? 0} bytes`
                    : 'photo: none';
                body = [
                    `sender: ${meta.senderUserId}`,
                    `sent: ${meta.createdAt.toISOString()}`,
                    photo,
                    '',
                    row.body ?? '',
                ].join('\n');
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
    await captureSnapshot(id, input.subjectKind, input.subjectId, reporterUserId);

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
