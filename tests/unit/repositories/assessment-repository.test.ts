/**
 * Coverage wave 22 — the vendor-assessment repositories
 * (`QuestionnaireRepository`, `VendorAssessmentRepository`,
 * `VendorAnswerRepository`).
 *
 * 10 uncovered functions at 0% — the file had never been executed.
 *
 * Two contract families live here and neither is visible from the
 * usecase tests, which mock this module out:
 *
 *   1. tenant scoping on every vendor-assessment read and write;
 *   2. the DRAFT → IN_REVIEW → decided state machine, enforced by
 *      re-reading the row and refusing out-of-order transitions. That
 *      guard is what stops an assessment being decided before it was
 *      ever submitted, or re-decided after the fact.
 *
 * Questionnaire TEMPLATES are deliberately global (`isGlobal: true`, no
 * tenant column) — that asymmetry is asserted too, because "add the
 * missing tenant filter" would empty the template picker for everyone.
 */
import {
    QuestionnaireRepository,
    VendorAssessmentRepository,
    VendorAnswerRepository,
} from '@/app-layer/repositories/AssessmentRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('ADMIN', { tenantId: 'tenant-2' });

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        upsert: jest.fn(async (args: { create: { questionId: string } }) => ({
            id: `ans-${args.create.questionId}`,
        })),
    });
    return {
        questionnaireTemplate: model(),
        vendorAssessment: model(),
        vendorAssessmentAnswer: model(),
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

describe('QuestionnaireRepository', () => {
    it('offers only the global template catalogue', async () => {
        // Break: dropping `isGlobal`. Templates have no tenant column, so
        // the flag is the only thing separating the published catalogue
        // from drafts — without it the picker lists unfinished templates.
        await QuestionnaireRepository.listTemplates(asTx(db));

        expect(whereOf(db.questionnaireTemplate.findMany)).toEqual({ isGlobal: true });
        expect(argOf(db.questionnaireTemplate.findMany).orderBy).toEqual({ name: 'asc' });
    });

    it('loads a template’s questions in section then sort order', async () => {
        // Break: reversing or dropping the sort. The questionnaire would
        // render its sections interleaved, and the answer indices the UI
        // keys on would no longer line up with the stored sortOrder.
        await QuestionnaireRepository.getByKey(asTx(db), 'soc2-lite');

        expect(whereOf(db.questionnaireTemplate.findUnique)).toEqual({ key: 'soc2-lite' });
        expect(argOf(db.questionnaireTemplate.findUnique).include.questions.orderBy).toEqual([
            { section: 'asc' },
            { sortOrder: 'asc' },
        ]);
    });
});

describe('VendorAssessmentRepository — reads', () => {
    it('scopes a vendor’s assessments to the calling tenant', async () => {
        // Break: filtering on `vendorId` alone. Vendor ids travel in the
        // URL, so an unscoped read publishes another tenant's assessment
        // history and risk ratings for the same supplier.
        await VendorAssessmentRepository.listByVendor(asTx(db), ctx, 'v-1');

        expect(whereOf(db.vendorAssessment.findMany)).toEqual({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
        });
        expect(argOf(db.vendorAssessment.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('follows the caller when a different tenant asks', async () => {
        await VendorAssessmentRepository.listByVendor(asTx(db), OTHER_TENANT, 'v-1');

        expect(whereOf(db.vendorAssessment.findMany).tenantId).toBe('tenant-2');
    });

    it('requires id AND tenant to open a single assessment', async () => {
        await VendorAssessmentRepository.getById(asTx(db), ctx, 'as-1');

        expect(whereOf(db.vendorAssessment.findFirst)).toEqual({
            id: 'as-1',
            tenantId: 'tenant-1',
        });
    });
});

describe('VendorAssessmentRepository.create', () => {
    it('stamps tenant and requester, and opens in DRAFT', async () => {
        // Break: defaulting the status to IN_REVIEW. A brand-new
        // assessment would be decidable before anyone had answered a
        // single question.
        await VendorAssessmentRepository.create(asTx(db), ctx, 'v-1', 'tpl-1');

        expect(dataOf(db.vendorAssessment.create)).toMatchObject({
            tenantId: 'tenant-1',
            vendorId: 'v-1',
            templateId: 'tpl-1',
            requestedByUserId: 'user-1',
            status: 'DRAFT',
        });
        expect(dataOf(db.vendorAssessment.create).startedAt).toBeInstanceOf(Date);
    });
});

describe('VendorAssessmentRepository.submit', () => {
    it('moves a DRAFT to IN_REVIEW and stamps the submission time', async () => {
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'DRAFT' });

        await VendorAssessmentRepository.submit(asTx(db), ctx, 'as-1');

        expect(whereOf(db.vendorAssessment.findFirst)).toEqual({ id: 'as-1', tenantId: 'tenant-1' });
        expect(dataOf(db.vendorAssessment.update)).toMatchObject({ status: 'IN_REVIEW' });
        expect(dataOf(db.vendorAssessment.update).submittedAt).toBeInstanceOf(Date);
    });

    it('refuses to re-submit something already in review', async () => {
        // Break: dropping the status precondition. Re-submitting would
        // overwrite `submittedAt`, so the "how long has this been sitting
        // with the reviewer" clock silently resets on every double-click.
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'IN_REVIEW' });

        expect(await VendorAssessmentRepository.submit(asTx(db), ctx, 'as-1')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('refuses on an assessment belonging to another tenant', async () => {
        expect(await VendorAssessmentRepository.submit(asTx(db), ctx, 'as-1')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });
});

describe('VendorAssessmentRepository.decide', () => {
    it('records the decision, the decider and the notes', async () => {
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'IN_REVIEW' });

        await VendorAssessmentRepository.decide(asTx(db), ctx, 'as-1', 'APPROVED', 'Evidence sufficient');

        expect(dataOf(db.vendorAssessment.update)).toMatchObject({
            status: 'APPROVED',
            decidedByUserId: 'user-1',
            notes: 'Evidence sufficient',
        });
        expect(dataOf(db.vendorAssessment.update).decidedAt).toBeInstanceOf(Date);
    });

    it('normalises absent notes to null rather than undefined', async () => {
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'IN_REVIEW' });

        await VendorAssessmentRepository.decide(asTx(db), ctx, 'as-1', 'REJECTED');

        expect(dataOf(db.vendorAssessment.update).notes).toBeNull();
    });

    it('refuses to decide an assessment that was never submitted', async () => {
        // Break: dropping the IN_REVIEW precondition. A DRAFT could be
        // approved with zero answers on file — the vendor risk sign-off
        // would then rest on an empty questionnaire.
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'DRAFT' });

        expect(await VendorAssessmentRepository.decide(asTx(db), ctx, 'as-1', 'APPROVED')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('refuses to re-decide an already-decided assessment', async () => {
        db.vendorAssessment.findFirst.mockResolvedValue({ id: 'as-1', status: 'APPROVED' });

        expect(await VendorAssessmentRepository.decide(asTx(db), ctx, 'as-1', 'REJECTED')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });

    it('refuses on an assessment belonging to another tenant', async () => {
        expect(await VendorAssessmentRepository.decide(asTx(db), ctx, 'as-1', 'APPROVED')).toBeNull();
        expect(db.vendorAssessment.update).not.toHaveBeenCalled();
    });
});

describe('VendorAssessmentRepository.updateScore', () => {
    it('writes the computed score and derived rating', async () => {
        await VendorAssessmentRepository.updateScore(asTx(db), 'as-1', 72, 'HIGH');

        expect(argOf(db.vendorAssessment.update)).toEqual({
            where: { id: 'as-1' },
            data: { score: 72, riskRating: 'HIGH' },
        });
    });
});

describe('VendorAnswerRepository', () => {
    it('upserts each answer against the (assessment, question) unique pair', async () => {
        // Break: `create` instead of `upsert`, or a key on questionId
        // alone. The questionnaire autosaves as the reviewer types, so a
        // create would collide on the second keystroke and a
        // question-only key would overwrite the SAME question's answer
        // across every assessment in the database.
        await VendorAnswerRepository.upsertMany(asTx(db), ctx, 'as-1', [
            { questionId: 'q-1', answerJson: { value: 'yes' }, computedPoints: 5 },
            { questionId: 'q-2', answerJson: { value: 'no' }, computedPoints: 0 },
        ]);

        expect(db.vendorAssessmentAnswer.upsert).toHaveBeenCalledTimes(2);
        expect(argOf(db.vendorAssessmentAnswer.upsert).where).toEqual({
            assessmentId_questionId: { assessmentId: 'as-1', questionId: 'q-1' },
        });
    });

    it('stamps the tenant only on the create branch, and returns every row', async () => {
        const res = await VendorAnswerRepository.upsertMany(asTx(db), ctx, 'as-1', [
            { questionId: 'q-1', answerJson: { value: 'yes' }, computedPoints: 5 },
            { questionId: 'q-2', answerJson: { value: 'no' }, computedPoints: 0 },
        ]);

        const first = argOf(db.vendorAssessmentAnswer.upsert);
        expect(first.create).toMatchObject({ tenantId: 'tenant-1', assessmentId: 'as-1' });
        // Break: returning the last result instead of accumulating. The
        // usecase sums `computedPoints` over this array to derive the
        // score, so a dropped element under-scores the vendor.
        expect(res.map((r) => (r as { id: string }).id)).toEqual(['ans-q-1', 'ans-q-2']);
    });

    it('writes nothing at all for an empty answer set', async () => {
        expect(await VendorAnswerRepository.upsertMany(asTx(db), ctx, 'as-1', [])).toEqual([]);
        expect(db.vendorAssessmentAnswer.upsert).not.toHaveBeenCalled();
    });

    it('lists an assessment’s answers tenant-scoped', async () => {
        await VendorAnswerRepository.listByAssessment(asTx(db), ctx, 'as-1');

        expect(whereOf(db.vendorAssessmentAnswer.findMany)).toEqual({
            tenantId: 'tenant-1',
            assessmentId: 'as-1',
        });
    });
});
