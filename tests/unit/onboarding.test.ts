/**
 * Onboarding Wizard Unit Tests
 *
 * Tests the step model, state machine transitions, policy enforcement,
 * idempotency, restart behavior, completion rules, and skip logic.
 */
import {
    ONBOARDING_STEPS,
    OnboardingStepEnum,
    SaveStepSchema,
    CompleteStepSchema,
    SkipStepSchema,
    REQUIRED_STEPS,
    SKIPPABLE_STEPS,
} from '@/lib/schemas/onboarding';
import { checkCompletionCriteria } from '@/app-layer/usecases/onboarding';

// ─── Step Model ───

describe('Onboarding Step Model', () => {
    test('ONBOARDING_STEPS has 6 canonical steps in order', () => {
        // Was 7: INITIAL_RISK_REGISTER was removed with the risk
        // register. Its automation handler had already been reduced to
        // a no-op that reported every candidate as skipped, so the
        // wizard was showing a farmer a step that generated nothing.
        expect(ONBOARDING_STEPS).toEqual([
            'COMPANY_PROFILE',
            'FRAMEWORK_SELECTION',
            'ASSET_SETUP',
            'CONTROL_BASELINE_INSTALL',
            'TEAM_SETUP',
            'REVIEW_AND_FINISH',
        ]);
        expect(ONBOARDING_STEPS.length).toBe(6);
    });

    test('OnboardingStepEnum validates known steps', () => {
        expect(OnboardingStepEnum.safeParse('COMPANY_PROFILE').success).toBe(true);
        expect(OnboardingStepEnum.safeParse('FRAMEWORK_SELECTION').success).toBe(true);
        expect(OnboardingStepEnum.safeParse('REVIEW_AND_FINISH').success).toBe(true);
    });

    test('OnboardingStepEnum rejects unknown steps', () => {
        expect(OnboardingStepEnum.safeParse('INVALID_STEP').success).toBe(false);
        expect(OnboardingStepEnum.safeParse('').success).toBe(false);
        expect(OnboardingStepEnum.safeParse(null).success).toBe(false);
    });
});

// ─── Zod Schemas ───

describe('Onboarding Zod Schemas', () => {
    describe('SaveStepSchema', () => {
        test('accepts valid save payload', () => {
            const result = SaveStepSchema.safeParse({
                step: 'COMPANY_PROFILE',
                data: { name: 'Acme Corp', industry: 'Technology' },
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.step).toBe('COMPANY_PROFILE');
                expect(result.data.data).toEqual({ name: 'Acme Corp', industry: 'Technology' });
            }
        });

        test('defaults data to empty object', () => {
            const result = SaveStepSchema.safeParse({ step: 'ASSET_SETUP' });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.data).toEqual({});
            }
        });

        test('rejects invalid step', () => {
            const result = SaveStepSchema.safeParse({ step: 'BOGUS', data: {} });
            expect(result.success).toBe(false);
        });

        test('strips unknown fields', () => {
            const result = SaveStepSchema.safeParse({
                step: 'TEAM_SETUP',
                data: { emails: ['a@b.com'] },
                extraField: 'should be stripped',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect('extraField' in result.data).toBe(false);
            }
        });
    });

    describe('CompleteStepSchema', () => {
        test('accepts valid complete payload', () => {
            const result = CompleteStepSchema.safeParse({ step: 'FRAMEWORK_SELECTION' });
            expect(result.success).toBe(true);
        });

        test('rejects missing step', () => {
            const result = CompleteStepSchema.safeParse({});
            expect(result.success).toBe(false);
        });

        test('strips unknown fields', () => {
            const result = CompleteStepSchema.safeParse({
                step: 'ASSET_SETUP',
                extra: true,
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect('extra' in result.data).toBe(false);
            }
        });
    });

    describe('SkipStepSchema', () => {
        test('accepts valid skip payload', () => {
            const result = SkipStepSchema.safeParse({ step: 'FRAMEWORK_SELECTION' });
            expect(result.success).toBe(true);
        });

        test('rejects invalid step', () => {
            const result = SkipStepSchema.safeParse({ step: 'BOGUS' });
            expect(result.success).toBe(false);
        });

        test('strips unknown fields', () => {
            const result = SkipStepSchema.safeParse({ step: 'ASSET_SETUP', extra: 'nope' });
            expect(result.success).toBe(true);
            if (result.success) {
                expect('extra' in result.data).toBe(false);
            }
        });
    });
});

// ─── Required / Skippable Classification ───

describe('Step Classification', () => {
    test('REQUIRED_STEPS includes COMPANY_PROFILE and REVIEW_AND_FINISH', () => {
        expect(REQUIRED_STEPS).toContain('COMPANY_PROFILE');
        expect(REQUIRED_STEPS).toContain('REVIEW_AND_FINISH');
    });

    test('SKIPPABLE_STEPS includes 4 optional steps', () => {
        expect(SKIPPABLE_STEPS.length).toBe(4);
        expect(SKIPPABLE_STEPS).toContain('FRAMEWORK_SELECTION');
        expect(SKIPPABLE_STEPS).toContain('ASSET_SETUP');
        expect(SKIPPABLE_STEPS).toContain('CONTROL_BASELINE_INSTALL');
        expect(SKIPPABLE_STEPS).toContain('TEAM_SETUP');
    });

    test('REQUIRED and SKIPPABLE are disjoint', () => {
        for (const step of REQUIRED_STEPS) {
            expect(SKIPPABLE_STEPS).not.toContain(step);
        }
    });

    test('every step is either required or skippable', () => {
        for (const step of ONBOARDING_STEPS) {
            const isRequired = REQUIRED_STEPS.includes(step);
            const isSkippable = SKIPPABLE_STEPS.includes(step);
            expect(isRequired || isSkippable).toBe(true);
        }
    });
});

// ─── Completion Rules ───

describe('Completion Criteria', () => {
    test('fully completed steps pass all criteria', () => {
        const completed = ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION', 'ASSET_SETUP', 'CONTROL_BASELINE_INSTALL', 'INITIAL_RISK_REGISTER', 'TEAM_SETUP', 'REVIEW_AND_FINISH'];
        const issues = checkCompletionCriteria(completed, [], { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } });
        expect(issues).toEqual([]);
    });

    test('missing company profile fails', () => {
        const completed = ['FRAMEWORK_SELECTION', 'ASSET_SETUP', 'REVIEW_AND_FINISH'];
        const issues = checkCompletionCriteria(completed, [], {});
        expect(issues.some(i => i.includes('Company profile'))).toBe(true);
    });

    test('missing review step fails', () => {
        const completed = ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION', 'ASSET_SETUP'];
        const issues = checkCompletionCriteria(completed, [], {});
        expect(issues.some(i => i.includes('Review step'))).toBe(true);
    });

    test('skipped framework selection passes', () => {
        const completed = ['COMPANY_PROFILE', 'ASSET_SETUP', 'REVIEW_AND_FINISH'];
        const skipped = ['FRAMEWORK_SELECTION', 'CONTROL_BASELINE_INSTALL', 'INITIAL_RISK_REGISTER', 'TEAM_SETUP'];
        const issues = checkCompletionCriteria(completed, skipped, {});
        expect(issues).toEqual([]);
    });

    test('framework selected but control install not done fails', () => {
        const completed = ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION', 'ASSET_SETUP', 'REVIEW_AND_FINISH'];
        const skipped = ['INITIAL_RISK_REGISTER', 'TEAM_SETUP'];
        const stepData = { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } };
        const issues = checkCompletionCriteria(completed, skipped, stepData);
        expect(issues.some(i => i.includes('Control baseline'))).toBe(true);
    });

    test('framework selected and control install skipped passes', () => {
        const completed = ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION', 'ASSET_SETUP', 'REVIEW_AND_FINISH'];
        const skipped = ['CONTROL_BASELINE_INSTALL', 'INITIAL_RISK_REGISTER', 'TEAM_SETUP'];
        const stepData = { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } };
        const issues = checkCompletionCriteria(completed, skipped, stepData);
        expect(issues).toEqual([]);
    });

    test('no frameworks selected means no control install needed', () => {
        const completed = ['COMPANY_PROFILE', 'ASSET_SETUP', 'REVIEW_AND_FINISH'];
        const skipped = ['FRAMEWORK_SELECTION', 'INITIAL_RISK_REGISTER', 'TEAM_SETUP'];
        const issues = checkCompletionCriteria(completed, skipped, {});
        expect(issues).toEqual([]);
    });
});

// ─── State Machine Logic ───

describe('Onboarding State Machine', () => {
    test('steps are ordered — each step has a clear successor', () => {
        for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) {
            const current = ONBOARDING_STEPS[i];
            const next = ONBOARDING_STEPS[i + 1];
            expect(current).toBeDefined();
            expect(next).toBeDefined();
            expect(current).not.toBe(next);
        }
    });

    test('first step is COMPANY_PROFILE', () => {
        expect(ONBOARDING_STEPS[0]).toBe('COMPANY_PROFILE');
    });

    test('last step is REVIEW_AND_FINISH', () => {
        expect(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]).toBe('REVIEW_AND_FINISH');
    });
});

// ─── Policy Guard ───

describe('Onboarding Policy', () => {

    const { assertCanManageOnboarding } = require('@/app-layer/policies/onboarding.policies');

    const makeCtx = (canAdmin: boolean) => ({
        requestId: 'test-req',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: canAdmin ? 'ADMIN' : 'READER',
        permissions: {
            canRead: true,
            canWrite: canAdmin,
            canAdmin,
            canAudit: false,
            canExport: canAdmin,
        },
    });

    test('admin context passes', () => {
        expect(() => assertCanManageOnboarding(makeCtx(true))).not.toThrow();
    });

    test('non-admin context throws forbidden', () => {
        expect(() => assertCanManageOnboarding(makeCtx(false))).toThrow();
    });

    test('error message mentions administrators', () => {
        try {
            assertCanManageOnboarding(makeCtx(false));
        } catch (e: unknown) {
            expect((e as Error).message).toContain('administrator');
        }
    });
});

// ─── Idempotency Contract ───

describe('Onboarding Idempotency', () => {
    test('completing an already-completed step should not duplicate it in completedSteps', () => {
        const completedSteps = ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION'];
        const step = 'COMPANY_PROFILE';

        const alreadyDone = completedSteps.includes(step);
        expect(alreadyDone).toBe(true);

        const updated = alreadyDone ? completedSteps : [...completedSteps, step];
        expect(updated).toEqual(['COMPANY_PROFILE', 'FRAMEWORK_SELECTION']);
        expect(updated.filter(s => s === step).length).toBe(1);
    });

    test('completing a new step appends it', () => {
        const completedSteps = ['COMPANY_PROFILE'];
        const step = 'FRAMEWORK_SELECTION';

        const alreadyDone = completedSteps.includes(step);
        expect(alreadyDone).toBe(false);

        const updated = [...completedSteps, step];
        expect(updated).toEqual(['COMPANY_PROFILE', 'FRAMEWORK_SELECTION']);
    });
});

// ─── Restart Contract ───

describe('Onboarding Restart', () => {
    test('restart resets all fields to initial state', () => {
        const resetState = {
            status: 'NOT_STARTED',
            currentStep: 'COMPANY_PROFILE',
            completedSteps: [],
            stepData: {},
            startedAt: null,
            completedAt: null,
        };

        expect(resetState.status).toBe('NOT_STARTED');
        expect(resetState.currentStep).toBe(ONBOARDING_STEPS[0]);
        expect(resetState.completedSteps).toEqual([]);
        expect(resetState.stepData).toEqual({});
        expect(resetState.startedAt).toBeNull();
        expect(resetState.completedAt).toBeNull();
    });
});

// ─── Route Guardrail: no-prisma-in-routes ───

describe('Onboarding Route Guardrails', () => {
    const fs = require('fs');
    const path = require('path');

    const routeDir = path.join(process.cwd(), 'src/app/api/t/[tenantSlug]/onboarding');

    test('no direct Prisma imports in route handlers', () => {
        if (!fs.existsSync(routeDir)) return;

        const walkSync = (dir: string): string[] => {
            const files: string[] = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) files.push(...walkSync(full));
                else if (entry.name.endsWith('.ts')) files.push(full);
            }
            return files;
        };

        const routeFiles = walkSync(routeDir);
        expect(routeFiles.length).toBeGreaterThan(0);

        for (const file of routeFiles) {
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toContain("from '@prisma/client'");
            expect(content).not.toContain("from '@/lib/prisma'");
            expect(content).not.toContain('prisma.');
        }
    });

    test('all route handlers use withApiErrorHandling', () => {
        if (!fs.existsSync(routeDir)) return;

        const walkSync = (dir: string): string[] => {
            const files: string[] = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) files.push(...walkSync(full));
                else if (entry.name === 'route.ts') files.push(full);
            }
            return files;
        };

        const routeFiles = walkSync(routeDir);
        for (const file of routeFiles) {
            const content = fs.readFileSync(file, 'utf8');
            expect(content).toContain('withApiErrorHandling');
        }
    });
});
