/**
 * @deprecated Legacy Issue usecase — delegates to Task repositories (WorkItemRepository).
 * All functions are preserved for backward compatibility with old Issue API routes.
 */
import { TaskLinkEntityType } from '@prisma/client';
import { RequestContext } from '../types';
import { WorkItemRepository, TaskLinkRepository, TaskCommentRepository, TaskWatcherRepository, TaskFilters } from '../repositories/WorkItemRepository';
import { EvidenceBundleRepository } from '../repositories/EvidenceBundleRepository';
import { assertCanReadIssues, assertCanCreateIssue, assertCanUpdateIssue, assertCanAssignIssue, assertCanResolveIssue, assertCanComment, assertCanManageLinks, assertCanManageBundles, assertCanFreeze } from '../policies/issue.policies';
import { logEvent } from '../events/audit';
import { emitAutomationEvent } from '../automation';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    TERMINAL_WORK_ITEM_STATUSES,
    checkWorkItemTransition,
    formatTransitionError,
    isTerminalStatus,
} from '../domain/work-item-status';
import { getSlaStatus } from '../services/sla';

/** @deprecated Use TaskFilters */
export type IssueFilters = TaskFilters;

// ─── List / Get ───

export async function listIssues(ctx: RequestContext, filters: IssueFilters = {}) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => WorkItemRepository.list(db, ctx, filters));
}

export async function getIssue(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, async (db) => {
        const issue = await WorkItemRepository.getById(db, ctx, issueId);
        if (!issue) throw notFound('Issue not found');
        // Audit Coherence S8 (2026-05-24) — surface the derived SLA
        // status. Pure function, no extra query; the frontend reads
        // `sla.label` to render the breach pill.
        return {
            ...issue,
            sla: getSlaStatus(issue.severity, issue.createdAt, issue.status),
        };
    });
}

// ─── Create ───

export async function createIssue(ctx: RequestContext, input: {
    title: string;
    type: string;
    description?: string | null;
    severity?: string;
    priority?: string;
    dueAt?: string | null;
    assigneeUserId?: string | null;
    reporterUserId?: string | null;
}) {
    assertCanCreateIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const issue = await WorkItemRepository.create(db, ctx, input);
        await logEvent(db, ctx, {
            action: 'ISSUE_CREATED',
            entityType: 'Issue',
            entityId: issue.id,
            details: `Created issue: ${issue.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Issue', operation: 'created', summary: 'ISSUE_CREATED' },
            metadata: { type: input.type, severity: input.severity, priority: input.priority },
        });
        await emitAutomationEvent(ctx, {
            event: 'ISSUE_CREATED',
            entityType: 'Issue',
            entityId: issue.id,
            actorUserId: ctx.userId,
            stableKey: issue.id,
            data: {
                key: issue.key,
                title: issue.title,
                severity: issue.severity,
                status: issue.status,
                assigneeUserId: issue.assigneeUserId,
            },
        });
        return issue;
    });
}

// ─── Update ───

export async function updateIssue(ctx: RequestContext, issueId: string, patch: {
    title?: string;
    description?: string | null;
    severity?: string;
    priority?: string;
    dueAt?: string | null;
}) {
    assertCanUpdateIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const issue = await WorkItemRepository.update(db, ctx, issueId, patch);
        if (!issue) throw notFound('Issue not found');
        await logEvent(db, ctx, {
            action: 'ISSUE_UPDATED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Updated issue fields`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Issue', operation: 'updated', summary: 'ISSUE_UPDATED' },
            metadata: patch,
        });
        return issue;
    });
}

// ─── Status ───

export async function setIssueStatus(ctx: RequestContext, issueId: string, status: string, resolution?: string | null) {
    assertCanResolveIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Capture fromStatus before the mutation so the automation
        // event payload reflects the transition, not just the new state.
        const existing = await WorkItemRepository.getById(db, ctx, issueId);
        if (!existing) throw notFound('Issue not found');
        const fromStatus = existing.status;

        // Audit Coherence S8 (2026-05-24) — same state-machine +
        // resolution-required gates as the Task path. Issues and
        // tasks share the WorkItem row shape; the validation lives
        // in the shared domain module so both surfaces stay aligned.
        const transitionErr = checkWorkItemTransition(fromStatus, status);
        if (transitionErr) throw badRequest(formatTransitionError(transitionErr));

        if (isTerminalStatus(status)) {
            const trimmed = (resolution ?? '').trim();
            if (!trimmed) {
                throw badRequest(
                    `A resolution is required when moving an issue to ${status}.`,
                );
            }
            resolution = trimmed;
        }

        const issue = await WorkItemRepository.setStatus(db, ctx, issueId, status, resolution);
        if (!issue) throw notFound('Issue not found');
        await logEvent(db, ctx, {
            action: 'ISSUE_STATUS_CHANGED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Status changed to ${status}`,
            // Audit Coherence S8 — write the real fromStatus + toStatus.
            // Same hardcoded-null fix as the Task path.
            detailsJson: {
                category: 'status_change',
                entityName: 'Issue',
                fromStatus,
                toStatus: status,
            },
            metadata: { status, resolution },
        });
        await emitAutomationEvent(ctx, {
            event: 'ISSUE_STATUS_CHANGED',
            entityType: 'Issue',
            entityId: issueId,
            actorUserId: ctx.userId,
            stableKey: `${issueId}:${fromStatus}:${status}`,
            data: { fromStatus, toStatus: status },
        });
        return issue;
    });
}

// ─── Assign ───

export async function assignIssue(ctx: RequestContext, issueId: string, assigneeUserId: string | null) {
    assertCanAssignIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const issue = await WorkItemRepository.assign(db, ctx, issueId, assigneeUserId);
        if (!issue) throw notFound('Issue not found');
        await logEvent(db, ctx, {
            action: 'ISSUE_ASSIGNED',
            entityType: 'Issue',
            entityId: issueId,
            details: assigneeUserId ? `Assigned to ${assigneeUserId}` : 'Unassigned',
            detailsJson: { category: 'custom', event: 'issue_assigned' },
            metadata: { assigneeUserId },
        });
        return issue;
    });
}

// ─── Links ───

export async function listIssueLinks(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => TaskLinkRepository.listByTask(db, ctx, issueId));
}

export async function addIssueLink(ctx: RequestContext, issueId: string, entityType: string, entityId: string, relation?: string) {
    assertCanManageLinks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await TaskLinkRepository.link(db, ctx, issueId, entityType, entityId, relation);
        await logEvent(db, ctx, {
            action: 'ISSUE_LINKED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Linked to ${entityType} ${entityId}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Issue' },
            metadata: { entityType, entityId, relation },
        });
        return link;
    });
}

export async function removeIssueLink(ctx: RequestContext, linkId: string) {
    assertCanManageLinks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await TaskLinkRepository.unlink(db, ctx, linkId);
        if (!result) throw notFound('Issue link not found');
        await logEvent(db, ctx, {
            action: 'ISSUE_UNLINKED',
            entityType: 'Issue',
            entityId: linkId,
            details: `Removed issue link`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Issue' },
        });
        return result;
    });
}

// ─── Comments ───

export async function listIssueComments(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => TaskCommentRepository.listByTask(db, ctx, issueId));
}

export async function addIssueComment(ctx: RequestContext, issueId: string, body: string) {
    assertCanComment(ctx);
    // Epic C.5 — sanitise before persist; mirrors addTaskComment.
    const safeBody = sanitizePlainText(body);
    return runInTenantContext(ctx, async (db) => {
        const comment = await TaskCommentRepository.add(db, ctx, issueId, safeBody);
        await logEvent(db, ctx, {
            action: 'ISSUE_COMMENT_ADDED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Comment added`,
            detailsJson: { category: 'custom', event: 'issue_comment_added' },
            metadata: { commentId: comment.id },
        });
        return comment;
    });
}

// ─── Watchers ───

export async function listIssueWatchers(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => TaskWatcherRepository.listByTask(db, ctx, issueId));
}

export async function addIssueWatcher(ctx: RequestContext, issueId: string, userId: string) {
    assertCanCreateIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        return TaskWatcherRepository.add(db, ctx, issueId, userId);
    });
}

export async function removeIssueWatcher(ctx: RequestContext, issueId: string, userId: string) {
    assertCanCreateIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await TaskWatcherRepository.remove(db, ctx, issueId, userId);
        if (!result) throw notFound('Watcher not found');
        return result;
    });
}

// ─── Metrics ───

export async function getIssueMetrics(ctx: RequestContext) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => WorkItemRepository.metrics(db, ctx));
}

// ─── Activity Feed ───

export async function getIssueActivity(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) =>
        db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Issue', entityId: issueId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true, email: true } } },
        })
    );
}

// ─── Bulk Actions ───

export async function bulkAssign(ctx: RequestContext, issueIds: string[], assigneeUserId: string | null) {
    assertCanAssignIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await WorkItemRepository.bulkAssign(db, ctx, issueIds, assigneeUserId);
        for (const id of issueIds) {
            await logEvent(db, ctx, {
                action: 'ISSUE_ASSIGNED',
                entityType: 'Issue',
                entityId: id,
                details: assigneeUserId ? `Bulk assigned to ${assigneeUserId}` : 'Bulk unassigned',
                detailsJson: { category: 'custom', event: 'issue_assigned' },
                metadata: { assigneeUserId, bulk: true },
            });
        }
        return result;
    });
}

export async function bulkSetStatus(ctx: RequestContext, issueIds: string[], status: string, resolution?: string) {
    assertCanResolveIssue(ctx);

    // Audit Coherence S8 (2026-05-24) — bulk path enforces the same
    // gates as the single-issue path. Bulk operations are convenience,
    // not an escape hatch.
    if (isTerminalStatus(status)) {
        const trimmed = (resolution ?? '').trim();
        if (!trimmed) {
            throw badRequest(
                `A resolution is required when moving an issue to ${status}.`,
            );
        }
        resolution = trimmed;
    }

    return runInTenantContext(ctx, async (db) => {
        // Pre-fetch every row so we can validate every transition
        // BEFORE the bulk update lands. All-or-nothing.
        const existingRows = await WorkItemRepository.listByIds(db, ctx, issueIds);
        const existingMap = new Map(existingRows.map((r) => [r.id, r.status]));

        for (const id of issueIds) {
            const fromStatus = existingMap.get(id);
            if (!fromStatus) {
                throw notFound(`Issue ${id} not found`);
            }
            const err = checkWorkItemTransition(fromStatus, status);
            if (err) {
                throw badRequest(
                    `Cannot bulk-transition issue ${id}: ${formatTransitionError(err)}`,
                );
            }
        }

        const result = await WorkItemRepository.bulkSetStatus(db, ctx, issueIds, status, resolution);
        for (const id of issueIds) {
            const fromStatus = existingMap.get(id) ?? null;
            await logEvent(db, ctx, {
                action: 'ISSUE_STATUS_CHANGED',
                entityType: 'Issue',
                entityId: id,
                details: `Bulk status changed to ${status}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Issue',
                    fromStatus,
                    toStatus: status,
                },
                metadata: { status, resolution, bulk: true },
            });
        }
        return result;
    });
}

export async function bulkSetDueDate(ctx: RequestContext, issueIds: string[], dueAt: string | null) {
    assertCanUpdateIssue(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await WorkItemRepository.bulkSetDueDate(db, ctx, issueIds, dueAt);
        for (const id of issueIds) {
            await logEvent(db, ctx, {
                action: 'ISSUE_UPDATED',
                entityType: 'Issue',
                entityId: id,
                details: `Bulk due date set to ${dueAt || 'none'}`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Issue', operation: 'updated', summary: 'ISSUE_UPDATED' },
                metadata: { dueAt, bulk: true },
            });
        }
        return result;
    });
}

// ─── Overdue Job Stub ───

export async function findOverdueIssuesAndEmitEvents(ctx: RequestContext) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, async (db) => {
        const overdueIssues = await db.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                dueAt: { lt: new Date() },
                status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
            },
            select: { id: true, title: true, dueAt: true, assigneeUserId: true },
        });

        for (const issue of overdueIssues) {
            await logEvent(db, ctx, {
                action: 'ISSUE_OVERDUE',
                entityType: 'Issue',
                entityId: issue.id,
                details: `Issue is overdue (due ${issue.dueAt?.toISOString()})`,
                detailsJson: { category: 'custom', event: 'issue_overdue' },
                metadata: { dueAt: issue.dueAt, assigneeUserId: issue.assigneeUserId },
            });
        }

        return { processed: overdueIssues.length };
    });
}

// ─── Practice Gap Linking ───

export async function listIssuesByPractice(ctx: RequestContext, practiceId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, async (db) => {
        const links = await db.taskLink.findMany({
            where: { tenantId: ctx.tenantId, entityType: TaskLinkEntityType.PRACTICE, entityId: practiceId },
            include: {
                task: {
                    include: {
                        assignee: { select: { id: true, name: true, email: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        return links.map((l) => l.task);
    });
}

// ─── Evidence Bundles (deprecated stubs) ───

export async function listBundles(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.listByIssue(db, ctx, issueId));
}

export async function getBundle(ctx: RequestContext, bundleId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.getById(db, ctx, bundleId));
}

export async function createBundle(ctx: RequestContext, issueId: string, name: string) {
    assertCanManageBundles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await EvidenceBundleRepository.create(db, ctx, issueId, name);
        await logEvent(db, ctx, {
            action: 'BUNDLE_CREATED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Evidence bundle "${name}" created`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Issue', operation: 'created', summary: 'BUNDLE_CREATED' },
            metadata: { bundleId: bundle.id, name },
        });
        return bundle;
    });
}

export async function freezeBundle(ctx: RequestContext, bundleId: string) {
    assertCanFreeze(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await EvidenceBundleRepository.freeze(db, ctx, bundleId);
        if (!bundle) throw notFound('Bundle not found');
        await logEvent(db, ctx, {
            action: 'BUNDLE_FROZEN',
            entityType: 'Issue',
            entityId: bundle.issueId,
            details: `Evidence bundle "${bundle.name}" frozen — now immutable`,
            // Audit Coherence S8 (2026-05-24) — was tagged
            // `status_change` with hardcoded null fromStatus, but
            // bundle freeze is a one-shot entity_lifecycle event on
            // the bundle (not a status transition on the issue).
            // Re-categorising so SIEM filters on `status_change`
            // see only real WorkItem transitions.
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'EvidenceBundle',
                operation: 'frozen',
                summary: 'BUNDLE_FROZEN',
            },
            metadata: { bundleId: bundle.id },
        });
        return bundle;
    });
}

export async function addBundleItem(ctx: RequestContext, bundleId: string, data: { entityType: string; entityId: string; label?: string }) {
    assertCanManageBundles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const item = await EvidenceBundleRepository.addItem(db, ctx, bundleId, data);
        if (!item) throw notFound('Bundle not found');
        return item;
    });
}

export async function listBundleItems(ctx: RequestContext, bundleId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.listItems(db, ctx, bundleId));
}
