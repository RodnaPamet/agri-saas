/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Readiness counts APPROVED evidence, and only APPROVED evidence.
 *
 * `auto-evidence.ts` states the invariant in its header, as the reason it is
 * safe to mint evidence automatically:
 *
 *   "STATUS = SUBMITTED, deliberately. […] Readiness scoring only counts
 *    APPROVED evidence, so nothing unreviewed silently inflates a scheme's
 *    readiness — a person still signs off."
 *
 * The readiness report counted `c.evidence.length > 0`. Every clause of that
 * sentence was false: filing a spray record minted SUBMITTED evidence, which
 * removed the control from `controlsMissingEvidence` on creation, which raised
 * `readinessScore`, which is the number the farm dashboard shows as the
 * certification score. The product reported a sign-off that had not happened.
 *
 * These tests exist so that sentence and the code agree, and stay agreeing.
 */

const mockTenantDb = { controlRequirementLink: { findMany: jest.fn() } } as any;

const mockPrisma = {
    framework: { findFirst: jest.fn() },
    frameworkRequirement: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockTenantDb)),
}));

jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(),
    assertCanManageFrameworks: jest.fn(),
}));

jest.mock('@/lib/observability', () => ({
    traceUsecase: jest.fn((_n: string, _c: any, fn: () => any) => fn()),
    traceOperation: jest.fn((_n: string, fn: () => any) => fn()),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
    getRequestContext: jest.fn(() => null),
}));

import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** One requirement, one control, with the evidence rows under test. */
function given(evidence: Array<{ id: string; status: string; title: string }>) {
    mockPrisma.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'GG', name: 'GlobalG.A.P.', version: '6' });
    mockPrisma.frameworkRequirement.findMany.mockResolvedValue([
        { id: 'req-1', code: 'CB.7.6', title: 'Application records', section: 'CB', category: null, sortOrder: 1 },
    ]);
    mockTenantDb.controlRequirementLink.findMany.mockResolvedValue([
        {
            requirementId: 'req-1',
            control: {
                id: 'ctrl-1',
                code: 'C-1',
                name: 'Spray records kept',
                status: 'ACTIVE',
                description: null,
                tasks: [],
                evidence: evidence.map((e) => ({ ...e, category: null, sourceLogEntryId: null })),
            },
        },
    ]);
}

beforeEach(() => jest.clearAllMocks());

describe('generateReadinessReport — evidence must be approved', () => {
    it('counts a control with APPROVED evidence as covered', async () => {
        given([{ id: 'ev-1', status: 'APPROVED', title: 'Spray log' }]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(0);
        expect(report.controlsMissingEvidence).toHaveLength(0);
    });

    it('does NOT count SUBMITTED evidence — the auto-evidence case', async () => {
        // Exactly what attachAutoEvidenceFromLogEntry creates. Filing a spray
        // record used to move the certification score on its own.
        given([{ id: 'ev-1', status: 'SUBMITTED', title: 'Auto: spray log' }]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(1);
        expect(report.controlsMissingEvidence[0]).toMatchObject({
            code: 'C-1',
            awaitingReview: 1,
        });
    });

    it('does NOT count REJECTED evidence', async () => {
        // The sharper case: a reviewer explicitly refused it, and the control
        // still read as covered.
        given([{ id: 'ev-1', status: 'REJECTED', title: 'Blurry photo' }]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(1);
        expect(report.controlsMissingEvidence[0].awaitingReview).toBe(0);
    });

    it('does NOT count DRAFT evidence', async () => {
        given([{ id: 'ev-1', status: 'DRAFT', title: 'Half-filled' }]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(1);
    });

    it('one APPROVED row among several unreviewed ones is enough', async () => {
        given([
            { id: 'ev-1', status: 'SUBMITTED', title: 'Auto 1' },
            { id: 'ev-2', status: 'APPROVED', title: 'Signed off' },
            { id: 'ev-3', status: 'REJECTED', title: 'Refused' },
        ]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(0);
    });

    it('separates "nothing filed" from "waiting on a reviewer"', async () => {
        // Same missing-evidence count, two different jobs for the operator:
        // one needs a record collected, the other needs someone to look.
        given([]);
        const nothingFiled = await generateReadinessReport(ctx, 'GG');
        expect(nothingFiled.controlsMissingEvidence[0].awaitingReview).toBe(0);

        given([{ id: 'ev-1', status: 'SUBMITTED', title: 'Auto' }, { id: 'ev-2', status: 'SUBMITTED', title: 'Auto 2' }]);
        const waiting = await generateReadinessReport(ctx, 'GG');
        expect(waiting.controlsMissingEvidence[0].awaitingReview).toBe(2);
    });

    it('the readiness score reflects the unreviewed row', async () => {
        // The number the AG dashboard shows as the certification score.
        given([{ id: 'ev-1', status: 'APPROVED', title: 'Signed off' }]);
        const approved = await generateReadinessReport(ctx, 'GG');

        given([{ id: 'ev-1', status: 'SUBMITTED', title: 'Auto' }]);
        const submitted = await generateReadinessReport(ctx, 'GG');

        expect(submitted.summary.readinessScore).toBeLessThan(approved.summary.readinessScore);
    });

    it('still exempts NOT_APPLICABLE controls', async () => {
        given([]);
        mockTenantDb.controlRequirementLink.findMany.mockResolvedValue([
            {
                requirementId: 'req-1',
                control: {
                    id: 'ctrl-1', code: 'C-1', name: 'N/A here',
                    status: 'NOT_APPLICABLE', description: 'No livestock on this holding',
                    tasks: [], evidence: [],
                },
            },
        ]);
        const report = await generateReadinessReport(ctx, 'GG');
        expect(report.summary.missingEvidenceCount).toBe(0);
        expect(report.notApplicableControls).toHaveLength(1);
    });
});
