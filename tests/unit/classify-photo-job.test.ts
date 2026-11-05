/**
 * Unit tests for the classify-photo job. Mocks the vision orchestrator,
 * storage, prisma, RAG, audit, and the tenant-context runner — no
 * network, no DB, no native inference. Proves the job:
 *   - writes the result under attributesJson.pestId (advisory key only),
 *   - gates low confidence (flag + inconclusive recommendation, no RAG),
 *   - grounds the recommendation via askKnowledgeBase when confident,
 *   - audits via logEvent,
 *   - NEVER mutates the entry's type/fields,
 *   - is fail-safe (no-op when the image can't be read / no result).
 */
import { Readable } from 'stream';

const identifyPhotoMock = jest.fn();
const askKnowledgeBaseMock = jest.fn();
const logEventMock = jest.fn();
const updateMock = jest.fn();
const readStreamMock = jest.fn();
const assertAiBudgetMock = jest.fn();
const recordAiUsageMock = jest.fn();

jest.mock('@/app-layer/ai/vision', () => ({ identifyPhoto: identifyPhotoMock }));
jest.mock('@/app-layer/usecases/rag', () => ({ askKnowledgeBase: askKnowledgeBaseMock }));
jest.mock('@/app-layer/ai/budget', () => ({ assertAiBudget: (...a: unknown[]) => assertAiBudgetMock(...a) }));
jest.mock('@/app-layer/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => recordAiUsageMock(...a) }));
jest.mock('@/app-layer/ai/cost', () => ({ estimateCostMicros: () => 42 }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: logEventMock }));
jest.mock('@/lib/permissions', () => ({ getPermissionsForRole: () => ({}) }));
jest.mock('@/lib/storage', () => ({ getProviderByName: () => ({ readStream: readStreamMock }) }));
jest.mock('@/lib/observability/job-runner', () => ({ runJob: (_n: string, fn: () => unknown) => fn() }));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const findFirstFile = jest.fn();
const findFirstEntry = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        fileRecord: { findFirst: (...a: unknown[]) => findFirstFile(...a) },
        logEntry: { findFirst: (...a: unknown[]) => findFirstEntry(...a) },
    },
}));

/**
 * Every farm the entry READ ran under, in order (#2739).
 *
 * `LogEntry.notes` is encrypted under the farm's DEK, and this read used to sit
 * on the global client — so it returned the `v2:` envelope and fed it to the
 * model as the farmer's description of the photo. The farm context this file
 * already opened was for the UPDATE, later in the same function, which is why
 * "does this file use runInTenantContext?" answered yes and said nothing about
 * the read.
 */
const tenantContexts: string[] = [];
// `runInTenantContext` runs the callback with a stub db exposing the
// `logEntry.update` we assert on. `withTenantDb` wraps the READ, and records
// the farm so the property above is checkable rather than merely unblocked.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({ logEntry: { update: (...a: unknown[]) => updateMock(...a) } }),
    withTenantDb: (tenantId: string, cb: (db: unknown) => unknown) => {
        tenantContexts.push(tenantId);
        return cb({ logEntry: { findFirst: (...a: unknown[]) => findFirstEntry(...a) } });
    },
}));

import { runClassifyPhoto, PEST_ID_DISCLAIMER } from '@/app-layer/jobs/classify-photo';

const PAYLOAD = { tenantId: 'tenant-a', logEntryId: 'log-1', fileId: 'file-1' };

beforeEach(() => {
    jest.clearAllMocks();
    findFirstFile.mockResolvedValue({ pathKey: 'k', mimeType: 'image/png', storageProvider: 'local' });
    findFirstEntry.mockResolvedValue({ title: 'Leaf', notes: 'yellowing', attributesJson: { costAmount: 5 } });
    readStreamMock.mockImplementation(() => Readable.from(Buffer.from('imgbytes')));
    assertAiBudgetMock.mockResolvedValue({ used: 0, limit: null, remaining: null, softWarn: false });
    tenantContexts.length = 0;
});

describe('runClassifyPhoto — confident result', () => {
    beforeEach(() => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Potato — Early blight',
            confidence: 0.91,
            recommendation: 'raw rec',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
        });
        askKnowledgeBaseMock.mockResolvedValue({ answer: 'grounded advice', sources: [{ id: 's1' }] });
    });

    it('writes the result under attributesJson.pestId with the disclaimer + grounded recommendation', async () => {
        const { classified } = await runClassifyPhoto(PAYLOAD);
        expect(classified).toBe(true);
        const data = updateMock.mock.calls[0][0].data.attributesJson;
        expect(data.pestId.identifiedPest).toBe('Potato — Early blight');
        expect(data.pestId.confidence).toBe(0.91);
        expect(data.pestId.lowConfidence).toBe(false);
        expect(data.pestId.recommendation).toBe('grounded advice');
        expect(data.pestId.disclaimer).toBe(PEST_ID_DISCLAIMER);
        expect(data.pestId.backend).toBe('onnx');
        expect(data.pestId.fileRecordId).toBe('file-1');
    });

    it('preserves existing attributesJson keys (never mutates entry fields)', async () => {
        await runClassifyPhoto(PAYLOAD);
        const data = updateMock.mock.calls[0][0].data.attributesJson;
        // The pre-existing field is preserved; only pestId is added.
        expect(data.costAmount).toBe(5);
        // The update targets only attributesJson — no type/title/notes change.
        expect(Object.keys(updateMock.mock.calls[0][0].data)).toEqual(['attributesJson']);
    });

    it('audits the classification via logEvent', async () => {
        await runClassifyPhoto(PAYLOAD);
        expect(logEventMock).toHaveBeenCalledTimes(1);
        const payload = logEventMock.mock.calls[0][2];
        expect(payload.action).toBe('LOG_ENTRY_PHOTO_CLASSIFIED');
        expect(payload.entityType).toBe('LogEntry');
        expect(payload.detailsJson.category).toBe('custom');
    });
});

describe('runClassifyPhoto — low confidence gating', () => {
    it('flags lowConfidence + an inconclusive recommendation, skips RAG', async () => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Tomato — Leaf Mold',
            confidence: 0.31,
            recommendation: 'raw rec',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
        });
        const { classified } = await runClassifyPhoto(PAYLOAD);
        expect(classified).toBe(true);
        const data = updateMock.mock.calls[0][0].data.attributesJson;
        expect(data.pestId.lowConfidence).toBe(true);
        expect(data.pestId.recommendation).toMatch(/inconclusive/i);
        expect(askKnowledgeBaseMock).not.toHaveBeenCalled();
    });
});

describe('runClassifyPhoto — fail-safe', () => {
    it('no-ops (no write) when the vision orchestrator returns null', async () => {
        identifyPhotoMock.mockResolvedValue(null);
        const { classified } = await runClassifyPhoto(PAYLOAD);
        expect(classified).toBe(false);
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('no-ops when the file is not an image', async () => {
        findFirstFile.mockResolvedValue({ pathKey: 'k', mimeType: 'application/pdf', storageProvider: 'local' });
        const { classified } = await runClassifyPhoto(PAYLOAD);
        expect(classified).toBe(false);
        expect(identifyPhotoMock).not.toHaveBeenCalled();
    });

    it('falls back to the raw recommendation when RAG finds no sources', async () => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Potato — Early blight',
            confidence: 0.91,
            recommendation: 'raw rec',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
        });
        askKnowledgeBaseMock.mockResolvedValue({ answer: 'not in sources', sources: [] });
        await runClassifyPhoto(PAYLOAD);
        const data = updateMock.mock.calls[0][0].data.attributesJson;
        expect(data.pestId.recommendation).toBe('raw rec');
    });
});

/**
 * The budget seam added by #2596.
 *
 * The suite above mocks `identifyPhoto` and did not mock the budget, so the
 * real `assertAiBudget` ran and — in self-hosted mode, where every tenant is
 * ENTERPRISE and unlimited — always allowed. The gate was therefore EXECUTED
 * and never DISCRIMINATING: every assertion passed whichever answer it gave.
 * These mock it so the two answers are distinguishable.
 */
describe('runClassifyPhoto — the AI budget seam (#2596)', () => {
    it('asks the budget and passes allowCloud: true when there is room', async () => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Potato — Early blight',
            confidence: 0.9,
            recommendation: 'r',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
        });
        askKnowledgeBaseMock.mockResolvedValue({ answer: 'a', sources: [] });

        await runClassifyPhoto(PAYLOAD);

        expect(assertAiBudgetMock).toHaveBeenCalled();
        expect(identifyPhotoMock).toHaveBeenCalledWith(
            expect.objectContaining({ mimeType: 'image/png' }),
            { allowCloud: true },
        );
    });

    it('passes allowCloud: false when the budget is exhausted — and still classifies', async () => {
        const err = Object.assign(new Error('budget'), { code: 'AI_BUDGET_EXCEEDED' });
        Object.setPrototypeOf(err, (await import('@/lib/errors/types')).AppError.prototype);
        assertAiBudgetMock.mockRejectedValue(err);
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'unknown',
            confidence: 0.2,
            recommendation: 'r',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
        });

        await runClassifyPhoto(PAYLOAD);

        expect(identifyPhotoMock).toHaveBeenCalledWith(expect.anything(), { allowCloud: false });
        // The job still ran: an out-of-budget farm loses the cloud second
        // opinion, not its on-device classification.
        expect(updateMock).toHaveBeenCalled();
    });

    it('RETHROWS a non-budget failure instead of reading it as "no budget"', async () => {
        // Absorbing this would make a database blip and an exhausted budget
        // produce the same observable, and the log would blame the wrong one.
        assertAiBudgetMock.mockRejectedValue(new Error('postgres is down'));
        await expect(runClassifyPhoto(PAYLOAD)).rejects.toThrow('postgres is down');
        expect(identifyPhotoMock).not.toHaveBeenCalled();
    });

    it('records usage when a PAID backend produced the result', async () => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Tomato — Late blight',
            confidence: 0.8,
            recommendation: 'r',
            modelVersion: 'claude-sonnet-4-6',
            backend: 'claude',
            usage: {
                model: 'claude-sonnet-4-6',
                promptTokens: 900,
                completionTokens: 120,
                totalTokens: 1020,
            },
        });
        askKnowledgeBaseMock.mockResolvedValue({ answer: 'a', sources: [] });

        await runClassifyPhoto(PAYLOAD);

        expect(recordAiUsageMock).toHaveBeenCalledTimes(1);
        expect(recordAiUsageMock.mock.calls[0][1]).toMatchObject({
            task: 'classify-photo',
            backend: 'claude',
            totalTokens: 1020,
        });
    });

    it('records NOTHING when the on-device backend produced it', async () => {
        identifyPhotoMock.mockResolvedValue({
            identifiedPest: 'Potato — Early blight',
            confidence: 0.9,
            recommendation: 'r',
            modelVersion: 'cropnet-v1',
            backend: 'onnx',
            // No `usage` — ONNX spends nothing, and a zero-filled row would be
            // a claim about a transaction that never happened.
        });
        askKnowledgeBaseMock.mockResolvedValue({ answer: 'a', sources: [] });

        await runClassifyPhoto(PAYLOAD);

        expect(recordAiUsageMock).not.toHaveBeenCalled();
    });
});

describe('the entry read runs in the farm that holds the key (#2739)', () => {
    test('the read is bound to the payload tenant', async () => {
        await runClassifyPhoto(PAYLOAD);
        // Without this the read returns ciphertext, silently, and the model is
        // handed base64 where the farmer's description should be.
        expect(tenantContexts).toEqual([PAYLOAD.tenantId]);
    });

    test('the farmer’s notes reach the grounding step as PLAINTEXT', async () => {
        await runClassifyPhoto(PAYLOAD);
        // `contextNote` joins title and notes and goes to `groundRecommendation`,
        // which asks the knowledge base. The fixture's notes are 'yellowing'.
        expect(askKnowledgeBaseMock).toHaveBeenCalled();
        const asked = JSON.stringify(askKnowledgeBaseMock.mock.calls);
        expect(asked).toContain('yellowing');
        expect(asked).not.toMatch(/v[12]:/);
    });

    test('an UNREADABLE note becomes an ABSENT context slot, not an opaque string', async () => {
        /*
         * `withTenantDb` makes the key resolvable; it cannot make it resolve.
         * A failed DEK lookup logs and returns NO_DEK_PAIR, so the extension
         * passes the ciphertext on — and the prompt has no way to explain an
         * envelope. `readableOrNull` drops it instead: an unbounded opaque
         * value in a context slot is worse than a missing one.
         */
        findFirstEntry.mockResolvedValue({
            title: 'Leaf',
            notes: 'v2:GnxO1vf/3MkC4orNu07tftzwnlxBD99pB5hqmN1pwds',
            attributesJson: {},
        });
        await runClassifyPhoto(PAYLOAD);
        const asked = JSON.stringify(askKnowledgeBaseMock.mock.calls);
        expect(asked).not.toMatch(/v[12]:/);
        // The title survives — only the unreadable half is dropped.
        expect(asked).toContain('Leaf');
    });
});
