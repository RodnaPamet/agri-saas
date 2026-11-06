/**
 * RAG context builder + askKnowledgeBase no-sources path (feat/ai-rag).
 *
 * buildContext: forces citation + source-only answering + the exact
 * "not in my sources" refusal phrase; numbers sources from 1.
 * askKnowledgeBase: returns the no-sources answer WITHOUT calling the
 * model when retrieve() finds nothing.
 */
import { buildContext, NO_SOURCES_ANSWER } from '@/app-layer/ai/rag/build-context';
import type { RetrievedChunk } from '@/app-layer/ai/rag/retrieve';

// ── Mocks for askKnowledgeBase ──
const mockRetrieve = jest.fn();
const mockComplete = jest.fn();

jest.mock('@/app-layer/ai/rag/retrieve', () => ({
    retrieve: (...args: unknown[]) => mockRetrieve(...args),
}));
/*
 * The seam moved to `completeWithRouting` (#2765): this path spent tokens that
 * never reached `recordAiUsage`, so the monthly total its own
 * `assertAiSpendAllowed` gate read was understated by its own consumption.
 * Routing it fixes the ledger and gains failover; the mock follows the subject.
 *
 * `opts` is forwarded as mockComplete's FIRST argument so the existing
 * assertions keep meaning what they meant.
 */
const mockRoutedTask = jest.fn();
jest.mock('@/app-layer/ai/routing', () => ({
    completeWithRouting: (_ctx: unknown, task: unknown, opts: unknown) => {
        mockRoutedTask(task);
        return mockComplete(opts);
    },
}));

import { askKnowledgeBase } from '@/app-layer/usecases/rag';
import { makeRequestContext } from '../helpers/make-context';

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
    return {
        id: over.id ?? 'c1',
        source: over.source ?? 'KCC (GODL)',
        sourceType: over.sourceType ?? 'EXTERNAL',
        text: over.text ?? 'Apply nitrogen in split doses.',
        language: over.language ?? null,
        score: over.score ?? 0.9,
    };
}

beforeEach(() => {
    mockRetrieve.mockReset();
    mockComplete.mockReset();
});

describe('buildContext', () => {
    it('numbers sources from 1 and renders source label + text', () => {
        const prompt = buildContext(
            [
                chunk({ id: 'a', source: 'KCC (GODL)', text: 'first fact' }),
                chunk({ id: 'b', source: 'EU 2018/848', text: 'second fact' }),
            ],
            'how do I fertilise?',
        );
        expect(prompt).toContain('[1] (KCC (GODL)) first fact');
        expect(prompt).toContain('[2] (EU 2018/848) second fact');
    });

    it('instructs the model to cite by number + use only the sources', () => {
        const prompt = buildContext([chunk()], 'q');
        expect(prompt).toMatch(/ONLY the numbered sources/i);
        expect(prompt).toMatch(/Cite every claim with its source number/i);
    });

    it('embeds the exact refusal phrase for the unsupported case', () => {
        const prompt = buildContext([chunk()], 'q');
        expect(prompt).toContain(NO_SOURCES_ANSWER);
    });

    it('includes the question', () => {
        const prompt = buildContext([chunk()], '  how to practice blight?  ');
        expect(prompt).toContain('how to practice blight?');
    });

    it('handles the empty-source case without throwing', () => {
        const prompt = buildContext([], 'q');
        expect(prompt).toContain('(no sources retrieved)');
    });
});

describe('askKnowledgeBase — no-sources path', () => {
    it('returns the not-in-my-sources answer + empty sources when retrieve is empty', async () => {
        mockRetrieve.mockResolvedValueOnce([]);
        const ctx = makeRequestContext('READER');

        const result = await askKnowledgeBase(ctx, 'unknown question');

        expect(result.answer).toBe(NO_SOURCES_ANSWER);
        expect(result.sources).toEqual([]);
        // The model is NOT called when there is nothing to ground on — and
        // now the ROUTER is not reached either, so nothing is charged.
        expect(mockComplete).not.toHaveBeenCalled();
        expect(mockRoutedTask).not.toHaveBeenCalled();
    });

    it('#2765 — asks for the rag-answer route rather than a bare provider', async () => {
        /*
         * Without this the change is invisible to the suite: every other test
         * here mocks the seam and would pass against a direct provider call.
         * The task name is what selects Sonnet, the usage ledger, and the
         * ollama failover that keeps a self-hosted install answering.
         */
        mockRetrieve.mockResolvedValueOnce([chunk()]);
        mockComplete.mockResolvedValueOnce({ text: 'answer [1]' });
        await askKnowledgeBase(makeRequestContext('READER'), 'q');
        expect(mockRoutedTask).toHaveBeenCalledWith('rag-answer');
    });

    it('grounds the model + returns the answer with sources when retrieve hits', async () => {
        const hits = [chunk({ id: 'x', text: 'split-dose nitrogen' })];
        mockRetrieve.mockResolvedValueOnce(hits);
        mockComplete.mockResolvedValueOnce({ text: 'Apply N in splits [1].' });
        const ctx = makeRequestContext('READER');

        const result = await askKnowledgeBase(ctx, 'fertiliser?');

        expect(result.answer).toBe('Apply N in splits [1].');
        expect(result.sources).toBe(hits);
        // The system prompt the model received carries the grounding sources.
        const messages = mockComplete.mock.calls[0][0].messages;
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('split-dose nitrogen');
        expect(messages[1]).toEqual({ role: 'user', content: 'fertiliser?' });
    });

    it('refuses without permission (assertCanRead)', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        await expect(askKnowledgeBase(ctx, 'q')).rejects.toThrow();
        expect(mockRetrieve).not.toHaveBeenCalled();
    });
});
