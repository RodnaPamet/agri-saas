/**
 * The leaflet reader (#2664) — the gate and the ledger, executed.
 *
 * Three claims, each of which fails silently:
 *
 *   - **the platform budget is consulted, and refusing is free.** A guard can
 *     see the call site; only this sees that a `false` verdict stops the model
 *     call before a whole PDF is uploaded to it.
 *   - **usage is recorded when the output is UNUSABLE and not when the call
 *     was refused.** The tokens were spent in the first case and not in the
 *     second, and a ledger that counts only successful parses under-counts
 *     exactly the uploads a person retries.
 *   - **a PDF rides a `document` block and a photo an `image` block.** Sending
 *     a PDF as an image is a 400 from the provider that reads, from the
 *     operator's side, exactly like an unreadable leaflet.
 *
 * The SDK is mocked: what is under test is what reaches it and what is done
 * with what comes back. `notice-scorer.test.ts` is the shape.
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

import { readPromotionLeaflet } from '@/app-layer/ai/promotion-leaflet-reader';

const OFFERS = [
    { productName: 'Амониев нитрат', priceText: 'от 1 200 лв./т', validityText: null, note: null },
];

function toolResponse(input: unknown, usage = { input_tokens: 900, output_tokens: 70 }) {
    return { usage, content: [{ type: 'tool_use', name: 'report_leaflet_offers', input }] };
}

const pdf = { bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]), mimeType: 'application/pdf' };
const jpeg = { bytes: Buffer.from([0xff, 0xd8]), mimeType: 'image/jpeg' };

beforeEach(() => {
    jest.clearAllMocks();
    isPlatformAiSpendAllowed.mockResolvedValue(true);
    recordPlatformAiUsage.mockResolvedValue(undefined);
});

describe('readPromotionLeaflet (#2664)', () => {
    it('reads a leaflet and reports its offers', async () => {
        create.mockResolvedValue(
            toolResponse({
                isLeaflet: true,
                companyName: 'Агро Търговия ООД',
                offers: OFFERS,
                unreadableOfferCount: 2,
            }),
        );

        const out = await readPromotionLeaflet(pdf);

        expect(out.refused).toBe(false);
        expect(out.read?.offers).toEqual(OFFERS);
        expect(out.read?.unreadableOfferCount).toBe(2);
        expect(out.usage).toMatchObject({ promptTokens: 900, completionTokens: 70, totalTokens: 970 });
    });

    it('does not call the model at all when the budget refuses', async () => {
        isPlatformAiSpendAllowed.mockResolvedValue(false);

        const out = await readPromotionLeaflet(pdf);

        expect(out).toMatchObject({ read: null, refused: true });
        // The point of gating HERE: a whole PDF is not uploaded to a provider
        // whose bill we have already decided not to pay.
        expect(create).not.toHaveBeenCalled();
        // And nothing is written to the ledger, because nothing was spent.
        expect(recordPlatformAiUsage).not.toHaveBeenCalled();
    });

    it('records usage when the tool output is UNUSABLE', async () => {
        // A tool call whose payload fails the schema. The tokens were spent.
        create.mockResolvedValue(toolResponse({ isLeaflet: 'yes please' }, { input_tokens: 800, output_tokens: 10 }));

        const out = await readPromotionLeaflet(pdf);

        expect(out).toMatchObject({ read: null, refused: false });
        expect(recordPlatformAiUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                job: 'promotion-leaflet-read',
                promptTokens: 800,
                completionTokens: 10,
            }),
        );
    });

    it('records usage when the model returns no tool call at all', async () => {
        create.mockResolvedValue({ usage: { input_tokens: 500, output_tokens: 5 }, content: [{ type: 'text', text: 'no' }] });

        const out = await readPromotionLeaflet(pdf);

        expect(out.read).toBeNull();
        expect(recordPlatformAiUsage).toHaveBeenCalledTimes(1);
    });

    it('sends a PDF on a document block and a photo on an image block', async () => {
        create.mockResolvedValue(
            toolResponse({ isLeaflet: true, companyName: null, offers: [], unreadableOfferCount: 0 }),
        );

        await readPromotionLeaflet(pdf);
        const pdfBlock = create.mock.calls[0][0].messages[0].content[0];
        expect(pdfBlock.type).toBe('document');
        expect(pdfBlock.source.media_type).toBe('application/pdf');

        create.mockClear();
        await readPromotionLeaflet(jpeg);
        const imgBlock = create.mock.calls[0][0].messages[0].content[0];
        expect(imgBlock.type).toBe('image');
        expect(imgBlock.source.media_type).toBe('image/jpeg');
    });

    it('forces the tool, so there is no prose to parse', async () => {
        create.mockResolvedValue(
            toolResponse({ isLeaflet: true, companyName: null, offers: [], unreadableOfferCount: 0 }),
        );
        await readPromotionLeaflet(pdf);

        const body = create.mock.calls[0][0];
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'report_leaflet_offers' });
        // And the system prompt tells it not to repeat a safety claim. Pinned
        // because Reg. 1107/2009 Art 66 prohibits specific claim TYPES, and a
        // leaflet that prints "безопасен" must not have that carried into a
        // field the console then publishes.
        expect(body.system).toMatch(/harmless|non-toxic/i);
    });
});
