/**
 * Onboarding audit + automation emitters.
 *
 * Every `logEvent` here carries `detailsJson`, and that is not cosmetic:
 * `streamAuditEvent` DROPS the free-text `details` field and ships only the
 * structured payload (see audit-stream.ts). Before this, three of these four
 * events reached a tenant's SIEM as an action verb and an entity id with no
 * content whatsoever — their entire meaning lived in a string the stream
 * deliberately discards.
 */
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { logEvent } from './audit';
import { emitAutomationEvent } from '../automation';

export async function emitOnboardingStarted(db: PrismaTx, ctx: RequestContext) {
    await logEvent(db, ctx, {
        action: 'ONBOARDING_STARTED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        details: 'Tenant onboarding wizard started',
        detailsJson: {
            category: 'status_change',
            entityName: 'TenantOnboarding',
            toStatus: 'STARTED',
            summary: 'Tenant onboarding wizard started',
        },
    });
    await emitAutomationEvent(ctx, {
        event: 'ONBOARDING_STARTED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        actorUserId: ctx.userId,
        data: {},
    });
}

export async function emitOnboardingStepCompleted(db: PrismaTx, ctx: RequestContext, step: string) {
    await logEvent(db, ctx, {
        action: 'ONBOARDING_STEP_COMPLETED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        details: `Onboarding step completed: ${step}`,
        metadata: { step },
        detailsJson: {
            category: 'status_change',
            entityName: 'TenantOnboarding',
            toStatus: 'STEP_COMPLETED',
            reason: step,
            summary: `Onboarding step completed: ${step}`,
        },
    });
    await emitAutomationEvent(ctx, {
        event: 'ONBOARDING_STEP_COMPLETED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        actorUserId: ctx.userId,
        data: { step },
    });
}

export async function emitOnboardingFinished(db: PrismaTx, ctx: RequestContext) {
    await logEvent(db, ctx, {
        action: 'ONBOARDING_FINISHED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        details: 'Tenant onboarding wizard completed',
        detailsJson: {
            category: 'status_change',
            entityName: 'TenantOnboarding',
            toStatus: 'FINISHED',
            summary: 'Tenant onboarding wizard completed',
        },
    });
    await emitAutomationEvent(ctx, {
        event: 'ONBOARDING_FINISHED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        actorUserId: ctx.userId,
        data: {},
    });
}

export async function emitOnboardingRestarted(db: PrismaTx, ctx: RequestContext) {
    await logEvent(db, ctx, {
        action: 'ONBOARDING_RESTARTED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        details: 'Tenant onboarding wizard restarted',
        detailsJson: {
            category: 'status_change',
            entityName: 'TenantOnboarding',
            toStatus: 'RESTARTED',
            summary: 'Tenant onboarding wizard restarted',
        },
    });
    await emitAutomationEvent(ctx, {
        event: 'ONBOARDING_RESTARTED',
        entityType: 'TenantOnboarding',
        entityId: ctx.tenantId,
        actorUserId: ctx.userId,
        data: {},
    });
}
