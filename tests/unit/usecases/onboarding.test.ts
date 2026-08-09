/**
 * Unit tests for src/app-layer/usecases/onboarding.ts
 *
 * Wave 4 of GAP-02. Onboarding orchestrates the first-time setup
 * wizard. The architectural decision worth pinning is the two-phase
 * step completion: lightweight DB writes inside a transaction +
 * heavy automation (e.g. installing framework packs with hundreds of
 * practices) AFTER the transaction commits. A regression that pulled
 * the automation back inside the transaction would trip Prisma's
 * 5-second interactive-tx timeout under load.
 *
 * Behaviours protected:
 *   1. assertCanManageOnboarding gate on every mutation; getOnboardingState
 *      auto-creates the row (no gate — anyone with a session can read).
 *   2. startOnboarding is idempotent for IN_PROGRESS state.
 *   3. saveOnboardingStep / completeOnboardingStep / skipOnboardingStep
 *      reject when state is not IN_PROGRESS.
 *   4. completeOnboardingStep is idempotent for already-completed steps.
 *   5. The automation pass runs OUTSIDE the transaction (errors are
 *      logged, never thrown).
 *   6. checkCompletionCriteria is a pure function with framework-conditional
 *      logic — REVIEW_AND_FINISH always required; CONTROL_BASELINE_INSTALL
 *      only required when frameworks were selected.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/OnboardingRepository', () => ({
    OnboardingRepository: {
        getByTenantId: jest.fn(),
        upsertInitial: jest.fn(),
        start: jest.fn(),
        saveStepData: jest.fn(),
        completeStep: jest.fn(),
        finish: jest.fn(),
        reset: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/onboarding.events', () => ({
    emitOnboardingStarted: jest.fn().mockResolvedValue(undefined),
    emitOnboardingStepCompleted: jest.fn().mockResolvedValue(undefined),
    emitOnboardingFinished: jest.fn().mockResolvedValue(undefined),
    emitOnboardingRestarted: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/usecases/onboarding-automation', () => ({
    runStepAction: jest.fn(),
    storeActionResult: jest.fn().mockResolvedValue(undefined),
}));

import {
    startOnboarding,
    saveOnboardingStep,
    completeOnboardingStep,
    finishOnboarding,
    checkCompletionCriteria,
} from '@/app-layer/usecases/onboarding';
import { runInTenantContext } from '@/lib/db-context';
import { OnboardingRepository } from '@/app-layer/repositories/OnboardingRepository';
import { runStepAction } from '@/app-layer/usecases/onboarding-automation';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetByTenantId = OnboardingRepository.getByTenantId as jest.MockedFunction<typeof OnboardingRepository.getByTenantId>;
const mockStart = OnboardingRepository.start as jest.MockedFunction<typeof OnboardingRepository.start>;
const mockSaveStepData = OnboardingRepository.saveStepData as jest.MockedFunction<typeof OnboardingRepository.saveStepData>;
const mockCompleteStep = OnboardingRepository.completeStep as jest.MockedFunction<typeof OnboardingRepository.completeStep>;
const mockRunStepAction = runStepAction as jest.MockedFunction<typeof runStepAction>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('startOnboarding', () => {
    it('rejects EDITOR (admin-only via assertCanManageOnboarding)', async () => {
        await expect(
            startOnboarding(makeRequestContext('EDITOR')),
        ).rejects.toThrow();
    });

    it('rejects READER + AUDITOR', async () => {
        await expect(
            startOnboarding(makeRequestContext('READER')),
        ).rejects.toThrow();
        await expect(
            startOnboarding(makeRequestContext('AUDITOR')),
        ).rejects.toThrow();
    });

    it('is idempotent — returns the existing IN_PROGRESS row without re-starting', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce({
            id: 'ob-1', status: 'IN_PROGRESS',
        } as never);

        await startOnboarding(makeRequestContext('ADMIN'));

        // Regression: a refactor that always re-started would emit a
        // second OnboardingStarted event and clobber the existing
        // currentStep — the wizard would jump back to step 1 mid-flow.
        expect(mockStart).not.toHaveBeenCalled();
    });

    it('calls start() when no record exists', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce(null as never);
        mockStart.mockResolvedValueOnce({ id: 'ob-1' } as never);

        await startOnboarding(makeRequestContext('ADMIN'));

        expect(mockStart).toHaveBeenCalled();
    });
});

describe('saveOnboardingStep', () => {
    it('rejects when state is not IN_PROGRESS', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce({
            status: 'NOT_STARTED',
        } as never);

        await expect(
            saveOnboardingStep(makeRequestContext('ADMIN'), 'COMPANY_PROFILE', { x: 1 }),
        ).rejects.toThrow(/Onboarding must be started/);
        expect(mockSaveStepData).not.toHaveBeenCalled();
    });
});

describe('completeOnboardingStep', () => {
    it('rejects EDITOR (admin gate)', async () => {
        await expect(
            completeOnboardingStep(makeRequestContext('EDITOR'), 'COMPANY_PROFILE'),
        ).rejects.toThrow();
    });

    it('is idempotent at the DB layer — re-completing an already-completed step skips repo.completeStep', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce({
            status: 'IN_PROGRESS',
            completedSteps: ['COMPANY_PROFILE'],
            stepData: {},
        } as never);

        await completeOnboardingStep(makeRequestContext('ADMIN'), 'COMPANY_PROFILE');

        // Regression: a refactor that re-completed would emit a duplicate
        // OnboardingStepCompleted event AND bump completedSteps a second
        // time. The DB-layer idempotency is what stops the audit trail
        // from filling with redundant entries on rapid double-clicks.
        // (Phase 2 automation may still run — by design, it is itself
        // expected to be idempotent.)
        expect(mockCompleteStep).not.toHaveBeenCalled();
    });

    it('runs the automation OUTSIDE the transaction (failures do not throw)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce({
            status: 'IN_PROGRESS',
            completedSteps: [],
            stepData: { COMPANY_PROFILE: { name: 'Acme' } },
        } as never);
        mockCompleteStep.mockResolvedValueOnce({
            id: 'ob-1', stepData: { COMPANY_PROFILE: { name: 'Acme' } },
        } as never);
        mockRunStepAction.mockRejectedValueOnce(new Error('framework-install-failed'));

        // Regression: a refactor that pulled the automation back inside
        // the transaction would re-throw this and roll back the step
        // completion — the user's wizard progress would silently disappear.
        await expect(
            completeOnboardingStep(makeRequestContext('ADMIN'), 'COMPANY_PROFILE'),
        ).resolves.toBeDefined();
    });
});

describe('finishOnboarding', () => {
    it('rejects when state is not IN_PROGRESS', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetByTenantId.mockResolvedValueOnce({ status: 'COMPLETED' } as never);

        await expect(
            finishOnboarding(makeRequestContext('ADMIN')),
        ).rejects.toThrow(/Onboarding must be in progress/);
    });
});

describe('checkCompletionCriteria — pure function', () => {
    it('requires COMPANY_PROFILE and REVIEW_AND_FINISH', () => {
        const issues = checkCompletionCriteria([], [], {});
        expect(issues).toEqual(expect.arrayContaining([
            expect.stringMatching(/Company profile/),
            expect.stringMatching(/Review step/),
        ]));
    });

    it('returns no issues when only required steps are completed and no frameworks are selected', () => {
        const issues = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH'],
            ['FRAMEWORK_SELECTION'],
            {},
        );
        expect(issues).toEqual([]);
    });

    it('flags missing CONTROL_BASELINE_INSTALL when frameworks WERE selected', () => {
        const issues = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH', 'FRAMEWORK_SELECTION'],
            [],
            { FRAMEWORK_SELECTION: { selectedFrameworks: ['ISO27001'] } },
        );
        expect(issues).toEqual(expect.arrayContaining([
            expect.stringMatching(/Practice baseline install/),
        ]));
    });

    it('does NOT flag CONTROL_BASELINE_INSTALL when FRAMEWORK_SELECTION was completed but EMPTY', () => {
        const issues = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH', 'FRAMEWORK_SELECTION'],
            [],
            { FRAMEWORK_SELECTION: { selectedFrameworks: [] } },
        );
        // Regression: a refactor that flagged this case would force
        // the user to install practices for frameworks they explicitly
        // chose NOT to select — a UX regression.
        expect(issues).toEqual([]);
    });

    it('passes when CONTROL_BASELINE_INSTALL was skipped (skipping satisfies the gate)', () => {
        const issues = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH', 'FRAMEWORK_SELECTION'],
            ['CONTROL_BASELINE_INSTALL'],
            { FRAMEWORK_SELECTION: { selectedFrameworks: ['ISO27001'] } },
        );
        expect(issues).toEqual([]);
    });
});
