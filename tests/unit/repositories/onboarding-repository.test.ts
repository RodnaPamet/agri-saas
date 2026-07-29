/**
 * Coverage wave 22 — `OnboardingRepository`.
 *
 * 7 uncovered functions at 0% (7.14% lines). Every method here addresses
 * `TenantOnboarding` by its `tenantId` UNIQUE key taken from the request
 * context, which makes the tenant the row's identity rather than a filter
 * on it — there is no id a caller could substitute. What the tests below
 * protect is the other half: this repository does read-modify-write on
 * two accumulating fields (`stepData`, `completedSteps`), and both are
 * easy to turn into a data-loss bug that only shows up on step 3 of a
 * wizard nobody re-runs.
 */
import { OnboardingRepository } from '@/app-layer/repositories/OnboardingRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('OWNER'); // tenantId: 'tenant-1'
const OTHER_TENANT = makeRequestContext('OWNER', { tenantId: 'tenant-2' });

function makeDb() {
    return {
        tenantOnboarding: {
            findUnique: jest.fn().mockResolvedValue(null),
            upsert: jest.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
            update: jest.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
        },
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('OnboardingRepository — row addressing', () => {
    it('addresses the row by the calling tenant on every entry point', async () => {
        // Break: taking the tenant from anywhere other than ctx — a body
        // field, a header, a cached value. The onboarding row is keyed on
        // tenantId, so a wrong value here writes another tenant's wizard
        // state.
        await OnboardingRepository.getByTenantId(asTx(db), ctx);
        expect(whereOf(db.tenantOnboarding.findUnique)).toEqual({ tenantId: 'tenant-1' });

        db = makeDb();
        await OnboardingRepository.getByTenantId(asTx(db), OTHER_TENANT);
        expect(whereOf(db.tenantOnboarding.findUnique)).toEqual({ tenantId: 'tenant-2' });
    });
});

describe('OnboardingRepository.upsertInitial', () => {
    it('creates the row when absent and leaves an existing one untouched', async () => {
        // Break: giving the `update` branch a body. This runs on every
        // load of the onboarding page, so any field written here would
        // reset a tenant's progress each time they revisit the wizard.
        await OnboardingRepository.upsertInitial(asTx(db), ctx);

        expect(argOf(db.tenantOnboarding.upsert)).toEqual({
            where: { tenantId: 'tenant-1' },
            create: { tenantId: 'tenant-1' },
            update: {},
        });
    });
});

describe('OnboardingRepository.start', () => {
    it('moves the tenant to IN_PROGRESS and stamps the start time either way', async () => {
        await OnboardingRepository.start(asTx(db), ctx);

        const arg = argOf(db.tenantOnboarding.upsert);
        expect(arg.create).toMatchObject({ tenantId: 'tenant-1', status: 'IN_PROGRESS' });
        expect(arg.update).toMatchObject({ status: 'IN_PROGRESS' });
        expect(arg.create.startedAt).toBeInstanceOf(Date);
        expect(arg.update.startedAt).toBeInstanceOf(Date);
    });
});

describe('OnboardingRepository.saveStepData', () => {
    it('merges the new step into the existing blob instead of replacing it', async () => {
        // Break: `data: { stepData: { [step]: data } }`. Saving step 2
        // would wipe everything the tenant entered on step 1 — silent,
        // unrecoverable, and only noticed at the review screen.
        db.tenantOnboarding.findUnique.mockResolvedValue({
            stepData: { COMPANY_PROFILE: { name: 'Acme' } },
        });

        await OnboardingRepository.saveStepData(asTx(db), ctx, 'FRAMEWORKS', { picked: ['iso27001'] });

        expect(dataOf(db.tenantOnboarding.update)).toEqual({
            stepData: {
                COMPANY_PROFILE: { name: 'Acme' },
                FRAMEWORKS: { picked: ['iso27001'] },
            },
        });
    });

    it('overwrites the same step when it is answered again', async () => {
        db.tenantOnboarding.findUnique.mockResolvedValue({
            stepData: { COMPANY_PROFILE: { name: 'Acme' } },
        });

        await OnboardingRepository.saveStepData(asTx(db), ctx, 'COMPANY_PROFILE', { name: 'Acme Ltd' });

        expect(dataOf(db.tenantOnboarding.update).stepData).toEqual({
            COMPANY_PROFILE: { name: 'Acme Ltd' },
        });
    });

    it('starts from an empty blob when the row has no stepData yet', async () => {
        // Break: dropping the `|| {}` fallback. A first save would spread
        // null and throw, so the very first step of onboarding — the one
        // every new tenant hits — would 500.
        db.tenantOnboarding.findUnique.mockResolvedValue({ stepData: null });

        await OnboardingRepository.saveStepData(asTx(db), ctx, 'COMPANY_PROFILE', { name: 'Acme' });

        expect(dataOf(db.tenantOnboarding.update).stepData).toEqual({
            COMPANY_PROFILE: { name: 'Acme' },
        });
    });

    it('survives the row not existing at all', async () => {
        await OnboardingRepository.saveStepData(asTx(db), ctx, 'COMPANY_PROFILE', { name: 'Acme' });

        expect(dataOf(db.tenantOnboarding.update).stepData).toEqual({
            COMPANY_PROFILE: { name: 'Acme' },
        });
    });
});

describe('OnboardingRepository.completeStep', () => {
    it('appends the finished step and advances the pointer', async () => {
        db.tenantOnboarding.findUnique.mockResolvedValue({ completedSteps: ['COMPANY_PROFILE'] });

        await OnboardingRepository.completeStep(asTx(db), ctx, 'FRAMEWORKS', 'INVITE_TEAM');

        expect(dataOf(db.tenantOnboarding.update)).toEqual({
            completedSteps: { set: ['COMPANY_PROFILE', 'FRAMEWORKS'] },
            currentStep: 'INVITE_TEAM',
        });
    });

    it('does not double-record a step completed twice', async () => {
        // Break: pushing unconditionally. Going Back and Next in the
        // wizard would grow the array without bound, and the progress
        // meter — which divides by the array length — would climb past
        // 100%.
        db.tenantOnboarding.findUnique.mockResolvedValue({
            completedSteps: ['COMPANY_PROFILE', 'FRAMEWORKS'],
        });

        await OnboardingRepository.completeStep(asTx(db), ctx, 'FRAMEWORKS', 'INVITE_TEAM');

        expect(dataOf(db.tenantOnboarding.update).completedSteps).toEqual({
            set: ['COMPANY_PROFILE', 'FRAMEWORKS'],
        });
    });

    it('starts the list from empty when the row has none yet', async () => {
        db.tenantOnboarding.findUnique.mockResolvedValue(null);

        await OnboardingRepository.completeStep(asTx(db), ctx, 'COMPANY_PROFILE', 'FRAMEWORKS');

        expect(dataOf(db.tenantOnboarding.update).completedSteps).toEqual({
            set: ['COMPANY_PROFILE'],
        });
    });
});

describe('OnboardingRepository.finish', () => {
    it('marks the tenant complete and stamps the finish time', async () => {
        await OnboardingRepository.finish(asTx(db), ctx);

        expect(whereOf(db.tenantOnboarding.update)).toEqual({ tenantId: 'tenant-1' });
        expect(dataOf(db.tenantOnboarding.update).status).toBe('COMPLETED');
        expect(dataOf(db.tenantOnboarding.update).completedAt).toBeInstanceOf(Date);
    });
});

describe('OnboardingRepository.reset', () => {
    it('clears progress, the answers AND both timestamps', async () => {
        // Break: leaving `completedAt` set on reset. The tenant would be
        // shown the wizard from step one while the "onboarding complete"
        // banner and any completion-gated feature stayed on — two screens
        // disagreeing about the same fact.
        await OnboardingRepository.reset(asTx(db), ctx);

        expect(argOf(db.tenantOnboarding.upsert).update).toEqual({
            status: 'NOT_STARTED',
            currentStep: 'COMPANY_PROFILE',
            completedSteps: { set: [] },
            stepData: {},
            startedAt: null,
            completedAt: null,
        });
    });

    it('creates a fresh row when there is nothing to reset', async () => {
        await OnboardingRepository.reset(asTx(db), ctx);

        expect(argOf(db.tenantOnboarding.upsert).create).toEqual({ tenantId: 'tenant-1' });
    });
});
