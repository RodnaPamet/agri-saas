/**
 * The МЗХ document analysis (owner, 2026-11-26): the model's answer is
 * validated before it reaches an email, and the platform budget gates the call.
 */
const create = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => create(...a) } })));
const allowed = jest.fn();
const record = jest.fn();
jest.mock('@/app-layer/ai/platform-budget', () => ({
    isPlatformAiSpendAllowed: (...a: unknown[]) => allowed(...a),
    recordPlatformAiUsage: (...a: unknown[]) => record(...a),
}));
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return { ...actual, env: new Proxy(actual.env, { get: (t, p, r) => (p === 'ANTHROPIC_API_KEY' ? 'sk-test' : Reflect.get(t, p, r)) }) };
});
jest.mock('@/lib/observability/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { analyseMzhDocument, MAX_DOCUMENT_CHARS, parseAnalysis } from '@/app-layer/ai/mzh-document-analyst';

const DOC = { series: 'technology-card', title: 'ТК домати', url: 'https://www.mzh.government.bg/x.pdf', text: 'а'.repeat(100_000) };
const toolAnswer = (input: unknown) => ({
    usage: { input_tokens: 1000, output_tokens: 200 },
    content: [{ type: 'tool_use', name: 'mzh_document_analysis', input }],
});

beforeEach(() => {
    jest.clearAllMocks();
    allowed.mockResolvedValue(true);
});

it('returns the summary and suggestions, charges the budget, and sends at most the cap of text', async () => {
    create.mockResolvedValue(toolAnswer({ summary: 'Карта.', whatsNew: 'Ново.', suggestions: [{ area: 'calendar', title: 'Т', detail: 'Д' }] }));
    const r = await analyseMzhDocument(DOC);
    expect(r).toMatchObject({ summary: 'Карта.', suggestions: [{ area: 'calendar', title: 'Т', detail: 'Д' }] });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ job: 'mzh-document-analysis', promptTokens: 1000 }));
    const sent = create.mock.calls[0][0].messages[0].content as string;
    expect(sent.length).toBeLessThan(MAX_DOCUMENT_CHARS + 500);
});

it('is skipped, without a call, when the platform budget is spent', async () => {
    allowed.mockResolvedValue(false);
    expect(await analyseMzhDocument(DOC)).toBeNull();
    expect(create).not.toHaveBeenCalled();
});

it('a failed call or an unusable answer is null, never thrown', async () => {
    create.mockRejectedValue(new Error('overloaded'));
    expect(await analyseMzhDocument(DOC)).toBeNull();
    create.mockResolvedValue(toolAnswer({ whatsNew: 'no summary' }));
    expect(await analyseMzhDocument(DOC)).toBeNull();
    // Charged even when the answer did not parse.
    expect(record).toHaveBeenCalledTimes(1);
});

it('validation: an unknown area becomes «other», an incomplete suggestion is dropped, at most four', () => {
    const r = parseAnalysis({
        summary: ' Документ. ',
        whatsNew: '',
        suggestions: [
            { area: 'nonsense', title: 'А', detail: 'Б' },
            { area: 'prices', title: '', detail: 'без заглавие' },
            ...Array.from({ length: 5 }, (_, i) => ({ area: 'support', title: `T${i}`, detail: 'D' })),
        ],
    });
    expect(r?.summary).toBe('Документ.');
    expect(r?.suggestions[0]).toEqual({ area: 'other', title: 'А', detail: 'Б' });
    expect(r?.suggestions).toHaveLength(3);
    expect(parseAnalysis({ suggestions: [] })).toBeNull();
});
