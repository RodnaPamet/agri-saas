/**
 * Practice-specific RBAC policies.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/** All roles can read practices */
export function assertCanReadPractices(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view practices.');
    }
}

/** ADMIN/EDITOR can create practices */
export function assertCanCreatePractice(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to create practices.');
    }
}

/** ADMIN/EDITOR can update practices */
export function assertCanUpdatePractice(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to update practices.');
    }
}

/** ADMIN/EDITOR can manage practice tasks */
export function assertCanManageTasks(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to manage practice tasks.');
    }
}

/** ADMIN/EDITOR can link evidence */
export function assertCanLinkEvidence(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to link evidence to practices.');
    }
}

/** ADMIN/EDITOR can set practice applicability */
export function assertCanSetApplicability(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to set practice applicability.');
    }
}

/** ADMIN/EDITOR can map frameworks */
export function assertCanMapFramework(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to map framework requirements.');
    }
}
