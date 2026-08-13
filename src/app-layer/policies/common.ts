import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Asserts the user has READ permission in their current context.
 */
export function assertCanRead(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view records in this context.');
    }
}

/**
 * Asserts the user has WRITE permission in their current context.
 */
export function assertCanWrite(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to modify records in this context.');
    }
}

/**
 * Asserts the user has ADMIN permission in their current context.
 */
export function assertCanAdmin(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('You do not have permission to perform administrative actions in this context.');
    }
}

/**
 * Asserts the user has AUDIT permission in their current context.
 */
export function assertCanAudit(ctx: RequestContext) {
    if (!ctx.permissions.canAudit) {
        throw forbidden('You do not have permission to perform audit actions in this context.');
    }
}

/**
 * Asserts the user may verify a stored file's integrity hash.
 *
 * Moved here from `audit-readiness.policies.ts` in GRC teardown phase 2,
 * with its role set PRESERVED VERBATIM. The set is deliberately narrower
 * than `assertCanRead`: file-integrity verification returns a SHA-256 and a
 * size for a given file, and a `matches` boolean turns the endpoint into an
 * oracle. `verifyFileIntegrity` was once gated on a check that admitted
 * every role including an external auditor; narrowing it to
 * OWNER / ADMIN / AUDITOR is what closed that. Widening this back to a
 * permission flag (`canAudit` admits AUDITOR but the role list is the
 * documented contract) would re-open it, so the literal list stays.
 */
export function assertCanVerifyIntegrity(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'AUDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN or AUDITOR can verify file integrity');
    }
}
