/**
 * `POST /api/social/conversations/{id}/messages` — the route forwards every
 * OPTIONAL field it parses.
 *
 * This suite exists because `linkUrl` was parsed and dropped. P8.6's link
 * cards (#2800) were therefore unreachable over HTTP from the day they
 * shipped: `sendDirectMessage` accepted the field, `SendDirectMessageSchema`
 * documented it, the OpenAPI description explained the per-hop host policy and
 * the best-effort fetch — and no client could trigger any of it. Nothing was
 * red, and nothing could have been.
 *
 * `tests/integration/p8-6-dm-link-cards.test.ts` drives the usecase DIRECTLY,
 * which is the right split for what it tests (storage, sanitising, ciphertext,
 * retraction). The consequence is that the HTTP seam had no test at all, and
 * it is the seam where a forwarding mistake lives. Same shape as the eight
 * Edge-severed mechanisms this repo has recorded: a complete, unit-tested
 * feature cut at a boundary nobody was asserting across.
 *
 * So these cases are deliberately about PLUMBING rather than behaviour, and
 * they assert on the ARGUMENT the usecase received. A status check cannot see
 * this defect: the route answered 201 and sent the message, just without the
 * card.
 */
const mockGetUserCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => mockGetUserCtx(...a),
}));

const mockAssertFeature = jest.fn();
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: (...a: unknown[]) => mockAssertFeature(...a),
}));

const mockSend = jest.fn();
jest.mock('@/app-layer/usecases/direct-messages', () => ({
    sendDirectMessage: (...a: unknown[]) => mockSend(...a),
}));

import { NextRequest } from 'next/server';

import { POST } from '@/app/api/social/conversations/[conversationId]/messages/route';

const CONVERSATION_ID = 'conv-1';
const ROUTE_CTX = { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };

function post(body: unknown): NextRequest {
    return new NextRequest(
        `http://t/api/social/conversations/${CONVERSATION_ID}/messages`,
        { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    );
}

/** The input object the route handed `sendDirectMessage`. */
function passedInput(): Record<string, unknown> {
    return mockSend.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserCtx.mockResolvedValue({ userId: 'u1' });
    mockAssertFeature.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({ messageId: 'm1', createdAt: new Date(0), deduplicated: false });
});

describe('the optional fields reach the usecase', () => {
    it('forwards linkUrl — the field that was parsed and dropped (#2800)', async () => {
        const res = await post({ body: 'вижте това', linkUrl: 'https://agri.example.test/wheat' });
        const response = await POST(res, ROUTE_CTX);

        expect(response.status).toBe(201);
        // The assertion that matters is the ARGUMENT, not the status: the
        // route answered 201 and sent the message throughout the defect — it
        // simply sent it with no card, which no status or body can show.
        expect(passedInput()).toMatchObject({
            conversationId: CONVERSATION_ID,
            body: 'вижте това',
            linkUrl: 'https://agri.example.test/wheat',
        });
    });

    it('forwards idempotencyKey, and the two travel together', async () => {
        // Together in ONE call because the defect was per-field: the key was
        // forwarded and the URL was not, so a case sending only the key passed
        // throughout. A reader has to be able to see that both arrive.
        await POST(
            post({ body: 'hi', idempotencyKey: 'k-1', linkUrl: 'https://agri.example.test/a' }),
            ROUTE_CTX,
        );
        expect(passedInput()).toMatchObject({
            idempotencyKey: 'k-1',
            linkUrl: 'https://agri.example.test/a',
        });
    });

    it('omits an absent optional field rather than passing undefined', async () => {
        // `exactOptionalPropertyTypes` is on, and the usecase's own default is
        // what every existing caller already gets. `linkUrl: undefined` would
        // also make `input.linkUrl ? … : null` behave identically, so this is
        // about the CONTRACT rather than the behaviour — and it is the reason
        // the route spreads per field instead of passing `parsed.data`.
        await POST(post({ body: 'plain' }), ROUTE_CTX);
        const input = passedInput();
        expect(input).not.toHaveProperty('linkUrl');
        expect(input).not.toHaveProperty('idempotencyKey');
    });

    it('does NOT forward an unknown key the schema stripped', async () => {
        // The control in the other direction. `.strip()` drops extras SILENTLY
        // — deliberately, so a caller cannot learn which fields exist from an
        // error — which means a route passing `parsed.data` wholesale would be
        // safe today and would forward whatever a future `.passthrough()`
        // admitted. The per-field spread is what makes that impossible.
        await POST(post({ body: 'plain', senderUserId: 'someone-else', state: 'ACCEPTED' }), ROUTE_CTX);
        const input = passedInput();
        expect(input).not.toHaveProperty('senderUserId');
        expect(input).not.toHaveProperty('state');
        expect(input).toEqual({ conversationId: CONVERSATION_ID, body: 'plain' });
    });
});

describe('a refusal still refuses', () => {
    it('does not call the usecase on an invalid body', async () => {
        // The positive control for the suite: a route that called the usecase
        // unconditionally would satisfy every case above.
        const response = await POST(post({ body: '' }), ROUTE_CTX);
        expect(response.status).toBe(400);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not call the usecase on a non-https linkUrl', async () => {
        // `httpsUrl()` rather than a bare `z.string().url()`, which under the
        // installed zod admits `http:`, `ftp:`, `file:`, `data:` and
        // `javascript:` — all measured. Now that the field is FORWARDED, that
        // narrowing is the first thing standing in front of `fetchPublicUrl`,
        // so it is asserted here rather than only in the schema suite.
        const response = await POST(
            post({ body: 'hi', linkUrl: 'http://agri.example.test/a' }),
            ROUTE_CTX,
        );
        expect(response.status).toBe(400);
        expect(mockSend).not.toHaveBeenCalled();
    });
});
