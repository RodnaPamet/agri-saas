/**
 * OpenAI SDK real-API smoke test — the ONLY place the package is executed.
 *
 * ## Why this exists
 *
 * `openai` is imported by exactly one file,
 * `src/app-layer/ai/provider/openai-compatible-provider.ts`. The only two tests
 * that touch it — `tests/unit/ai-provider.test.ts` and `ai-provider-usage.test.ts`
 * — both open with `jest.mock('openai')`. They are good tests of OUR wiring and
 * they never execute one line of the SDK.
 *
 * That cost showed up on the 6 → 7 major (PR #751). Every check passed and the
 * pass meant nothing: a changed request shape, a rewritten SSE decoder or a
 * different error class would all have sailed through green. The bump was
 * verified by hand — read the changelog, confirm the one breaking change was a
 * Node 22 floor, typecheck the provider. This file is that check, made
 * repeatable. See #752, and `bullmq-real-api.test.ts` for the same argument
 * about a different dependency.
 *
 * ## Why there is no skip here
 *
 * `bullmq-real-api.test.ts` needs a real Redis, so it carries a probe, an
 * escalation flag and a visible-skip banner — a whole apparatus for the fact
 * that "a skipped suite is indistinguishable from a passing one".
 *
 * None of that is needed. The provider is an OpenAI-COMPATIBLE client whose
 * `baseURL` is configuration — that is what lets it talk to ollama, openrouter,
 * groq and together — so a local HTTP stub is a first-class backend, not a
 * simulation. No network, no API key, no service container, and therefore
 * nothing that can silently not run.
 *
 * ## Scope
 *
 * Narrow, deliberately: the four call sites the provider actually makes, in the
 * SHAPES it makes them. This is not a test of OpenAI's semantics — upstream
 * owns those — it is a tripwire for the contract we depend on. Add a call site
 * to the provider, add it here.
 *
 * What it covers is precisely what `jest.mock('openai')` replaces: request
 * building, auth headers, JSON and SSE response parsing, auto-pagination, and
 * error mapping.
 *
 * NO MOCKS. A `jest.mock('openai')` in this file would defeat its entire
 * purpose; the guard below asserts the real module is loaded.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';

interface Recorded {
    method: string;
    url: string;
    auth: string | undefined;
    contentType: string | undefined;
    body: Record<string, unknown> | null;
}

let server: http.Server;
let baseURL: string;
let recorded: Recorded[] = [];
/** Set per-test to control what the stub returns. */
let respond: (req: Recorded, res: http.ServerResponse) => void;

function json(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
}

/** Emit an OpenAI-style SSE stream, the wire format the SDK must decode. */
function sse(res: http.ServerResponse, chunks: unknown[]): void {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const raw: Buffer[] = [];
        req.on('data', (d: Buffer) => raw.push(d));
        req.on('end', () => {
            const text = Buffer.concat(raw).toString('utf8');
            const rec: Recorded = {
                method: req.method ?? '',
                url: req.url ?? '',
                auth: req.headers.authorization,
                contentType: req.headers['content-type'],
                body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
            };
            recorded.push(rec);
            respond(rec, res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    recorded = [];
    respond = (_req, res) => json(res, 200, {});
});

/** A client built exactly the way the provider builds one. */
const client = () => new OpenAI({ baseURL, apiKey: 'test-key', maxRetries: 0 });

describe('the real SDK is what is loaded', () => {
    it('is not a mock', () => {
        // The anti-neuter guard. Everything below is worthless if a
        // `jest.mock('openai')` is ever added to this file or a setup shared
        // with it — and that failure is silent.
        expect(jest.isMockFunction(OpenAI)).toBe(false);
        expect(typeof new OpenAI({ baseURL, apiKey: 'k' }).chat.completions.create).toBe('function');
    });
});

describe('chat.completions.create — non-streaming', () => {
    it('builds the request the provider intends, and parses the reply', async () => {
        respond = (_req, res) =>
            json(res, 200, {
                id: 'c1',
                choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
            });

        const completion = await client().chat.completions.create({
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        });

        // The request the SDK actually put on the wire.
        const req = recorded[0];
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/v1/chat/completions');
        expect(req.auth).toBe('Bearer test-key');
        expect(req.contentType).toContain('application/json');
        expect(req.body).toMatchObject({ model: 'gpt-test', stream: false });

        // …and the response it handed back.
        expect(completion.choices[0]?.message?.content).toBe('hello there');
        expect(completion.usage?.prompt_tokens).toBe(11);
    });

    it('surfaces tool calls with the discriminant the provider filters on', async () => {
        // `openai-compatible-provider.ts` narrows with `tc.type === 'function'`.
        // If the SDK ever stopped carrying `type`, that filter would silently
        // drop every tool call and the agent would look mute rather than broken.
        respond = (_req, res) =>
            json(res, 200, {
                id: 'c2',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
            });

        const completion = await client().chat.completions.create({
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        });
        const calls = completion.choices[0]?.message?.tool_calls ?? [];
        expect(calls).toHaveLength(1);
        expect(calls[0]?.type).toBe('function');
    });
});

describe('chat.completions.create — streaming', () => {
    it('decodes SSE into chunks, including the usage-only final chunk', async () => {
        // The provider asks for `stream_options.include_usage` and accumulates
        // deltas. SSE framing and the [DONE] sentinel are entirely the SDK's —
        // a mock returns a plain array and proves none of it.
        respond = (_req, res) =>
            sse(res, [
                { id: 's1', choices: [{ index: 0, delta: { role: 'assistant', content: 'par' } }] },
                { id: 's1', choices: [{ index: 0, delta: { content: 'tial' } }] },
                { id: 's1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
                { id: 's1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
            ]);

        const stream = await client().chat.completions.create({
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            stream_options: { include_usage: true },
        });

        let text = '';
        let promptTokens: number | undefined;
        for await (const chunk of stream) {
            text += chunk.choices[0]?.delta?.content ?? '';
            if (chunk.usage) promptTokens = chunk.usage.prompt_tokens;
        }

        expect(text).toBe('partial');
        expect(promptTokens).toBe(5);
        expect(recorded[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    });
});

describe('embeddings.create', () => {
    it('SILENTLY asks for base64 — the caller never said so', async () => {
        // Found by this test on its first run, and the reason it earns its
        // keep. The SDK injects `encoding_format: "base64"` when the caller
        // omits it, then base64-decodes the reply. The provider omits it.
        respond = (_req, res) =>
            json(res, 200, {
                object: 'list',
                model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: 'AAAAPwAAAD8=' }],
            });

        await client().embeddings.create({ model: 'embed-test', input: ['alpha'] });
        expect(recorded[0]?.body).toMatchObject({ encoding_format: 'base64' });
    });

    it('a backend answering with PLAIN FLOATS decodes to an EMPTY vector, with no error', async () => {
        // The hazard, stated as an assertion rather than a warning. Many
        // OpenAI-compatible backends answer `encoding_format` requests with a
        // plain float array. The SDK tries to base64-decode that string-less
        // value and yields []. Nothing throws.
        //
        // The provider's only guard counts vectors, and the COUNT is right —
        // one empty vector per input. `datum.embedding as number[]` is a cast,
        // so the types do not object either. See #754.
        respond = (_req, res) =>
            json(res, 200, {
                object: 'list',
                model: 'embed-test',
                data: [
                    { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
                    { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
                ],
            });

        const response = await client().embeddings.create({
            model: 'embed-test',
            input: ['alpha', 'beta'],
        });

        expect(recorded[0]?.url).toBe('/v1/embeddings');
        expect(response.data).toHaveLength(2);
        // Right count, right indices, no vectors.
        expect([...response.data].sort((a, b) => a.index - b.index).map((d) => d.index)).toEqual([0, 1]);
        expect(response.data[0]?.embedding).toEqual([]);
    });

    it('asking for floats EXPLICITLY round-trips them intact', async () => {
        // The fix side: naming the format makes the wire contract unambiguous
        // and matches what the provider casts to.
        respond = (_req, res) =>
            json(res, 200, {
                object: 'list',
                model: 'embed-test',
                data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
            });

        const response = await client().embeddings.create({
            model: 'embed-test',
            input: ['alpha'],
            encoding_format: 'float',
        });

        expect(recorded[0]?.body).toMatchObject({ encoding_format: 'float' });
        expect(response.data[0]?.embedding).toEqual([0.1, 0.2]);
    });
});

describe('models.list', () => {
    it('returns something async-iterable — the provider uses `for await`', async () => {
        // This is auto-pagination, a real SDK behaviour. `models.list()` does
        // not resolve to a plain array, and a mock that returns one would hide
        // a change here completely.
        respond = (_req, res) =>
            json(res, 200, {
                object: 'list',
                data: [{ id: 'model-a', object: 'model' }, { id: 'model-b', object: 'model' }],
            });

        const list = await client().models.list();
        const ids: string[] = [];
        for await (const m of list) if (typeof m.id === 'string') ids.push(m.id);

        expect(recorded[0]?.method).toBe('GET');
        expect(recorded[0]?.url).toBe('/v1/models');
        expect(ids).toEqual(['model-a', 'model-b']);
    });
});

describe('error mapping', () => {
    it('raises a typed APIError carrying the status', async () => {
        // The provider surfaces failures from arbitrary backends. How the SDK
        // classifies a non-2xx is version behaviour, not ours.
        respond = (_req, res) => json(res, 429, { error: { message: 'slow down', type: 'rate_limit' } });

        await expect(
            client().chat.completions.create({
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'hi' }],
                stream: false,
            }),
        ).rejects.toMatchObject({ status: 429 });
    });

    it('a 500 is an error, not a silently empty completion', async () => {
        respond = (_req, res) => json(res, 500, { error: { message: 'boom' } });
        await expect(
            client().chat.completions.create({
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'hi' }],
                stream: false,
            }),
        ).rejects.toMatchObject({ status: 500 });
    });
});
