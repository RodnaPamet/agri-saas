/**
 * AI monthly token budget — unit tests.
 *
 * Mocks the entitlement primitives so the budget thresholds (hard-stop /
 * soft-warn / unlimited) are tested in isolation without a DB.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockGetEffectivePlan = jest.fn();
const mockGetLimit = jest.fn();
const mockGetUsed = jest.fn();
const mockGetMode = jest.fn(() => 'SAAS');

// P3.5f: default VERIFIED, so the threshold cases below keep testing
// thresholds rather than the verification gate. The gate has its own describe
// block at the bottom.
const mockIsFarmVerified = jest.fn(async () => true);
jest.mock('@/lib/farm-identity/verification-status', () => ({
    isFarmVerified: (...a: unknown[]) => mockIsFarmVerified(...(a as [])),
}));

jest.mock('@/lib/billing/entitlements', () => ({
    getEffectivePlan: (...a: unknown[]) => mockGetEffectivePlan(...a),
    getLimit: (...a: unknown[]) => mockGetLimit(...a),
    getAiTokensUsedThisMonth: (...a: unknown[]) => mockGetUsed(...a),
    getBillingMode: () => mockGetMode(),
}));

import { assertAiBudget } from '@/app-layer/ai/budget';
import { ForbiddenError } from '@/lib/errors/types';

const ctx = makeRequestContext('ADMIN');

beforeEach(() => {
    jest.clearAllMocks();
    mockGetMode.mockReturnValue('SAAS');
    mockIsFarmVerified.mockResolvedValue(true);
});

describe('assertAiBudget', () => {
    it('passes under the limit and reports remaining', async () => {
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockGetUsed.mockResolvedValue(100);
        const status = await assertAiBudget(ctx);
        expect(status.used).toBe(100);
        expect(status.limit).toBe(1000);
        expect(status.remaining).toBe(900);
        expect(status.softWarn).toBe(false);
    });

    it('hard-stops at the limit with AI_BUDGET_EXCEEDED', async () => {
        mockGetEffectivePlan.mockResolvedValue('FREE');
        mockGetLimit.mockReturnValue(50_000);
        mockGetUsed.mockResolvedValue(50_000);
        await expect(assertAiBudget(ctx)).rejects.toBeInstanceOf(ForbiddenError);
        // The CODE and PARAMS. The legacy `ai_budget_exceeded:` prefix is gone
        // (#1677) and `message` is translated per reader, so pinning the prose
        // would pin a sentence the catalogue is allowed to change.
        await expect(assertAiBudget(ctx)).rejects.toMatchObject({
            code: 'AI_BUDGET_EXCEEDED',
            params: { plan: 'FREE', limit: '50000', used: '50000' },
        });
    });

    it('hard-stops when over the limit', async () => {
        mockGetEffectivePlan.mockResolvedValue('FREE');
        mockGetLimit.mockReturnValue(50_000);
        mockGetUsed.mockResolvedValue(60_000);
        await expect(assertAiBudget(ctx)).rejects.toMatchObject({
            code: 'AI_BUDGET_EXCEEDED',
            params: { plan: 'FREE', limit: '50000', used: '60000' },
        });
    });

    it('soft-warns at >= 80% without blocking', async () => {
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockGetUsed.mockResolvedValue(800);
        const status = await assertAiBudget(ctx);
        expect(status.softWarn).toBe(true);
        expect(status.remaining).toBe(200);
    });

    it('does NOT soft-warn just below 80%', async () => {
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockGetUsed.mockResolvedValue(799);
        const status = await assertAiBudget(ctx);
        expect(status.softWarn).toBe(false);
    });

    it('never blocks when the limit is null and the farm is verified', async () => {
        // Was titled "(self-hosted / ENTERPRISE)", which conflated two cases
        // that P3.5f separates: self-hosted never blocks at all, while a SaaS
        // ENTERPRISE tenant with an UNVERIFIED farm now does. Both are covered
        // in the P3.5f block below.
        mockGetEffectivePlan.mockResolvedValue('ENTERPRISE');
        mockGetLimit.mockReturnValue(null);
        const status = await assertAiBudget(ctx);
        expect(status.limit).toBeNull();
        expect(status.remaining).toBeNull();
        expect(status.softWarn).toBe(false);
        // Usage is not even queried when unlimited.
        expect(mockGetUsed).not.toHaveBeenCalled();
    });
});

// ─── P3.5f — zero AI budget until the farm is verified ───

describe('assertAiBudget: the farm-verification gate (P3.5f)', () => {
    it('refuses an unverified SaaS farm, with its OWN error code', async () => {
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockIsFarmVerified.mockResolvedValue(false);

        await expect(assertAiBudget(ctx)).rejects.toThrow(ForbiddenError);
        // On `code`, not on the message.
        //
        // This read `.rejects.toThrow(/AI_BUDGET_REQUIRES_VERIFIED_FARM/)`
        // until #1645, which matches the MESSAGE — and passed because the call
        // site used `forbidden`, so the code WAS the message and `code` was the
        // generic `FORBIDDEN`. A client switching on `code` saw nothing
        // specific while this test reported the code was being sent.
        await expect(assertAiBudget(ctx)).rejects.toMatchObject({
            code: 'AI_BUDGET_REQUIRES_VERIFIED_FARM',
            message: 'This farm must be verified before it can use AI features.',
        });
        // Distinct from the budget refusal deliberately: the remedy is "get
        // verified", not "upgrade", and a client showing an upgrade prompt here
        // would send a farmer to buy capacity they already have.
        //
        // Asserted on the CODE, not by negating the old prose. `#1677` removed
        // the `ai_budget_exceeded:` prefix, so `not.toThrow(/ai_budget_exceeded/)`
        // would now pass for free — the window it negates is empty
        // (`an-empty-window-passes-a-negated-assertion`). A negative assertion
        // naming a string nothing produces is worse than none, because it
        // reads as coverage.
        await expect(assertAiBudget(ctx)).rejects.not.toMatchObject({
            code: 'AI_BUDGET_EXCEEDED',
        });
    });

    it('refuses BEFORE consulting usage, so an unverified farm costs no query', async () => {
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockIsFarmVerified.mockResolvedValue(false);
        await expect(assertAiBudget(ctx)).rejects.toThrow();
        expect(mockGetUsed).not.toHaveBeenCalled();
    });

    it('refuses an unverified ENTERPRISE SaaS farm — the gate is before the unlimited return', async () => {
        // The ordering case. An ENTERPRISE tenant resolves to an unlimited
        // budget and returns early; gating after that would exempt exactly the
        // most expensive unverified tenant there is.
        mockGetEffectivePlan.mockResolvedValue('ENTERPRISE');
        mockGetLimit.mockReturnValue(null);
        mockIsFarmVerified.mockResolvedValue(false);
        await expect(assertAiBudget(ctx)).rejects.toMatchObject({
            code: 'AI_BUDGET_REQUIRES_VERIFIED_FARM',
        });
    });

    it('does NOT gate a SELF-HOSTED install, however unverified', async () => {
        // The most important case in this file. `getBillingMode()` returns
        // SELFHOSTED whenever there is no STRIPE_SECRET_KEY, and those installs
        // have no staff verification console to verify a farm WITH. An
        // unscoped gate would not tighten anything — it would brick AI
        // permanently on every self-hosted deployment, with no action the
        // operator could take.
        mockGetMode.mockReturnValue('SELFHOSTED');
        mockGetEffectivePlan.mockResolvedValue('ENTERPRISE');
        mockGetLimit.mockReturnValue(null);
        mockIsFarmVerified.mockResolvedValue(false);

        const status = await assertAiBudget(ctx);
        expect(status.limit).toBeNull();
        expect(status.mode).toBe('SELFHOSTED');
        // And it does not even ASK: a self-hosted install should not pay a
        // query for a question that cannot change its answer.
        expect(mockIsFarmVerified).not.toHaveBeenCalled();
    });

    it('lets a verified SaaS farm through to the normal thresholds', async () => {
        // The control. A gate that refused everything would satisfy the cases
        // above while breaking every AI call, and `rejects.toThrow` cannot
        // tell the difference.
        mockGetEffectivePlan.mockResolvedValue('PRO');
        mockGetLimit.mockReturnValue(1000);
        mockGetUsed.mockResolvedValue(100);
        mockIsFarmVerified.mockResolvedValue(true);

        const status = await assertAiBudget(ctx);
        expect(status.remaining).toBe(900);
        expect(mockIsFarmVerified).toHaveBeenCalled();
    });
});
