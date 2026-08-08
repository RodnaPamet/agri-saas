import { z } from 'zod';

/**
 * Canonical onboarding wizard steps — ordered.
 */
export const ONBOARDING_STEPS = [
    'COMPANY_PROFILE',
    'FRAMEWORK_SELECTION',
    'ASSET_SETUP',
    'CONTROL_BASELINE_INSTALL',
    'TEAM_SETUP',
    'REVIEW_AND_FINISH',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const OnboardingStepEnum = z.enum(ONBOARDING_STEPS);

/**
 * Steps that MUST be completed (not skippable) to finish onboarding.
 */
export const REQUIRED_STEPS: OnboardingStep[] = ['COMPANY_PROFILE', 'REVIEW_AND_FINISH'];

/**
 * Steps that can be explicitly skipped by the admin.
 */
export const SKIPPABLE_STEPS: OnboardingStep[] = [
    'FRAMEWORK_SELECTION',
    'ASSET_SETUP',
    'CONTROL_BASELINE_INSTALL',
    'TEAM_SETUP',
];

/**
 * Schema for saving step data.
 * `step` identifies which step, `data` carries step-specific payload.
 */
export const SaveStepSchema = z.object({
    step: OnboardingStepEnum,
    data: z.record(z.string(), z.unknown()).default({}),
}).strip();

/**
 * Schema for completing a step.
 */
export const CompleteStepSchema = z.object({
    step: OnboardingStepEnum,
}).strip();

/**
 * Schema for skipping a step.
 */
export const SkipStepSchema = z.object({
    step: OnboardingStepEnum,
}).strip();

export type SaveStepInput = z.infer<typeof SaveStepSchema>;
export type CompleteStepInput = z.infer<typeof CompleteStepSchema>;
export type SkipStepInput = z.infer<typeof SkipStepSchema>;

