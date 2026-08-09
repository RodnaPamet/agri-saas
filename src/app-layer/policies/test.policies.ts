/**
 * Practice Test RBAC policies.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/** All roles can read test plans/runs. */
export function assertCanReadTests(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view test plans.');
    }
}

/** ADMIN/EDITOR can create/update test plans. */
export function assertCanManageTestPlans(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to manage test plans.');
    }
}

/** ADMIN/EDITOR can execute/complete test runs. */
export function assertCanExecuteTests(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to execute tests.');
    }
}

/** ADMIN/EDITOR can link evidence to test runs. */
export function assertCanLinkTestEvidence(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to link evidence to test runs.');
    }
}
