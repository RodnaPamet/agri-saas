/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestContext } from '../types';
import { OnboardingRepository } from '../repositories/OnboardingRepository';
import { assertCanManageOnboarding } from '../policies/onboarding.policies';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import {
    emitOnboardingStarted,
    emitOnboardingStepCompleted,
    emitOnboardingFinished,
    emitOnboardingRestarted,
} from '../events/onboarding.events';
import { runStepAction, storeActionResult } from './onboarding-automation';
import { logger } from '@/lib/observability/logger';

// ─── Step keys & ordering ───

const STEP_ORDER = [
    'COMPANY_PROFILE',
    'FRAMEWORK_SELECTION',
    'ASSETS',
    'CONTROLS',
    'RISKS',
    'TEAM',
    'REVIEW',
] as const;

type OnboardingStep = (typeof STEP_ORDER)[number];

function getNextStep(currentStep: OnboardingStep): string {
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx < 0 || idx >= STEP_ORDER.length - 1) return currentStep;
    return STEP_ORDER[idx + 1];
}

// ─── Get State ───

/**
 * Returns the current onboarding state for the tenant.
 * If no record exists, auto-creates one with NOT_STARTED status.
 */
export async function getOnboardingState(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (existing) return existing;

        const initial = await OnboardingRepository.upsertInitial(db, ctx);
        return initial;
    });
}

// ─── Start Onboarding ───

/**
 * Starts the onboarding wizard. Idempotent — calling multiple times is safe.
 * Admin-only.
 */
export async function startOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    logger.info('onboarding started', { component: 'onboarding' });
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (existing && existing.status === 'IN_PROGRESS') {
            return existing;
        }

        const record = await OnboardingRepository.start(db, ctx);
        await emitOnboardingStarted(db, ctx);
        return record;
    });
}

// ─── Save Step Data ───

/**
 * Persists step-specific payload data without marking the step as complete.
 * Useful for saving partial form data (resume support).
 * Admin-only.
 */

export async function saveOnboardingStep(ctx: RequestContext, step: OnboardingStep, data: Record<string, any>) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before saving step data.');
        }
        return OnboardingRepository.saveStepData(db, ctx, step, data);
    });
}

// ─── Complete Step ───

/**
 * Marks a step as completed, advances currentStep, and runs the automation action.
 * Idempotent — completing an already-completed step is a no-op.
 * Admin-only.
 *
 * Architecture note: The step completion (lightweight DB updates) runs inside
 * a Prisma transaction for RLS enforcement. The automation action (e.g. installing
 * framework packs with dozens of practices/tasks) runs AFTER the transaction commits
 * to avoid exceeding Prisma's interactive transaction timeout (5s default).
 * The automation is fire-and-forget — failures are logged but don't block the wizard.
 */
export async function completeOnboardingStep(ctx: RequestContext, step: OnboardingStep) {
    assertCanManageOnboarding(ctx);

    // Phase 1: Complete the step inside a transaction (lightweight, fast)
    const record = await runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before completing steps.');
        }

        // Idempotent: already completed
        if (existing.completedSteps.includes(step)) {
            return existing;
        }

        const nextStep = getNextStep(step);
        const stepRecord = await OnboardingRepository.completeStep(db, ctx, step, nextStep);
        await emitOnboardingStepCompleted(db, ctx, step);

        // If step was previously skipped, remove from skipped list

        const stepData = (stepRecord.stepData as Record<string, any>) || {};
        const skippedSteps: string[] = stepData._skippedSteps || [];
        if (skippedSteps.includes(step)) {
            const updated = skippedSteps.filter(s => s !== step);
            await OnboardingRepository.saveStepData(db, ctx, '_skippedSteps', updated);
        }

        return stepRecord;
    });

    // Phase 2: Run automation AFTER the transaction commits (heavy, may be slow)
    // This runs outside the transaction so it won't cause timeout issues.
    // Errors are logged but don't block the wizard response.
    try {

        const allData = (record.stepData as Record<string, any>) || {};
        const sd = allData[step] || {};
        const result = await runStepAction(ctx, step, sd, allData);
        if (result) {
            logger.info('onboarding automation completed', {
                component: 'onboarding', step, action: result.action,
                created: result.created, skipped: result.skipped,
            });
            await storeActionResult(ctx, step, result);
        }
    } catch (e) {
        logger.warn('onboarding automation failed', {
            component: 'onboarding', step,
            error: e instanceof Error ? { name: e.name, message: e.message } : { name: 'UnknownError', message: String(e) },
        });
    }

    logger.info('onboarding step completed', { component: 'onboarding', step });
    return record;
}

// ─── Skip Step ───

/**
 * Marks a step as skipped (recorded in stepData._skippedSteps).
 * Advances the currentStep to the next step.
 * Admin-only.
 */
export async function skipOnboardingStep(ctx: RequestContext, step: OnboardingStep) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before skipping steps.');
        }


        const stepData = (existing.stepData as Record<string, any>) || {};
        const skippedSteps: string[] = stepData._skippedSteps || [];
        if (!skippedSteps.includes(step)) {
            skippedSteps.push(step);
        }

        await OnboardingRepository.saveStepData(db, ctx, '_skippedSteps', skippedSteps);

        const nextStep = getNextStep(step);
        return OnboardingRepository.completeStep(db, ctx, step, nextStep);
    });
}

// ─── Finish Onboarding ───

/**
 * Marks the entire onboarding as COMPLETED.
 * Admin-only.
 */
export async function finishOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be in progress to finish.');
        }

        const record = await OnboardingRepository.finish(db, ctx);
        await emitOnboardingFinished(db, ctx);
        logger.info('onboarding finished', { component: 'onboarding' });
        return record;
    });
}

// ─── Restart Onboarding ───

/**
 * Resets the onboarding to NOT_STARTED state.
 * Admin-only.
 */
export async function restartOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const record = await OnboardingRepository.reset(db, ctx);
        await emitOnboardingRestarted(db, ctx);
        return record;
    });
}

// ─── Metrics ───

/**
 * Returns summary metrics for the onboarding wizard.
 */
export async function getOnboardingMetrics(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing) {
            return {
                status: 'NOT_STARTED',
                completedSteps: 0,
                totalSteps: STEP_ORDER.length,
                progress: 0,
            };
        }

        return {
            status: existing.status,
            currentStep: existing.currentStep,
            completedSteps: existing.completedSteps.length,
            totalSteps: STEP_ORDER.length,
            progress: Math.round((existing.completedSteps.length / STEP_ORDER.length) * 100),
            startedAt: existing.startedAt,
            completedAt: existing.completedAt,
        };
    });
}

// ─── Completion Criteria (pure function, tested directly) ───

/**
 * Pure function that checks whether the onboarding wizard is ready to be finished.
 * Returns an array of human-readable issue strings (empty = ready to finish).
 *
 * Rules:
 *  1. COMPANY_PROFILE and REVIEW_AND_FINISH are required — must be completed.
 *  2. Other steps can be skipped.
 *  3. If FRAMEWORK_SELECTION was completed (not skipped) AND frameworks were selected,
 *     then CONTROL_BASELINE_INSTALL must be completed or skipped.
 *  4. If no frameworks were selected (or FRAMEWORK_SELECTION was skipped),
 *     CONTROL_BASELINE_INSTALL is not required.
 */

export function checkCompletionCriteria(
    completedSteps: string[],
    skippedSteps: string[],
    stepData: Record<string, any>,
): string[] {
    const issues: string[] = [];

    // Rule 1: Required steps must be completed
    if (!completedSteps.includes('COMPANY_PROFILE')) {
        issues.push('Company profile step must be completed.');
    }
    if (!completedSteps.includes('REVIEW_AND_FINISH')) {
        issues.push('Review step must be completed.');
    }

    // Rule 3/4: Framework → Practice dependency
    const fwCompleted = completedSteps.includes('FRAMEWORK_SELECTION');
    const selectedFrameworks: string[] = stepData?.FRAMEWORK_SELECTION?.selectedFrameworks || [];
    const hasFrameworks = fwCompleted && selectedFrameworks.length > 0;

    if (hasFrameworks) {
        const practiceCompleted = completedSteps.includes('CONTROL_BASELINE_INSTALL');
        const practiceSkipped = skippedSteps.includes('CONTROL_BASELINE_INSTALL');
        if (!practiceCompleted && !practiceSkipped) {
            issues.push('Practice baseline install must be completed or skipped when frameworks are selected.');
        }
    }

    return issues;
}
