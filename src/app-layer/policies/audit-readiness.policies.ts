/**
 * Audit Readiness Policies
 * Authorization checks for audit cycles, packs, shares, and auditor access.
 *
 * Epic 1 — OWNER is strictly superior to ADMIN per CLAUDE.md's RBAC
 * section, so every gate that historically read `'ADMIN'` now also
 * accepts `'OWNER'`. The seed admin (acme-corp) is OWNER after the
 * GAP-07 step-6 alignment, and any production tenant created via
 * `createTenantWithOwner` has its first user as OWNER.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

export function assertCanManageAuditCycles(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit cycles');
    }
}

export function assertCanManageAuditPacks(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit packs');
    }
}

export function assertCanFreezePack(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can freeze audit packs');
    }
}

export function assertCanSharePack(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can share audit packs');
    }
}

export function assertCanViewPack(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR'].includes(ctx.role)) {
        throw forbidden('Cannot view audit packs');
    }
}

/**
 * Integrity verification — OWNER, ADMIN or AUDITOR.
 *
 * Deliberately narrower than `assertCanViewPack`, which admits every role.
 * Verifying a hash is an audit action, and the endpoint reports a file's
 * SHA-256 and byte size; letting READER and EDITOR enumerate that is a
 * capability nobody asked for and the thing that made the old raw-path
 * version an oracle for anyone with any seat.
 */
export function assertCanVerifyIntegrity(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'AUDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN or AUDITOR can verify file integrity');
    }
}

export function assertCanManageAuditors(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can manage auditor accounts');
    }
}
