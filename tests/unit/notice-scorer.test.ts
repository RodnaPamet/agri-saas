/**
 * P5.5b — the notice scorer (#1596).
 *
 * Three claims worth an executing test, because each fails silently:
 *
 *   - **the platform budget is actually consulted, and refusing is free.** The
 *     call is on an unauthenticated endpoint's data, so an ungated scorer turns
 *     a flood of notices into an unbounded bill. A guard can see the call site;
 *     only this can see that a `false` verdict stops the model call.
 *   - **usage is recorded even when the output is unusable.** The tokens were
 *     spent either way, and a ledger that only counts successful parses
 *     under-counts exactly the calls worth noticing — and the ledger is what an
 *     operator reads to choose a cap.
 *   - **the reporter's identity never reaches the model.** `anonymous` goes in;
 *     an id does not. The triage queue has the same rule for the same reason.
 *
 * The Anthropic SDK is mocked, because what is under test is what reaches it
 * and what is done with what comes back — not the provider.
 */
const create = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: class {
        messages = { create: (...a: unknown[]) => create(...a) };
    },
}));

const isPlatformAiSpendAllowed = jest.fn();
const recordPlatformAiUsage = jest.fn();
jest.mock('@/app-layer/ai/platform-budget', () => ({
    isPlatformAiSpendAllowed: (...a: unknown[]) => isPlatformAiSpendAllowed(...a),
    recordPlatformAiUsage: (...a: unknown[]) => recordPlatformAiUsage(...a),
}));

jest.mock('@/env', () => ({
    env: { ANTHROPIC_API_KEY: 'sk-test-key', ANTHROPIC_BASE_URL: undefined },
}));

import { scoreNotice, NOTICE_SCORE_MODEL } from '@/app-layer/ai/notice-scorer';

/** A well-formed tool_use response. */
function toolResponse(score: unknown, rationale: unknown, usage = { input_tokens: 120, output_tokens: 40 }) {
    return {
        usage,
        content: [{ type: 'tool_use', name: 'notice_score', input: { score, rationale } }],
    };
}

const NOTICE = {
    reasonCode: 'MISLEADING_LISTING',
    subjectKind: 'LISTING' as const,
    detail: 'The grade claimed is not what was delivered.',
    anonymous: false,
};

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS — reset them too, or a
    // rejecting implementation poisons every later test in the file.
    create.mockReset();
    isPlatformAiSpendAllowed.mockReset();
    recordPlatformAiUsage.mockReset();

    isPlatformAiSpendAllowed.mockResolvedValue(true);
    recordPlatformAiUsage.mockResolvedValue(undefined);
    create.mockResolvedValue(toolResponse(12, 'Specific and checkable: names the grade claimed.'));
});

describe('the platform budget gates the call', () => {
    it('consults it before spending anything', async () => {
        await scoreNotice(NOTICE);

        expect(isPlatformAiSpendAllowed).toHaveBeenCalledWith('notice-score');
    });

    it('makes NO model call when the budget refuses', async () => {
        isPlatformAiSpendAllowed.mockResolvedValue(false);

        const result = await scoreNotice(NOTICE);

        // The assertion that matters: not that it returned null, but that no
        // money was spent. A gate that logs and proceeds is the defect.
        expect(create).not.toHaveBeenCalled();
        expect(recordPlatformAiUsage).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    it('scores normally when the budget allows', async () => {
        const result = await scoreNotice(NOTICE);

        expect(create).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            score: 12,
            rationale: 'Specific and checkable: names the grade claimed.',
            model: NOTICE_SCORE_MODEL,
        });
    });
});

describe('usage is recorded for every call that happened', () => {
    it('records the tokens the provider reported', async () => {
        await scoreNotice(NOTICE);

        expect(recordPlatformAiUsage).toHaveBeenCalledWith({
            job: 'notice-score',
            model: NOTICE_SCORE_MODEL,
            promptTokens: 120,
            completionTokens: 40,
        });
    });

    it('records even when the output fails validation', async () => {
        // The tokens were spent. Charging only successful parses would
        // under-count exactly the calls worth noticing.
        create.mockResolvedValue(toolResponse(999, 'out of range'));

        const result = await scoreNotice(NOTICE);

        expect(result).toBeNull();
        expect(recordPlatformAiUsage).toHaveBeenCalledTimes(1);
    });

    it('records even when no tool block comes back', async () => {
        create.mockResolvedValue({
            usage: { input_tokens: 90, output_tokens: 5 },
            content: [{ type: 'text', text: 'I would rather not.' }],
        });

        const result = await scoreNotice(NOTICE);

        expect(result).toBeNull();
        expect(recordPlatformAiUsage).toHaveBeenCalledTimes(1);
    });
});

describe('the reporter is never sent to the model', () => {
    it('passes anonymity as a flag and no identity', async () => {
        await scoreNotice({ ...NOTICE, anonymous: true });

        const sent = JSON.stringify(create.mock.calls[0]![0]);
        expect(sent).toContain('Filed anonymously: yes');
        // The prompt cannot carry an id because the function's input has no
        // field for one — this pins the SHAPE at the boundary, so adding one
        // later has to pass through here.
        expect(sent).not.toMatch(/reporterUserId|usr_|user-/);
    });

    it('asks for no recommendation, only an assessment', async () => {
        await scoreNotice(NOTICE);

        const system = (create.mock.calls[0]![0] as { system: string }).system;
        // A shadow period exists to find out whether the scoring is any good
        // BEFORE anything depends on it. A model asked "should this be
        // removed" produces an artefact somebody will act on.
        expect(system).toMatch(/NOT deciding anything/i);
        expect(system).toMatch(/Do not recommend an action/i);
    });

    it('tells the model to be conservative about rushed or angry notices', async () => {
        await scoreNotice(NOTICE);

        const system = (create.mock.calls[0]![0] as { system: string }).system;
        // The false-positive direction that matters: a farmer reporting a real
        // problem may be terse, upset, or writing in a second language.
        expect(system).toMatch(/conservative/i);
        expect(system).toMatch(/second\s*\n?\s*language|rushed/i);
    });
});

describe('the score is validated before it can be stored', () => {
    it.each([
        ['above the range', 101],
        ['below the range', -1],
        ['not a number', 'high'],
        ['not finite', Number.POSITIVE_INFINITY],
    ])('refuses a score %s', async (_label, score) => {
        create.mockResolvedValue(toolResponse(score, 'a reason'));

        expect(await scoreNotice(NOTICE)).toBeNull();
    });

    it('rounds a fractional score rather than refusing it', async () => {
        create.mockResolvedValue(toolResponse(12.6, 'a reason'));

        expect((await scoreNotice(NOTICE))?.score).toBe(13);
    });

    it('refuses a score with no stated reason', async () => {
        // A score without a rationale is useless for the one thing a shadow
        // period is for: a human judging whether the scoring can be trusted.
        create.mockResolvedValue(toolResponse(50, '   '));

        expect(await scoreNotice(NOTICE)).toBeNull();
    });

    it('accepts the range boundaries', async () => {
        create.mockResolvedValue(toolResponse(0, 'clearly genuine'));
        expect((await scoreNotice(NOTICE))?.score).toBe(0);

        create.mockResolvedValue(toolResponse(100, 'clearly abusive'));
        expect((await scoreNotice(NOTICE))?.score).toBe(100);
    });
});

describe('it never throws', () => {
    it('returns null when the provider errors', async () => {
        create.mockRejectedValue(new Error('upstream 529'));

        await expect(scoreNotice(NOTICE)).resolves.toBeNull();
    });

    it('handles a notice with no detail', async () => {
        // `detail` is nullable: a notifier may write nothing, or only markup
        // that sanitising removed entirely.
        create.mockResolvedValue(toolResponse(40, 'No description given.'));

        const result = await scoreNotice({ ...NOTICE, detail: null });

        expect(result?.score).toBe(40);
        const sent = JSON.stringify(create.mock.calls[0]![0]);
        expect(sent).toContain('filed the notice without a description');
    });
});
