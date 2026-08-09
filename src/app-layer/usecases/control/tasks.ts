import { RequestContext } from '../../types';
import { PracticeRepository } from '../../repositories/PracticeRepository';
import { assertCanReadPractices, assertCanManageTasks } from '../../policies/practice.policies';
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';

// ─── Tasks ───

export async function listPracticeTasks(ctx: RequestContext, practiceId: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, (db) =>
        PracticeRepository.listTasks(db, ctx, practiceId)
    );
}

export async function createPracticeTask(ctx: RequestContext, practiceId: string, data: { title: string; description?: string | null; assigneeUserId?: string | null; dueAt?: string | null }) {
    assertCanManageTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await PracticeRepository.createTask(db, ctx, practiceId, data);
        if (!task) throw notFound('Practice not found');

        await logEvent(db, ctx, {
            action: 'CONTROL_TASK_CREATED',
            entityType: 'Practice',
            entityId: practiceId,
            details: `Task created: ${data.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'PracticeTask', operation: 'created', after: { title: data.title, practiceId }, summary: `Task created: ${data.title}` },
        });
        return task;
    });
}

export async function updatePracticeTask(ctx: RequestContext, taskId: string, data: { title?: string; description?: string | null; status?: string; assigneeUserId?: string | null; dueAt?: string | null }) {
    assertCanManageTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await PracticeRepository.updateTask(db, ctx, taskId, data);
        if (!task) throw notFound('Task not found');

        const action = data.status === 'DONE' ? 'CONTROL_TASK_COMPLETED' : 'CONTROL_TASK_UPDATED';
        await logEvent(db, ctx, {
            action,
            entityType: 'Practice',
            entityId: task.practiceId,
            details: `Task ${action === 'CONTROL_TASK_COMPLETED' ? 'completed' : 'updated'}: ${task.title}`,
            detailsJson: data.status ? { category: 'status_change', entityName: 'PracticeTask', fromStatus: null, toStatus: data.status } : { category: 'entity_lifecycle', entityName: 'PracticeTask', operation: 'updated', changedFields: Object.keys(data), summary: `Task updated: ${task.title}` },
        });
        return task;
    });
}

export async function deletePracticeTask(ctx: RequestContext, taskId: string) {
    assertCanManageTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await PracticeRepository.deleteTask(db, ctx, taskId);
        if (!result) throw notFound('Task not found');
        return { success: true };
    });
}
