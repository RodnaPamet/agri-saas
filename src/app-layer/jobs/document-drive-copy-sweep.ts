/**
 * Drain the «Документи» documents waiting for a Google Drive copy (#2495 step 4).
 *
 * ## `driveState = PENDING` IS the queue
 *
 * There is no BullMQ job per document, and that is the design rather than an
 * omission. A per-document enqueue has a failure mode this does not: the row
 * says PENDING, the enqueue was lost, and nothing will ever drain it — while
 * the retention sweep DEFERS a PENDING row, so the bytes would also never
 * expire. One durable column is both the queue and the state, so the two
 * cannot disagree.
 *
 * Same shape as `statement-dispatch`, whose queue is `deliveredAt IS NULL`, and
 * for the same reason: `attempts: 1` on the run, with the retry living per-ROW.
 * Retrying the RUN would re-copy every document that already succeeded in the
 * failed batch.
 *
 * Every two minutes, matching `health-check`. A farmer who uploads a scan
 * watches for «Копие в Google Drive», so a ten-minute beat would read as
 * broken; the query is indexed and almost always empty, which is what makes a
 * tight beat cheap.
 *
 * ## A tenant-wide refusal marks the rows FAILED, and does not skip them
 *
 * `copyDocumentToDrive` deliberately THROWS for conditions that are wrong for
 * every row — no Google connection, no Drive grant, the integration flag off —
 * rather than recording them per document, so a misconfiguration cannot hide
 * behind a scatter of per-file error badges.
 *
 * This sweep is what decides what that means for the rows, and leaving them
 * PENDING would be the wrong answer twice over: the retention sweep defers
 * PENDING, so the document would neither copy nor ever expire, and the farmer
 * would watch a spinner that can never resolve. So the tenant's PENDING rows
 * are marked FAILED — which is exactly what FAILED means, "this copy did not
 * happen and you can retry it" — and the cause is logged once per tenant at
 * error level rather than once per row.
 *
 * The operator then fixes the connection and presses retry, which is the
 * `drive-copy` route. That is the loop closing properly: a visible state, a
 * named cause in the log, and a way out.
 */
import { randomUUID } from 'node:crypto';

// DEFAULT import, matching its sibling `document-retention-sweep`. Both
// exports exist, and the choice is about the TESTS: a factory of the
// shape `{ __esModule: true, default: db }` leaves the named export
// undefined, so a suite written against one import style silently gets
// the real client under the other — the repo's partial-barrel-mock trap.
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import { copyDocumentToDrive } from '../usecases/document-drive-copy';
import type { RequestContext } from '../types';
import type { DocumentDriveCopySweepPayload, JobRunResult } from './types';

const DEFAULT_LIMIT = 100;

/**
 * An ADMIN of the farm, because the credential being used is the farm's.
 *
 * `resolveGoogleConnectionToken` asserts admin — it decrypts and rotates a
 * tenant-wide secret — so the copy cannot run as nobody. The oldest ACTIVE
 * OWNER/ADMIN membership is deterministic and is the same person who could
 * perform this copy by hand from the settings screen.
 *
 * Returning null rather than throwing: a tenant whose last admin was
 * deactivated is a real state, and it must not take the whole sweep down for
 * every other farm.
 */
async function adminContextFor(tenantId: string): Promise<RequestContext | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        include: { customRole: true },
        orderBy: { createdAt: 'asc' },
    });
    if (!membership) return null;

    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    const appPermissions = membership.customRole
        ? parsePermissionsJson(membership.customRole.permissionsJson, membership.customRole.baseRole)
        : getPermissionsForRole(membership.role);
    return {
        requestId: `document-drive-copy-${tenantId}`,
        userId: membership.userId,
        tenantId,
        role: effectiveRole,
        permissions: computePermissions(effectiveRole),
        appPermissions,
    };
}

export async function runDocumentDriveCopySweep(
    opts: DocumentDriveCopySweepPayload & { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<{ result: JobRunResult }> {
    // No `runJob` wrapper, matching its own sibling `document-retention-sweep`
    // rather than the 26 modules that use one. The two halves of #2495 report
    // identically on purpose: an operator comparing "what was copied" against
    // "what was purged" is reading one feature, and two result shapes would
    // make that comparison a translation exercise.
    const jobRunId = `ddcs-${randomUUID()}`;
    const startedAt = new Date();
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const now = opts.now ?? new Date();

        // Oldest first, so a backlog drains in the order farmers created it.
        // `purgedAt: null` because a tombstone has no bytes: a document that
        // expired while PENDING is not a copy waiting to happen, and the
        // retention sweep's own deferral is what let it reach that state.
        const due = await prisma.farmDocument.findMany({
            where: { driveState: 'PENDING', purgedAt: null },
            select: { id: true, tenantId: true },
            orderBy: { updatedAt: 'asc' },
            take: limit,
        });

        let copied = 0;
        let failed = 0;
        let skipped = 0;

        // Grouped by tenant so one connection lookup and one token rotation
        // serve every document of that farm, and so a tenant-wide refusal is
        // reported once rather than per row.
        const byTenant = new Map<string, string[]>();
        for (const d of due) {
            const list = byTenant.get(d.tenantId) ?? [];
            list.push(d.id);
            byTenant.set(d.tenantId, list);
        }

        for (const [tenantId, documentIds] of byTenant) {
            const ctx = await adminContextFor(tenantId);
            if (!ctx) {
                logger.error('documents.drive_copy_no_admin', {
                    component: 'document-drive-copy-sweep',
                    tenantId,
                    pending: documentIds.length,
                });
                // FAILED, not skipped — see the docblock. A farm with no
                // active admin cannot copy, and PENDING would strand both the
                // copy and the expiry.
                const res = await prisma.farmDocument.updateMany({
                    where: { id: { in: documentIds }, driveState: 'PENDING' },
                    data: { driveState: 'FAILED' },
                });
                failed += res.count;
                continue;
            }

            for (const documentId of documentIds) {
                try {
                    const outcome = await copyDocumentToDrive(ctx, documentId, {
                        fetchImpl: opts.fetchImpl,
                        now,
                    });
                    if (outcome.state === 'COPIED') copied += 1;
                    else failed += 1;
                } catch (err) {
                    // A TENANT-WIDE refusal. Mark this tenant's remaining
                    // PENDING rows FAILED, log the cause once, and move to the
                    // next farm — a missing Google connection says nothing
                    // about anybody else's documents.
                    logger.error('documents.drive_copy_tenant_refused', {
                        component: 'document-drive-copy-sweep',
                        tenantId,
                        documentId,
                        pending: documentIds.length,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    const res = await prisma.farmDocument.updateMany({
                        where: { id: { in: documentIds }, driveState: 'PENDING' },
                        data: { driveState: 'FAILED' },
                    });
                    failed += res.count;
                    break;
                }
            }
        }

    // `success: true` with a non-zero failure count is the honest shape, the
    // same one step 5 reports: the RUN worked, and a failed copy is the
    // FINDING. Reported separately from `skipped` because they mean different
    // things — one is a copy that did not happen and can be retried, the other
    // is a document nothing tried to copy.
    const completedAt = new Date();
    return {
        result: {
            jobName: 'document-drive-copy-sweep',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: due.length,
            itemsActioned: copied,
            itemsSkipped: failed + skipped,
            details: { copied, failed, skipped, tenants: byTenant.size },
        },
    };
}
