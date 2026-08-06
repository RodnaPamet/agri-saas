/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Readiness means "control points backed by approved records", and is a ratio.
 *
 * Three defects, one number.
 *
 * **The evidence filter.** The `evidence` include carried no `where` at all, so
 * a soft-deleted or archived APPROVED row still satisfied its control —
 * evidence a farm had explicitly removed went on propping up its certification
 * score. `scheme-pack.ts` filters status, `deletedAt` and `isArchived`; this
 * filtered none of them. (The status half landed earlier; the other two are
 * here.)
 *
 * **The formula.** `coveragePercent - missingEvidence*2 - overdueTasks*3`
 * subtracts raw COUNTS from a PERCENTAGE:
 *
 *   - not comparable across schemes — the same farm scores differently on a
 *     7-point demo and a 200-point standard purely because the subtrahend
 *     grows with the control count;
 *   - saturates at 0 for any real standard: 50 controls missing evidence is
 *     −100, so every serious scheme reads zero regardless of progress;
 *   - the overdue term is structurally always 0, because pack templates set no
 *     `dueAt` and the overdue test requires one.
 *
 * It produced 92 on a completely EMPTY farm, and that number is printed on a
 * farmer-facing PDF with a "%" suffix.
 *
 * **Satisfaction.** There was no per-requirement concept at all —
 * `coveragePercent` asks only whether a control row LINKS to a requirement, so
 * installing a starter pack read 100% instantly on a farm with zero records.
 */

const mockTenantDb = { controlRequirementLink: { findMany: jest.fn() } } as any;
const mockPrisma = {
    framework: { findFirst: jest.fn(), findUnique: jest.fn() },
    frameworkRequirement: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: any, fn: (db: any) => any) => fn(mockTenantDb)),
}));
jest.mock('@/app-layer/policies/framework.policies', () => ({
    assertCanViewFrameworks: jest.fn(),
    assertCanWriteCatalogue: jest.fn(),
    assertCanInstallFrameworkPack: jest.fn(),
}));
jest.mock('@/lib/observability', () => ({
    traceUsecase: jest.fn((_n: string, _c: any, fn: () => any) => fn()),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

interface EvidenceStub { id: string; status: string }
interface ControlStub {
    id: string;
    code: string;
    name: string;
    status?: string;
    evidence?: EvidenceStub[];
}

/** N requirements, each mapped to the control supplied for it (or none). */
function given(reqs: Array<{ code: string; control?: ControlStub }>) {
    mockPrisma.framework.findFirst.mockResolvedValue({ id: 'fw-1', key: 'GG', name: 'GlobalG.A.P.', version: '6' });
    mockPrisma.frameworkRequirement.findMany.mockResolvedValue(
        reqs.map((r, i) => ({
            id: `req-${i}`, code: r.code, title: `Point ${r.code}`,
            section: 'CB', category: null, sortOrder: i,
        })),
    );
    mockTenantDb.controlRequirementLink.findMany.mockResolvedValue(
        reqs.flatMap((r, i) =>
            r.control
                ? [{
                    requirementId: `req-${i}`,
                    control: {
                        status: 'ACTIVE',
                        description: null,
                        tasks: [],
                        evidence: [],
                        ...r.control,
                    },
                }]
                : [],
        ),
    );
}

const approved = (id = 'e1'): EvidenceStub => ({ id, status: 'APPROVED' });
const submitted = (id = 'e2'): EvidenceStub => ({ id, status: 'SUBMITTED' });

beforeEach(() => jest.clearAllMocks());

describe('readiness is a ratio', () => {
    it('is 0 on an empty farm — not 92', () => {
        // The demo floor. A farm that has done nothing scored 92 because the
        // formula started from mapping coverage and subtracted counts.
        given([{ code: 'CB.7.1' }, { code: 'CB.7.6' }, { code: 'CB.7.9' }]);
        return generateReadinessReport(ctx, 'GG').then((r) => {
            expect(r.summary.readinessScore).toBe(0);
        });
    });

    it('is 0 immediately after a pack install, when nothing is evidenced', async () => {
        // Every requirement mapped to a control, zero records. `coveragePercent`
        // is 100 here — which is exactly the number that used to drive the
        // score and the confetti.
        given([
            { code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A' } },
            { code: 'CB.7.6', control: { id: 'c2', code: 'C-2', name: 'B' } },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.coveragePercent).toBe(100);
        expect(r.summary.readinessScore).toBe(0);
    });

    it('reaches 100 only when every applicable point has approved evidence', async () => {
        given([
            { code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'CB.7.6', control: { id: 'c2', code: 'C-2', name: 'B', evidence: [approved('e3')] } },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.readinessScore).toBe(100);
    });

    it('scores the halfway case at 50, not at some subtracted number', async () => {
        given([
            { code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'CB.7.6', control: { id: 'c2', code: 'C-2', name: 'B' } },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.readinessScore).toBe(50);
    });

    it('does not saturate at 0 on a large standard', async () => {
        // 60 requirements, 30 satisfied. Under the old formula
        // (100 − 30×2 = 40 at best, and worse as the standard grows) the
        // subtrahend scaled with control count; a 200-point standard read 0
        // no matter what the farm had done.
        const reqs = Array.from({ length: 60 }, (_, i) => ({
            code: `R.${i}`,
            control: {
                id: `c${i}`, code: `C-${i}`, name: `Ctl ${i}`,
                evidence: i < 30 ? [approved(`e${i}`)] : [],
            },
        }));
        given(reqs);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.readinessScore).toBe(50);
    });

    it('is comparable across schemes of different size', async () => {
        given([
            { code: 'A', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'B', control: { id: 'c2', code: 'C-2', name: 'B' } },
        ]);
        const small = await generateReadinessReport(ctx, 'GG');

        const big = Array.from({ length: 100 }, (_, i) => ({
            code: `R.${i}`,
            control: {
                id: `c${i}`, code: `C-${i}`, name: `Ctl ${i}`,
                evidence: i < 50 ? [approved(`e${i}`)] : [],
            },
        }));
        given(big);
        const large = await generateReadinessReport(ctx, 'GG');

        // Half done is half done, whatever the standard's size.
        expect(small.summary.readinessScore).toBe(large.summary.readinessScore);
    });
});

describe('what counts as satisfying a control point', () => {
    it('an unreviewed record does not satisfy one', async () => {
        given([{ code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [submitted()] } }]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.readinessScore).toBe(0);
    });

    it('NOT_APPLICABLE points leave the denominator, so 100 stays reachable', async () => {
        // A farm with no livestock cannot satisfy a livestock control point.
        // Counting it against them would put full readiness out of reach for a
        // real holding.
        given([
            { code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'LV.1', control: { id: 'c2', code: 'C-2', name: 'Livestock', status: 'NOT_APPLICABLE' } },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.applicableRequirements).toBe(1);
        expect(r.summary.readinessScore).toBe(100);
    });

    it('an UNMAPPED point stays in the denominator', async () => {
        // Nothing has been claimed for it, so it is not N/A — it is simply not
        // done, and the score has to say so.
        given([
            { code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'CB.7.6' },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.summary.applicableRequirements).toBe(2);
        expect(r.summary.readinessScore).toBe(50);
    });
});

describe('per-requirement detail', () => {
    it('names each point satisfied, mapped-only, or untouched', async () => {
        given([
            { code: 'DONE', control: { id: 'c1', code: 'C-1', name: 'A', evidence: [approved()] } },
            { code: 'WAITING', control: { id: 'c2', code: 'C-2', name: 'B', evidence: [submitted()] } },
            { code: 'NOTHING' },
        ]);
        const r = await generateReadinessReport(ctx, 'GG');
        const by = Object.fromEntries(r.requirements.map((x) => [x.code, x]));

        expect(by.DONE).toMatchObject({ mapped: true, satisfied: true, approvedEvidenceCount: 1 });
        expect(by.WAITING).toMatchObject({ mapped: true, satisfied: false, awaitingReviewCount: 1 });
        expect(by.NOTHING).toMatchObject({ mapped: false, satisfied: false });
    });

    it('carries the controls behind each point, so the answer is actionable', async () => {
        given([{ code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'Spray records', evidence: [approved()] } }]);
        const r = await generateReadinessReport(ctx, 'GG');
        expect(r.requirements[0].controls).toEqual([
            { id: 'c1', code: 'C-1', name: 'Spray records', status: 'ACTIVE', approvedEvidenceCount: 1 },
        ]);
    });
});

describe('the evidence query is filtered at the database', () => {
    it('excludes soft-deleted and archived rows', async () => {
        // A row a farm removed must not go on satisfying a control point. This
        // asserts the WHERE, because in-memory filtering of a status alone is
        // exactly what the previous fix did and it left these two open.
        given([{ code: 'CB.7.1', control: { id: 'c1', code: 'C-1', name: 'A' } }]);
        await generateReadinessReport(ctx, 'GG');

        const args = mockTenantDb.controlRequirementLink.findMany.mock.calls[0][0];
        expect(args.include.control.include.evidence.where).toEqual({
            deletedAt: null,
            isArchived: false,
        });
    });
});
