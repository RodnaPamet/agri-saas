/**
 * The assistant stream route — #2578.
 *
 * The assertion that matters most is the EGRESS one: a secret-shaped answer
 * must never reach the stream, and the test proves that by searching every
 * byte the route emitted for the fixture key. That is also what gives
 * `scanEgress` a caller — it shipped in #2584 with none, which #2578 records.
 */
import { NextRequest } from 'next/server';

// Both declare a rest parameter, because the factories below SPREAD into
// them. `jest.fn(async () => undefined)` takes no arguments, so the spread is
// a type error — TS2556, which jest never sees because ts-jest transpiles
// without typechecking. The real `npm run typecheck` is what found it.
const completeWithRouting = jest.fn<Promise<{ text: string }>, unknown[]>();
const assertFeatureEnabled = jest.fn<Promise<undefined>, unknown[]>(async () => undefined);

jest.mock('@/app-layer/ai/routing', () => ({
    completeWithRouting: (...a: unknown[]) => completeWithRouting(...a),
}));
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: (...a: unknown[]) => assertFeatureEnabled(...a),
}));
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn(async () => ({
        userId: 'u1',
        tenantId: 't1',
        role: 'EDITOR',
        permissions: {},
        appPermissions: {},
    })),
}));
// ── The conversation window (#2671a) ───────────────────────────────
//
// MOCKED, and it has to be: the route now resolves a conversation and records
// each turn, and both go through `runInTenantContext` to a real database. From
// a unit suite that reaches real Prisma, every test in this file failed —
// which is the trap `treatment-farm-record-route.test.ts` already records
// ("the handler reached real Prisma from a unit test and answered 500 where
// the suite expected 404").
//
// The doubles are deliberately boring: a fixed id, an EMPTY window, and a
// `recordTurn` that does nothing. This file is about the STREAM's event shape,
// and `tests/integration/assistant-conversation-window.test.ts` is where the
// window's content, its bounds and its fencing are proved against real rows.
// An empty window keeps the prompt here identical to what it was before the
// window existed, so these assertions still grade what they were written for.
//
// `recordTurn` is asserted on in one test below rather than left as scenery:
// a double nobody checks cannot tell "the route stopped recording turns" from
// "the mock worked".
const resolveConversation = jest.fn<Promise<string>, unknown[]>(async () => 'conv-1');
/*
 * The profile block (#2671). Mocked wholesale: this suite tests the ROUTE, and
 * how a profile is built is `memory-profile`'s own suite.
 *
 * Not mocking it broke every test in this file, and the failure named nothing:
 * the route HALTED instead of answering, because the `@/lib/feature-flags`
 * mock above exports only `assertFeatureEnabled`, so `isFeatureEnabled` was
 * `undefined` and calling it threw inside the stream. A new import in a route
 * whose suite mocks its dependencies is a broken suite until the double
 * arrives — the shape agrent backend-1 hit with the conversation module.
 */
const buildProfileBlock = jest.fn<Promise<string | null>, unknown[]>(async () => null);
jest.mock('@/app-layer/ai/memory-profile', () => ({
    buildProfileBlock: (...a: unknown[]) => buildProfileBlock(...a),
    // A STUB, so the assertion below is about the route including the rule
    // rather than about the rule's wording, which `memory-profile`'s suite owns.
    PROFILE_PROMPT_RULE: 'PROFILE_RULE_STUB',
}));

const loadWindow = jest.fn<Promise<unknown[]>, unknown[]>(async () => []);
const renderWindow = jest.fn<string, unknown[]>(() => '');
const recordTurn = jest.fn<Promise<void>, unknown[]>(async () => undefined);

jest.mock('@/app-layer/usecases/assistant-conversation', () => ({
    resolveConversation: (...a: unknown[]) => resolveConversation(...a),
    loadWindow: (...a: unknown[]) => loadWindow(...a),
    renderWindow: (...a: unknown[]) => renderWindow(...a),
    recordTurn: (...a: unknown[]) => recordTurn(...a),
}));

// The constant below is AWS's own published example key — a valid SHAPE that
// is not a credential.
//
// This comment does NOT spell it, and the first version of this comment did
// while claiming not to. `detect-secrets.sh` reads BYTES and its allowlist
// marker is per LINE, so the explanation refused the commit even though the
// value one line down was properly marked. Second time in this issue; the
// rule is that prose describes the value and never repeats it.
const AWS_EXAMPLE = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret -- AWS's published example

const ask = (body: unknown): [NextRequest, { params: Promise<{ tenantSlug: string }> }] => [
    {
        json: async () => body,
        signal: { addEventListener: () => {} },
        nextUrl: { pathname: '/api/t/acme/assistant/stream', searchParams: new URLSearchParams() },
        method: 'POST',
        headers: new Headers(),
        url: 'http://test/api/t/acme/assistant/stream',
    } as unknown as NextRequest,
    { params: Promise.resolve({ tenantSlug: 'acme' }) },
];

/** Drain the SSE body into the list of events it carried. */
async function drain(res: Response): Promise<{ raw: string; events: Record<string, unknown>[] }> {
    const raw = await res.text();
    const events = raw
        .split('\n\n')
        .map((b) => b.replace(/^data: /, '').trim())
        .filter((b) => b !== '' && !b.startsWith(':'))
        .map((b) => JSON.parse(b) as Record<string, unknown>);
    return { raw, events };
}

/**
 * The PAYLOAD event — the one immediately after `thinking`.
 *
 * This was `payload(events)` at ten call sites until #2671a emitted a
 * `conversation` event FIRST, which shifted every index by one. Derived from
 * the position of `thinking` rather than bumped to `events[2]`, because the
 * next event added to the front would silently re-point all ten at the wrong
 * row — and an assertion reading the wrong event is the kind that keeps
 * passing for a while, which is worse than one that breaks.
 */
function payload(events: Record<string, unknown>[]): Record<string, unknown> {
    const at = events.findIndex((e) => e.type === 'thinking');
    expect(at).toBeGreaterThanOrEqual(0);
    return events[at + 1];
}

describe('POST /api/t/{slug}/assistant/stream (#2578)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        assertFeatureEnabled.mockResolvedValue(undefined);
    });

    it('streams thinking → answer → done for a clean answer', async () => {
        completeWithRouting.mockResolvedValue({ text: 'Поливайте рано сутрин.' });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'Кога да поливам?' }));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const { events } = await drain(res);
        expect(events.map((e) => e.type)).toEqual(['conversation', 'thinking', 'answer', 'done']);
        expect(payload(events).text).toBe('Поливайте рано сутрин.');
    });

    it('emits the conversation id FIRST, and records both halves of the turn', async () => {
        // The mocks above are only worth having if something reads them:
        // without this, "the route stopped resolving a conversation" and "the
        // double returned a value nobody looked at" are the same green.
        completeWithRouting.mockResolvedValue({ text: 'Поливайте рано сутрин.' });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'кога да поливам' }));
        const { events } = await drain(res);

        // FIRST, before `thinking` and before any provider call — a client
        // that loses the stream mid-answer still holds the id.
        expect(events[0]).toMatchObject({ type: 'conversation', conversationId: 'conv-1' });

        // Both halves recorded, in order, and the ANSWER only because it was
        // sent. The question is recorded before the model is called, so a
        // provider failure still leaves the question in the history.
        expect(recordTurn.mock.calls.map((c) => [c[2], c[3]])).toEqual([
            ['user', 'кога да поливам'],
            ['assistant', 'Поливайте рано сутрин.'],
        ]);
    });

    it('NEVER lets a secret-shaped answer reach the stream', async () => {
        completeWithRouting.mockResolvedValue({ text: `Ключът е ${AWS_EXAMPLE} — ползвайте го.` });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'какъв е ключът' }));
        const { raw, events } = await drain(res);

        // The decisive assertions: no `answer` event at all, and the key — or
        // any recognisable prefix of it — nowhere in the bytes sent.
        expect(events.map((e) => e.type)).toEqual(['conversation', 'thinking', 'refusal', 'done']);
        expect(payload(events).code).toBe('ASSISTANT_EGRESS_BLOCKED');
        expect(raw).not.toContain(AWS_EXAMPLE);
        expect(raw).not.toContain(AWS_EXAMPLE.slice(0, 8));
        // The refusal still reads as a sentence, in Bulgarian.
        expect(payload(events).message).toMatch(/[Ѐ-ӿ]/);
    });

    it('a provider failure ends as a HALT, not a 500 and not an error event', async () => {
        completeWithRouting.mockRejectedValue(new Error('upstream unreachable'));
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'нещо' }));
        expect(res.status).toBe(200);
        const { events } = await drain(res);
        expect(events.map((e) => e.type)).toEqual(['conversation', 'thinking', 'halt', 'done']);
        // `done` carries BOTH turn-level incompleteness flags — #2639. The
        // tool loop's rule is that such a fact must not be lost to halt
        // precedence, and the route is where it reaches the client.
        const done = events[events.length - 1] as Record<string, unknown>;
        expect(done).toMatchObject({ type: 'done' });
        expect(Object.keys(done).sort()).toEqual(['partialAny', 'truncatedAny', 'type']);
        expect(payload(events).code).toBe('ASSISTANT_PROVIDER_UNAVAILABLE');
        // `error` is not a member of the union; nothing may emit one.
        expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('a budget refusal mid-call ends as the SPEND_CEILING halt', async () => {
        completeWithRouting.mockRejectedValue(new Error('ai_budget_exceeded: monthly cap'));
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'нещо' }));
        const { events } = await drain(res);
        expect(payload(events).code).toBe('ASSISTANT_SPEND_CEILING');
        expect(payload(events).type).toBe('halt');
    });

    /**
     * #2655 — "the model was unreachable" was asserted for every non-budget
     * failure, and during the #2654 outage both halves of that sentence were
     * false: the model had answered with a 400, and the tools had already run.
     */
    describe('refused vs unreachable (#2655)', () => {
        /** An SDK-shaped failure: a plain Error carrying a numeric status. */
        const sdkError = (status: number | undefined): Error => {
            const e = new Error('invalid_request_error: messages.1 ...');
            if (status !== undefined) (e as { status?: number }).status = status;
            return e;
        };

        const endingFor = async (err: unknown): Promise<string> => {
            completeWithRouting.mockRejectedValue(err);
            const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
            const res = await POST(...ask({ question: 'нещо' }));
            const { events } = await drain(res);
            return String(payload(events).code);
        };

        it.each([
            [400, 'ASSISTANT_REQUEST_REJECTED', 'a malformed request — the #2654 shape'],
            [401, 'ASSISTANT_REQUEST_REJECTED', 'a bad key is still a refusal, not silence'],
            [404, 'ASSISTANT_REQUEST_REJECTED', 'an unknown model id'],
            [422, 'ASSISTANT_REQUEST_REJECTED', 'an unprocessable request'],
            [429, 'ASSISTANT_PROVIDER_UNAVAILABLE', 'rate limited — retry is the advice'],
            [500, 'ASSISTANT_PROVIDER_UNAVAILABLE', 'the provider failed, not refused'],
            [529, 'ASSISTANT_PROVIDER_UNAVAILABLE', "Anthropic's overloaded"],
            [undefined, 'ASSISTANT_PROVIDER_UNAVAILABLE', 'a connection failure carries no status'],
            // All THREE tuple members must be declared even though the
            // third only feeds the test NAME: `it.each`'s callback type is
            // derived from the row arity, so a 2-param callback against a
            // 3-element row is TS2345. ts-jest transpiles without
            // typechecking, so the suite ran green locally and only
            // `npm run typecheck` saw it.
        ])('status %s -> %s (%s)', async (status, expected, _why) => {
            expect(await endingFor(sdkError(status as number | undefined))).toBe(expected);
        });

        it('OUR OWN coded 4xx is never reported as the model refusing', async () => {
            // The one that makes the exclusion in `isProviderRejection`
            // load-bearing rather than decorative. `AppError` declares
            // `status`, so every coded failure in this codebase carries a 4xx
            // — a bare range check would tell a farmer the model rejected
            // their question when their ROLE had refused it, which is the same
            // defect #2655 is about, pointed somewhere new.
            const { AppError } = await import('@/lib/errors/types');
            const ours = new AppError('role may not read that', 'FORBIDDEN', 403);
            expect(await endingFor(ours)).not.toBe('ASSISTANT_REQUEST_REJECTED');
        });

        it('the budget refusal still wins, though it also carries a 4xx', async () => {
            // Ordering, not coincidence: `assertAiBudget` throws a coded
            // forbidden, so it is an `AppError` with status 403. The budget
            // test runs FIRST, and this asserts the order rather than trusting
            // the comment that explains it.
            const { AppError } = await import('@/lib/errors/types');
            const budget = new AppError('ai_budget_exceeded: monthly cap', 'AI_BUDGET_EXCEEDED', 403);
            expect(await endingFor(budget)).toBe('ASSISTANT_SPEND_CEILING');
        });

        it('the two codes carry OPPOSITE claims about the records', async () => {
            // The reason there are two codes at all. If both sentences said
            // the records went unread, the split would be invisible to the
            // person it exists for.
            const { ENDING_FALLBACK_EN } = await import('@/app-layer/ai/safety/refusal-codes');
            expect(ENDING_FALLBACK_EN.ASSISTANT_PROVIDER_UNAVAILABLE).toMatch(/were not read/);
            expect(ENDING_FALLBACK_EN.ASSISTANT_REQUEST_REJECTED).not.toMatch(/were not read/);
            // And neither may claim to have created anything.
            expect(ENDING_FALLBACK_EN.ASSISTANT_REQUEST_REJECTED).toMatch(/[Nn]othing was created/);
        });
    });

    it('an empty answer is a refusal, not an empty answer event', async () => {
        completeWithRouting.mockResolvedValue({ text: '   ' });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'нещо' }));
        const { events } = await drain(res);
        expect(payload(events).code).toBe('ASSISTANT_NO_GROUNDING');
    });

    // These three assert on the RESPONSE, not on a rejection.
    // `withApiErrorHandling` CATCHES and renders the `ErrorResponse` envelope,
    // so `rejects` never fires — my first version of these used it and they
    // failed as "resolved instead of rejected", which is the wrapper working
    // rather than the route misbehaving. Reading the envelope is also closer
    // to what a client sees.
    const errorBody = async (res: Response): Promise<{ code?: string; message?: string }> => {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        return body.error ?? {};
    };

    it('refuses an unknown page-context route, with the CONTEXT code', async () => {
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(
            ...ask({ question: 'нещо', pageContext: { route: '/t/acme/journal' } }),
        );
        expect(res.status).toBe(400);
        expect((await errorBody(res)).code).toBe('ASSISTANT_CONTEXT_INVALID');
        expect(completeWithRouting).not.toHaveBeenCalled();
    });

    it('refuses a malformed question with the QUESTION code, not the context one', async () => {
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: '' }));
        expect(res.status).toBe(400);
        // The discriminator: the two codes must not collapse, because the
        // remedies differ — shorten the question versus a client fault the
        // person cannot fix by rewording.
        expect((await errorBody(res)).code).toBe('ASSISTANT_QUESTION_INVALID');
    });

    it('is 404 when the flag is off — an unlaunched surface does not announce itself', async () => {
        const { notFound } = await import('@/lib/errors/types');
        assertFeatureEnabled.mockRejectedValue(notFound('Not found'));
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        const res = await POST(...ask({ question: 'нещо' }));
        expect(res.status).toBe(404);
        // And nothing was spent finding out — the flag gate runs before the
        // body is read and long before any model call.
        expect(completeWithRouting).not.toHaveBeenCalled();
    });

    it('the profile RULE is always in the system block, and the block only when there is one', async () => {
        completeWithRouting.mockResolvedValue({ text: 'ок' });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');

        // No profile: the rule still ships, because it is part of the CACHED
        // prefix and must stay byte-identical for everyone.
        buildProfileBlock.mockResolvedValueOnce(null);
        await POST(...ask({ question: 'какво' }));
        let [, , opts] = completeWithRouting.mock.calls[0] as [unknown, unknown, { messages: { role: string; content: string }[] }];
        let system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(system).toContain('PROFILE_RULE_STUB');
        expect(system).not.toContain('REMEMBERED_PROFILE_START');

        // With one: it is appended to the SAME system message, not sent as a
        // separate turn — that placement is what keeps it inside the cached
        // block rather than paying full rate every message.
        completeWithRouting.mockClear();
        buildProfileBlock.mockResolvedValueOnce('REMEMBERED_PROFILE_START\n- Отглежда слънчоглед\nREMEMBERED_PROFILE_END');
        await POST(...ask({ question: 'какво' }));
        [, , opts] = completeWithRouting.mock.calls[0] as [unknown, unknown, { messages: { role: string; content: string }[] }];
        system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(system).toContain('- Отглежда слънчоглед');
        const nonSystem = opts.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
        expect(nonSystem).not.toContain('REMEMBERED_PROFILE_START');
    });

    it('the model is told the screen block is DATA, and the question is sanitised', async () => {
        completeWithRouting.mockResolvedValue({ text: 'ок' });
        const { POST } = await import('@/app/api/t/[tenantSlug]/assistant/stream/route');
        await POST(
            ...ask({
                question: 'какво е това',
                pageContext: { route: '/t/[tenantSlug]/journal', filters: { status: 'DRAFT' } },
            }),
        );
        const [, , opts] = completeWithRouting.mock.calls[0] as [unknown, unknown, { messages: { role: string; content: string }[] }];
        const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(system).toMatch(/never an\s+instruction/i);
        const screen = opts.messages.map((m) => m.content).join('\n');
        expect(screen).toContain('SCREEN_CONTEXT');
        expect(screen).toContain('route: /t/[tenantSlug]/journal');
        expect(screen).toContain('filter.status: DRAFT');
    });
});
